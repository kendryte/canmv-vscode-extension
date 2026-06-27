import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonCodec, type WireMessage } from '../protocol/codec';
import { FramedMessageReader, MAGIC, MSG_REQUEST } from '../protocol/framed_reader';
import { Methods, createRequest, resetRequestId } from '../protocol/methods';
import { type BackendMessage, type Event, type ProtocolError, type Request, type Response, isError, isEvent, isResponse } from '../protocol/types';

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type ToolContent = { type: 'text'; text: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
};

type ResourceKind = 'examples' | 'stubs';

type ResourceRoot = {
  revision: string;
  root: string;
  mtimeMs: number;
};

type BoardInfo = {
  boardType: string;
  fwVersion: string;
  fwVersionFull?: string;
  archStr?: string;
  boardName?: string;
  memorySize?: string;
  protocolVersion?: number;
  capabilities?: Record<string, unknown>;
  port?: string;
  repl?: string;
};

type FrameInfo = {
  frameId: number;
  data: Uint8Array;
  receivedAt: number;
  chunkTs?: number;
  dispatchTs?: number;
};

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'canmv-k230';
const DEFAULT_BAUD_RATE = readNumberEnv('CANMV_BAUD_RATE', 12000000);
const REQUEST_TIMEOUT_MS = 15000;
const BOARD_READY_TIMEOUT_MS = 5000;
const DEFAULT_READ_LIMIT = 64 * 1024;
const MAX_READ_LIMIT = 256 * 1024;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_SEARCH_LIMIT = 30;
const MAX_SEARCH_LIMIT = 100;

class CanmvMcpServer {
  private lineBuffer = '';
  private backend = new CanmvBackend();
  private boardInfo: BoardInfo | undefined;
  private boardReady = false;
  private terminalOutput: string[] = [];
  private terminalOutputBytes = 0;
  private readonly terminalOutputLimit = 128 * 1024;
  private latestFrame: FrameInfo | undefined;
  private frameWaiters: Array<(frame: FrameInfo) => void> = [];

  private tools: ToolDefinition[] = [
    {
      name: 'canmv_analyze_capabilities',
      title: 'Analyze CanMV Capabilities',
      description: 'Summarize the MCP server tools, VS Code extension capabilities, and current connected board capabilities.',
      inputSchema: objectSchema({}),
      handler: async () => ({
        extensionCapabilities: [
          'Auto-detect and connect CanMV K230 boards over USB serial.',
          'Run MicroPython scripts and stop running scripts.',
          'Read terminal/script output and send REPL input when firmware supports it.',
          'Browse, read, write, rename, delete, upload, download, and execute files on the board filesystem.',
          'Preview camera/framebuffer images and support threshold editing in the VS Code UI.',
          'Install/use and expose K230 MicroPython stubs and examples for script generation.',
        ],
        mcpCapabilities: this.tools.map(({ name, description }) => ({ name, description })),
        currentBoard: this.boardInfo ? summarizeBoardInfo(this.boardInfo, this.boardReady) : null,
      }),
    },
    {
      name: 'canmv_resource_summary',
      title: 'Summarize CanMV Script Resources',
      description: 'Show cached CanMV examples and MicroPython stubs available for LLM script-generation context.',
      inputSchema: objectSchema({}),
      handler: async () => ({
        examples: summarizeResourceCache('examples'),
        stubs: summarizeResourceCache('stubs'),
      }),
    },
    {
      name: 'canmv_examples_list',
      title: 'List CanMV Examples',
      description: 'List cached CanMV example files. Use this before reading examples relevant to a script request.',
      inputSchema: objectSchema({
        revision: { type: 'string', description: 'Optional examples cache id. Defaults to the newest usable cache.' },
        path: { type: 'string', description: 'Optional relative directory prefix inside the examples cache.' },
        maxResults: { type: 'number', description: 'Maximum files to return. Defaults to 200, maximum 1000.' },
      }),
      handler: async (args) => listResourceFiles('examples', args),
    },
    {
      name: 'canmv_examples_search',
      title: 'Search CanMV Examples',
      description: 'Search cached CanMV example filenames and source text for a plain-text query.',
      inputSchema: objectSchema({
        query: { type: 'string', description: 'Plain-text search query, for example sensor, lcd, kpu, image, threshold, or uart.' },
        revision: { type: 'string', description: 'Optional examples cache id. Defaults to the newest usable cache.' },
        path: { type: 'string', description: 'Optional relative directory prefix inside the examples cache.' },
        maxResults: { type: 'number', description: 'Maximum matching files to return. Defaults to 30, maximum 100.' },
      }, ['query']),
      handler: async (args) => searchResourceFiles('examples', args),
    },
    {
      name: 'canmv_examples_read',
      title: 'Read CanMV Example',
      description: 'Read a cached CanMV example file by relative path.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Relative path from canmv_examples_list or canmv_examples_search.' },
        revision: { type: 'string', description: 'Optional examples cache id. Defaults to the newest usable cache.' },
        maxBytes: { type: 'number', description: 'Maximum bytes to return. Defaults to 65536, maximum 262144.' },
      }, ['path']),
      handler: async (args) => readResourceFile('examples', args),
    },
    {
      name: 'canmv_stubs_list',
      title: 'List CanMV Stubs',
      description: 'List cached CanMV MicroPython stub files. Use this to discover API modules before reading definitions.',
      inputSchema: objectSchema({
        revision: { type: 'string', description: 'Optional firmware revision. Defaults to the newest usable stubs cache.' },
        path: { type: 'string', description: 'Optional relative directory prefix inside the stubs cache.' },
        maxResults: { type: 'number', description: 'Maximum files to return. Defaults to 200, maximum 1000.' },
      }),
      handler: async (args) => listResourceFiles('stubs', args),
    },
    {
      name: 'canmv_stubs_search',
      title: 'Search CanMV Stubs',
      description: 'Search cached CanMV MicroPython stubs for modules, classes, functions, constants, and type signatures.',
      inputSchema: objectSchema({
        query: { type: 'string', description: 'Plain-text search query, for example class Sensor, def snapshot, image.Image, Display, or FPIOA.' },
        revision: { type: 'string', description: 'Optional firmware revision. Defaults to the newest usable stubs cache.' },
        path: { type: 'string', description: 'Optional relative directory prefix inside the stubs cache.' },
        maxResults: { type: 'number', description: 'Maximum matching files to return. Defaults to 30, maximum 100.' },
      }, ['query']),
      handler: async (args) => searchResourceFiles('stubs', args),
    },
    {
      name: 'canmv_stubs_read',
      title: 'Read CanMV Stub',
      description: 'Read a cached CanMV MicroPython .pyi stub file by relative path.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Relative path from canmv_stubs_list or canmv_stubs_search.' },
        revision: { type: 'string', description: 'Optional firmware revision. Defaults to the newest usable stubs cache.' },
        maxBytes: { type: 'number', description: 'Maximum bytes to return. Defaults to 65536, maximum 262144.' },
      }, ['path']),
      handler: async (args) => readResourceFile('stubs', args),
    },
    {
      name: 'canmv_detect_boards',
      title: 'Detect CanMV Boards',
      description: 'Scan host serial devices for supported CanMV boards.',
      inputSchema: objectSchema({}),
      handler: async () => this.requestResult(Methods.detectBoards, {}),
    },
    {
      name: 'canmv_connect_board',
      title: 'Connect CanMV Board',
      description: 'Connect to a CanMV board. If no port is provided, the first detected board is selected.',
      inputSchema: objectSchema({
        port: { type: 'string', description: 'Serial device path, for example /dev/ttyACM0 or COM3.' },
        baudRate: { type: 'number', description: 'Serial baud rate. Defaults to the canmv.baudRate setting or 12000000.' },
      }),
      handler: async (args) => this.connectBoard(optionalString(args.port), optionalNumber(args.baudRate)),
    },
    {
      name: 'canmv_disconnect_board',
      title: 'Disconnect CanMV Board',
      description: 'Disconnect the current CanMV board session.',
      inputSchema: objectSchema({}),
      handler: async () => {
        await this.requestResult(Methods.disconnectBoard, {});
        this.boardInfo = undefined;
        this.boardReady = false;
        return { disconnected: true };
      },
    },
    {
      name: 'canmv_board_info',
      title: 'Get Board Info',
      description: 'Return the cached board information and connection readiness state.',
      inputSchema: objectSchema({}),
      handler: async () => ({
        connected: !!this.boardInfo,
        ready: this.boardReady,
        board: this.boardInfo ? summarizeBoardInfo(this.boardInfo, this.boardReady) : null,
      }),
    },
    {
      name: 'canmv_firmware_info',
      title: 'Get Firmware Info',
      description: 'Read firmware revision information from the connected board when supported.',
      inputSchema: objectSchema({}),
      handler: async () => this.requestResult(Methods.getFirmwareCommit, {}),
    },
    {
      name: 'canmv_board_capabilities',
      title: 'Get Board Capabilities',
      description: 'Return protocol version, capability flags, and local feature availability for the current MCP session.',
      inputSchema: objectSchema({}),
      handler: async () => ({
        connected: !!this.boardInfo,
        ready: this.boardReady,
        protocolVersion: this.boardInfo?.protocolVersion || 0,
        capabilities: this.boardInfo?.capabilities || {},
        mcp: {
          previewFrame: true,
          virtualTouch: true,
          examples: summarizeResourceCache('examples'),
          stubs: summarizeResourceCache('stubs'),
        },
      }),
    },
    {
      name: 'canmv_resource_route_info',
      title: 'Get Resource Route Info',
      description: 'Summarize local cached firmware resource routing data, examples, and stubs revisions.',
      inputSchema: objectSchema({}),
      handler: async () => localResourceRouteInfo(),
    },
    {
      name: 'canmv_run_script',
      title: 'Run Script',
      description: 'Run MicroPython source code on the connected CanMV board.',
      inputSchema: objectSchema({
        script: { type: 'string', description: 'MicroPython source code to execute.' },
      }, ['script']),
      handler: async (args) => this.requestResult(Methods.runScript, { script: requiredString(args.script, 'script') }),
    },
    {
      name: 'canmv_write_and_run_script',
      title: 'Write and Run Script',
      description: 'Write generated MicroPython to the board, execute it, wait briefly, and return captured terminal output.',
      inputSchema: objectSchema({
        script: { type: 'string', description: 'MicroPython source code to write and run.' },
        path: { type: 'string', description: 'Remote path to write. Defaults to /sdcard/mcp_script.py.' },
        waitMs: { type: 'number', description: 'Milliseconds to wait for script output after starting. Defaults to 1000, maximum 10000.' },
        clearOutput: { type: 'boolean', description: 'Clear MCP terminal output before running. Defaults to true.' },
      }, ['script']),
      handler: async (args) => this.writeAndRunScript(args),
    },
    {
      name: 'canmv_stop_script',
      title: 'Stop Script',
      description: 'Interrupt the running script on the connected board.',
      inputSchema: objectSchema({}),
      handler: async () => this.requestResult(Methods.stopScript, {}),
    },
    {
      name: 'canmv_script_running',
      title: 'Check Script State',
      description: 'Query whether the board reports a running script.',
      inputSchema: objectSchema({}),
      handler: async () => this.requestResult(Methods.scriptRunning, {}),
    },
    {
      name: 'canmv_terminal_input',
      title: 'Send Terminal Input',
      description: 'Send text to the board REPL when the firmware supports REPL input.',
      inputSchema: objectSchema({
        text: { type: 'string', description: 'Text to send. Use "\\u0003" for Ctrl-C.' },
      }, ['text']),
      handler: async (args) => this.requestResult(Methods.terminalInput, { text: requiredString(args.text, 'text') }),
    },
    {
      name: 'canmv_terminal_output',
      title: 'Read Terminal Output',
      description: 'Read buffered script/terminal output captured by this MCP session.',
      inputSchema: objectSchema({
        clear: { type: 'boolean', description: 'Clear the buffer after reading it.' },
      }),
      handler: async (args) => {
        const text = this.terminalOutput.join('');
        if (args.clear === true) {
          this.terminalOutput = [];
          this.terminalOutputBytes = 0;
        }
        return { text };
      },
    },
    {
      name: 'canmv_start_preview',
      title: 'Start Preview',
      description: 'Start IDE framebuffer preview streaming from the connected board.',
      inputSchema: objectSchema({
        fps: { type: 'number', description: 'Optional preview FPS request.' },
        width: { type: 'number', description: 'Optional preview width.' },
        height: { type: 'number', description: 'Optional preview height.' },
      }),
      handler: async (args) => {
        this.latestFrame = undefined;
        const width = optionalNumber(args.width);
        const height = optionalNumber(args.height);
        const params: Record<string, unknown> = {};
        const fps = optionalNumber(args.fps);
        if (fps !== undefined) params.fps = fps;
        if (width !== undefined && height !== undefined) params.resolution = { w: width, h: height };
        return this.requestResult(Methods.startPreview, params);
      },
    },
    {
      name: 'canmv_stop_preview',
      title: 'Stop Preview',
      description: 'Stop IDE framebuffer preview streaming.',
      inputSchema: objectSchema({}),
      handler: async () => this.requestResult(Methods.stopPreview, {}),
    },
    {
      name: 'canmv_get_latest_frame',
      title: 'Get Latest Preview Frame',
      description: 'Return the latest preview JPEG frame as base64, optionally waiting for a fresh frame.',
      inputSchema: objectSchema({
        waitMs: { type: 'number', description: 'Milliseconds to wait for a frame if none is available. Defaults to 0, maximum 10000.' },
        fresh: { type: 'boolean', description: 'Wait for a frame newer than the current one.' },
      }),
      handler: async (args) => this.getLatestFrame(args),
    },
    {
      name: 'canmv_virtual_touch_status',
      title: 'Get Virtual Touch Status',
      description: 'Query virtual IDE touch support/state from the connected board.',
      inputSchema: objectSchema({}),
      handler: async () => this.requestResult(Methods.virtualTouchStatus, {}),
    },
    {
      name: 'canmv_virtual_touch_tap',
      title: 'Send Virtual Touch Tap',
      description: 'Send a virtual touch tap to the running preview/script.',
      inputSchema: objectSchema({
        x: { type: 'number', description: 'X coordinate in source frame coordinates.' },
        y: { type: 'number', description: 'Y coordinate in source frame coordinates.' },
        sourceWidth: { type: 'number', description: 'Source frame width.' },
        sourceHeight: { type: 'number', description: 'Source frame height.' },
        trackId: { type: 'number', description: 'Optional touch track id. Defaults to 1.' },
      }, ['x', 'y', 'sourceWidth', 'sourceHeight']),
      handler: async (args) => this.virtualTouchTap(args),
    },
    {
      name: 'canmv_list_dir',
      title: 'List Remote Directory',
      description: 'List files and folders on the connected board.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Remote directory path. Defaults to /.' },
      }),
      handler: async (args) => this.requestResult(Methods.ioListDir, { path: optionalString(args.path) || '/' }),
    },
    {
      name: 'canmv_stat_file',
      title: 'Stat Remote Path',
      description: 'Query metadata for a file or folder on the connected board.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Remote file or folder path.' },
      }, ['path']),
      handler: async (args) => this.requestResult(Methods.ioQueryFileStat, { path: requiredString(args.path, 'path') }),
    },
    {
      name: 'canmv_read_file',
      title: 'Read Remote File',
      description: 'Read a file from the connected board as UTF-8 text or base64.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Remote file path.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Output encoding. Defaults to utf8.' },
      }, ['path']),
      handler: async (args) => this.readFile(requiredString(args.path, 'path'), optionalString(args.encoding) || 'utf8'),
    },
    {
      name: 'canmv_write_file',
      title: 'Write Remote File',
      description: 'Overwrite a file on the connected board with UTF-8 text or base64 data.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Remote file path.' },
        content: { type: 'string', description: 'File content.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Input encoding. Defaults to utf8.' },
      }, ['path', 'content']),
      handler: async (args) => this.writeFile(
        requiredString(args.path, 'path'),
        requiredString(args.content, 'content'),
        optionalString(args.encoding) || 'utf8',
      ),
    },
    {
      name: 'canmv_execute_file',
      title: 'Execute Remote File',
      description: 'Run a Python file already stored on the connected board.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Remote Python file path.' },
      }, ['path']),
      handler: async (args) => this.requestResult(Methods.ioFileExec, { path: requiredString(args.path, 'path') }),
    },
    {
      name: 'canmv_save_main_py',
      title: 'Save main.py',
      description: 'Write MicroPython source to /sdcard/main.py on the connected board.',
      inputSchema: objectSchema({
        script: { type: 'string', description: 'MicroPython source code.' },
      }, ['script']),
      handler: async (args) => this.writeFile('/sdcard/main.py', requiredString(args.script, 'script'), 'utf8'),
    },
    {
      name: 'canmv_save_boot_py',
      title: 'Save boot.py',
      description: 'Write MicroPython source to /sdcard/boot.py on the connected board.',
      inputSchema: objectSchema({
        script: { type: 'string', description: 'MicroPython source code.' },
      }, ['script']),
      handler: async (args) => this.writeFile('/sdcard/boot.py', requiredString(args.script, 'script'), 'utf8'),
    },
    {
      name: 'canmv_mkdir',
      title: 'Create Remote Directory',
      description: 'Create a directory on the connected board.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Remote directory path.' },
      }, ['path']),
      handler: async (args) => this.requestResult(Methods.ioMkdir, { path: requiredString(args.path, 'path') }),
    },
    {
      name: 'canmv_rename',
      title: 'Rename Remote Path',
      description: 'Rename a file or directory on the connected board.',
      inputSchema: objectSchema({
        oldPath: { type: 'string', description: 'Current remote path.' },
        newPath: { type: 'string', description: 'New remote path.' },
      }, ['oldPath', 'newPath']),
      handler: async (args) => this.requestResult(Methods.ioRenameFile, {
        oldPath: requiredString(args.oldPath, 'oldPath'),
        newPath: requiredString(args.newPath, 'newPath'),
      }),
    },
    {
      name: 'canmv_delete_file',
      title: 'Delete Remote File',
      description: 'Delete a file on the connected board.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Remote file path.' },
      }, ['path']),
      handler: async (args) => this.requestResult(Methods.ioDeleteFile, { path: requiredString(args.path, 'path') }),
    },
    {
      name: 'canmv_rmdir',
      title: 'Remove Remote Directory',
      description: 'Remove an empty directory on the connected board.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Remote directory path.' },
      }, ['path']),
      handler: async (args) => this.requestResult(Methods.ioRmdir, { path: requiredString(args.path, 'path') }),
    },
  ];

  constructor() {
    this.backend.onEvent((event) => this.handleBackendEvent(event));
    this.backend.onFrame((frame) => this.handleFrame(frame));
  }

  start(): void {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => this.handleInput(String(chunk)));
    process.stdin.on('end', () => void this.shutdown());
    process.on('SIGINT', () => void this.shutdown(0));
    process.on('SIGTERM', () => void this.shutdown(0));
  }

  private handleInput(chunk: string): void {
    this.lineBuffer += chunk;
    for (;;) {
      const newline = this.lineBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line) as JsonRpcRequest;
      } catch (err) {
        this.sendError(null, -32700, 'Parse error', errorMessage(err));
        continue;
      }
      void this.handleMessage(message);
    }
  }

  private async handleMessage(message: JsonRpcRequest): Promise<void> {
    const id = message.id ?? null;
    const method = message.method;
    if (!method) {
      this.sendError(id, -32600, 'Invalid Request');
      return;
    }

    try {
      switch (method) {
        case 'initialize':
          this.sendResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: SERVER_NAME, version: process.env.CANMV_EXTENSION_VERSION || 'unknown' },
          });
          return;
        case 'ping':
          this.sendResult(id, {});
          return;
        case 'tools/list':
          this.sendResult(id, {
            tools: this.tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
          });
          return;
        case 'tools/call':
          await this.callTool(id, asObject(message.params));
          return;
        case 'resources/list':
          this.sendResult(id, listMcpResources(asObject(message.params)));
          return;
        case 'resources/read':
          this.sendResult(id, readMcpResource(asObject(message.params)));
          return;
        case 'prompts/list':
          this.sendResult(id, listMcpPrompts());
          return;
        case 'prompts/get':
          this.sendResult(id, getMcpPrompt(asObject(message.params)));
          return;
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return;
        default:
          if (id !== null) this.sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      if (id !== null) this.sendError(id, -32603, errorMessage(err));
    }
  }

  private async callTool(id: JsonRpcId, params: Record<string, unknown>): Promise<void> {
    const name = requiredString(params.name, 'name');
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      this.sendError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const args = asObject(params.arguments);
    try {
      const value = await tool.handler(args);
      this.sendResult(id, toolResult(value));
    } catch (err) {
      const result: ToolResult = {
        isError: true,
        content: [{ type: 'text', text: errorMessage(err) }],
      };
      this.sendResult(id, result);
    }
  }

  private async connectBoard(portArg?: string, baudRateArg?: number): Promise<unknown> {
    let port = portArg || process.env.CANMV_SERIAL_PATH || '';
    const baudRate = baudRateArg || DEFAULT_BAUD_RATE;
    if (!port) {
      const detected = await this.requestResult(Methods.detectBoards, {}) as {
        boards?: { port: string; name: string }[];
      };
      const boards = detected.boards || [];
      if (boards.length === 0) {
        throw new Error('No CanMV board detected. Connect the board via USB or pass a serial port.');
      }
      port = boards[0].port;
    }

    this.boardReady = false;
    const info = await this.requestResult(Methods.connectBoard, { port, baudRate }) as BoardInfo;
    this.boardInfo = info;
    if (!info.protocolVersion || info.protocolVersion <= 0) {
      this.boardReady = true;
    } else {
      await this.waitForBoardReady(BOARD_READY_TIMEOUT_MS);
    }
    if (info.repl) {
      this.appendTerminal(info.repl);
    }
    return {
      connected: true,
      ready: this.boardReady,
      board: summarizeBoardInfo(info, this.boardReady),
      repl: info.repl || '',
    };
  }

  private async readFile(remotePath: string, encoding: string): Promise<unknown> {
    const result = await this.requestResult(Methods.ioReadFile, { path: remotePath }) as { data?: number[]; dataBase64?: string };
    const data = typeof result.dataBase64 === 'string'
      ? Buffer.from(result.dataBase64, 'base64')
      : Buffer.from(result.data || []);
    if (encoding === 'base64') {
      return { path: remotePath, encoding: 'base64', content: data.toString('base64'), size: data.byteLength };
    }
    if (encoding !== 'utf8') {
      throw new Error(`Unsupported encoding: ${encoding}`);
    }
    return { path: remotePath, encoding: 'utf8', content: data.toString('utf8'), size: data.byteLength };
  }

  private async writeFile(remotePath: string, content: string, encoding: string): Promise<unknown> {
    let data: Buffer;
    if (encoding === 'base64') {
      data = Buffer.from(content, 'base64');
    } else if (encoding === 'utf8') {
      data = Buffer.from(content, 'utf8');
    } else {
      throw new Error(`Unsupported encoding: ${encoding}`);
    }
    return this.requestResult(Methods.ioWriteFile, { path: remotePath, dataBase64: data.toString('base64') });
  }

  private async writeAndRunScript(args: Record<string, unknown>): Promise<unknown> {
    const script = requiredString(args.script, 'script');
    const remotePath = optionalString(args.path) || '/sdcard/mcp_script.py';
    const waitMs = boundedNumber(args.waitMs, 1000, 0, 10000);
    if (args.clearOutput !== false) {
      this.terminalOutput = [];
      this.terminalOutputBytes = 0;
    }

    const writeResult = await this.writeFile(remotePath, script, 'utf8');
    const execResult = await this.requestResult(Methods.ioFileExec, { path: remotePath });
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    return {
      path: remotePath,
      write: writeResult,
      execute: execResult,
      waitedMs: waitMs,
      output: this.terminalOutput.join(''),
    };
  }

  private async getLatestFrame(args: Record<string, unknown>): Promise<unknown> {
    const waitMs = boundedNumber(args.waitMs, 0, 0, 10000);
    const baselineFrameId = args.fresh === true ? this.latestFrame?.frameId : undefined;
    let frame = this.latestFrame;
    if ((!frame || baselineFrameId !== undefined) && waitMs > 0) {
      frame = await this.waitForFrame(waitMs, baselineFrameId);
    }
    if (!frame) {
      return { available: false };
    }
    return {
      available: true,
      frameId: frame.frameId,
      receivedAt: frame.receivedAt,
      ageMs: Date.now() - frame.receivedAt,
      mimeType: 'image/jpeg',
      size: frame.data.byteLength,
      dataBase64: Buffer.from(frame.data).toString('base64'),
    };
  }

  private async virtualTouchTap(args: Record<string, unknown>): Promise<unknown> {
    const base = {
      x: requiredNumber(args.x, 'x'),
      y: requiredNumber(args.y, 'y'),
      sourceWidth: requiredNumber(args.sourceWidth, 'sourceWidth'),
      sourceHeight: requiredNumber(args.sourceHeight, 'sourceHeight'),
      trackId: boundedNumber(args.trackId, 1, 1, 32),
      width: 1,
    };
    const down = await this.requestResult(Methods.virtualTouchEvent, { ...base, event: 'down' });
    const up = await this.requestResult(Methods.virtualTouchEvent, { ...base, event: 'up' });
    return { down, up };
  }

  private async requestResult(method: { method: string }, params: Record<string, unknown>): Promise<unknown> {
    const result = await this.backend.request(createRequest(method as never, params as never));
    if (isResponse(result)) {
      return result.result;
    }
    throw new Error(result.error.message);
  }

  private handleBackendEvent(event: Event<string>): void {
    if (event.event === 'scriptOutput') {
      this.appendTerminal(String((event.params as { text?: string }).text || ''));
    } else if (event.event === 'boardReady') {
      this.boardReady = true;
    } else if (event.event === 'boardDisconnected') {
      this.boardInfo = undefined;
      this.boardReady = false;
    }
  }

  private handleFrame(frame: FrameInfo): void {
    this.latestFrame = frame;
    const waiters = this.frameWaiters.splice(0);
    for (const waiter of waiters) {
      waiter(frame);
    }
  }

  private appendTerminal(text: string): void {
    if (!text) return;
    this.terminalOutput.push(text);
    this.terminalOutputBytes += Buffer.byteLength(text);
    while (this.terminalOutputBytes > this.terminalOutputLimit && this.terminalOutput.length > 0) {
      const removed = this.terminalOutput.shift() || '';
      this.terminalOutputBytes -= Buffer.byteLength(removed);
    }
  }

  private waitForBoardReady(timeoutMs: number): Promise<void> {
    if (this.boardReady) return Promise.resolve();
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.boardReady || Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  }

  private waitForFrame(timeoutMs: number, baselineFrameId?: number): Promise<FrameInfo | undefined> {
    if (this.latestFrame && (baselineFrameId === undefined || this.latestFrame.frameId !== baselineFrameId)) {
      return Promise.resolve(this.latestFrame);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((waiter) => waiter !== onFrame);
        resolve(undefined);
      }, timeoutMs);
      const onFrame = (frame: FrameInfo) => {
        if (baselineFrameId !== undefined && frame.frameId === baselineFrameId) {
          return;
        }
        clearTimeout(timer);
        resolve(frame);
      };
      this.frameWaiters.push(onFrame);
    });
  }

  private sendResult(id: JsonRpcId, result: unknown): void {
    if (id === null) return;
    this.write({ jsonrpc: '2.0', id, result });
  }

  private sendError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    if (id === null) return;
    this.write({ jsonrpc: '2.0', id, error: { code, message, data } });
  }

  private write(message: unknown): void {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  private async shutdown(code?: number): Promise<void> {
    await this.backend.close();
    if (typeof code === 'number') {
      process.exit(code);
    }
  }
}

class CanmvBackend {
  private child: cp.ChildProcess | undefined;
  private isOpen = false;
  private codec = new JsonCodec();
  private pending = new Map<number, { resolve: (value: Response | ProtocolError) => void; timer: ReturnType<typeof setTimeout> }>();
  private eventListeners: Array<(event: Event<string>) => void> = [];
  private frameListeners: Array<(frame: FrameInfo) => void> = [];
  private reader = new FramedMessageReader({
    onMessage: (message) => this.handleMessage(message),
    onFrame: (frameId, data, chunkTs, dispatchTs) => this.emitFrame({
      frameId,
      data,
      receivedAt: Date.now(),
      chunkTs,
      dispatchTs,
    }),
  });

  onEvent(listener: (event: Event<string>) => void): void {
    this.eventListeners.push(listener);
  }

  onFrame(listener: (frame: FrameInfo) => void): void {
    this.frameListeners.push(listener);
  }

  async request(req: Request<string>): Promise<Response | ProtocolError> {
    await this.open();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        resolve({ id: req.id, error: { code: 1002, message: `Request '${req.method}' timed out after ${REQUEST_TIMEOUT_MS}ms` } });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req.id, { resolve, timer });
      const wire: WireMessage = this.codec.encodeRequest(req);
      const payload = Buffer.from(wire, 'utf8');
      const header = Buffer.alloc(7);
      header[0] = MAGIC[0];
      header[1] = MAGIC[1];
      header[2] = MSG_REQUEST;
      header.writeUInt32LE(payload.length, 3);
      if (!this.child?.stdin?.writable) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        resolve({ id: req.id, error: { code: 1004, message: 'Backend stdin is not writable' } });
        return;
      }
      this.child.stdin.write(header);
      this.child.stdin.write(payload);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await this.requestGracefulDisconnect(child);
    this.child = undefined;
    this.isOpen = false;
    try {
      child.stdin?.end();
    } catch {
      // Ignore shutdown races.
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    this.reader.reset();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ id, error: { code: 1004, message: 'Backend closed' } });
    }
    this.pending.clear();
  }

  private async open(): Promise<void> {
    if (this.isOpen && this.child) return;
    resetRequestId();
    const backend = resolveBackendCommand();
    logStderr(`Starting backend: ${backend.command}${backend.args.length ? ' ' + backend.args.join(' ') : ''}`);
    this.child = cp.spawn(backend.command, backend.args, {
      cwd: backend.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: process.platform !== 'win32',
    });
    this.isOpen = true;
    this.child.stdout?.on('data', (chunk: Buffer) => this.reader.handleData(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) logStderr(text);
    });
    this.child.on('error', (err) => {
      logStderr(`Backend spawn error: ${err.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.isOpen = false;
      if (this.child?.exitCode !== null || this.child?.signalCode !== null) {
        this.child = undefined;
      }
      logStderr(`Backend exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.resolve({ id, error: { code: 1004, message: 'Backend exited' } });
      }
      this.pending.clear();
      this.emitEvent({ event: 'boardDisconnected', params: {} });
    });
  }

  private handleMessage(message: BackendMessage): void {
    if (isResponse(message) || isError(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    if (isEvent(message)) {
      this.emitEvent(message);
    }
  }

  private emitEvent(event: Event<string>): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private emitFrame(frame: FrameInfo): void {
    for (const listener of this.frameListeners) {
      listener(frame);
    }
  }

  private async requestGracefulDisconnect(child: cp.ChildProcess): Promise<void> {
    if (!child.stdin?.writable || this.child !== child) {
      return;
    }
    try {
      const result = await withTimeout(
        this.request(createRequest(Methods.disconnectBoard, {})),
        2000,
      );
      if (isError(result)) {
        logStderr(`Graceful disconnect skipped: ${result.error.message}`);
      }
    } catch {
      logStderr('Graceful disconnect timed out');
    }
  }
}

function resolveBackendCommand(): { command: string; args: string[]; cwd: string } {
  const override = process.env.CANMV_BACKEND_PATH || '';
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`Configured CanMV backend executable not found: ${override}`);
    }
    return { command: override, args: [], cwd: path.dirname(override) };
  }

  const extensionPath = process.env.CANMV_EXTENSION_PATH || path.resolve(__dirname, '..', '..');
  const command = path.join(extensionPath, 'bin', platformTarget(), executableName());
  if (!fs.existsSync(command)) {
    throw new Error(`CanMV backend executable not found for ${platformTarget()}. Set canmv.backendPath or CANMV_BACKEND_PATH.`);
  }
  return { command, args: [], cwd: path.dirname(command) };
}

function platformTarget(): string {
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  if (process.platform === 'win32') return `win32-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  return `${process.platform}-${arch}`;
}

function executableName(): string {
  return process.platform === 'win32' ? 'canmv-backend.exe' : 'canmv-backend';
}

function toolResult(value: unknown): ToolResult {
  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function listMcpResources(_params: Record<string, unknown>): Record<string, unknown> {
  const resources: Array<Record<string, unknown>> = [];
  for (const kind of ['examples', 'stubs'] as ResourceKind[]) {
    const root = findResourceRoots(kind)[0];
    if (!root) continue;
    const files = collectResourceFiles(kind, root.root, 100, root.root);
    for (const file of files) {
      const rel = toResourceRelativePath(root.root, file);
      resources.push({
        uri: resourceUri(kind, root.revision, rel),
        name: `${kind}/${rel}`,
        description: `CanMV ${kind === 'examples' ? 'example' : 'stub'}: ${rel}`,
        mimeType: mimeTypeForResource(file),
      });
    }
  }
  return { resources };
}

function readMcpResource(params: Record<string, unknown>): Record<string, unknown> {
  const uri = requiredString(params.uri, 'uri');
  const parsed = parseResourceUri(uri);
  const result = readResourceFile(parsed.kind, {
    revision: parsed.revision,
    path: parsed.path,
    maxBytes: MAX_READ_LIMIT,
  }) as { content: string };
  return {
    contents: [{
      uri,
      mimeType: mimeTypeForResource(parsed.path),
      text: result.content,
    }],
  };
}

function listMcpPrompts(): Record<string, unknown> {
  return {
    prompts: [
      {
        name: 'canmv_generate_script',
        description: 'Generate a CanMV K230 MicroPython script grounded in local examples and stubs.',
        arguments: [
          { name: 'task', description: 'What the script should do.', required: true },
        ],
      },
      {
        name: 'canmv_debug_script_error',
        description: 'Debug a CanMV script error using terminal output, examples, and stubs.',
        arguments: [
          { name: 'error', description: 'Error text or terminal output.', required: true },
          { name: 'script', description: 'The script being debugged.', required: false },
        ],
      },
      {
        name: 'canmv_iterate_with_preview',
        description: 'Iterate on a camera/vision script using generated code, terminal output, and preview frames.',
        arguments: [
          { name: 'goal', description: 'The desired visual behavior.', required: true },
        ],
      },
    ],
  };
}

function getMcpPrompt(params: Record<string, unknown>): Record<string, unknown> {
  const name = requiredString(params.name, 'name');
  const args = asObject(params.arguments);
  if (name === 'canmv_generate_script') {
    const task = requiredString(args.task, 'task');
    return promptResult(name, [
      'Use `canmv_resource_summary`, then search/read relevant `canmv_examples_*` and `canmv_stubs_*` context before writing code.',
      'Generate a complete CanMV K230 MicroPython script for this task:',
      task,
      'Prefer APIs confirmed by stubs and patterns confirmed by examples. After writing, use `canmv_write_and_run_script` when a board is connected.',
    ].join('\n\n'));
  }
  if (name === 'canmv_debug_script_error') {
    const error = requiredString(args.error, 'error');
    const script = optionalString(args.script) || '';
    return promptResult(name, [
      'Debug this CanMV K230 MicroPython issue. Search/read examples and stubs for the APIs involved, then propose a corrected script or focused fix.',
      `Error/output:\n${error}`,
      script ? `Script:\n${script}` : '',
    ].filter(Boolean).join('\n\n'));
  }
  if (name === 'canmv_iterate_with_preview') {
    const goal = requiredString(args.goal, 'goal');
    return promptResult(name, [
      'Iterate on a CanMV K230 camera or vision script.',
      'Use examples/stubs for code generation, `canmv_write_and_run_script` for execution, `canmv_terminal_output` for errors, and `canmv_start_preview` plus `canmv_get_latest_frame` to inspect visual output when available.',
      `Goal:\n${goal}`,
    ].join('\n\n'));
  }
  throw new Error(`Unknown prompt: ${name}`);
}

function promptResult(name: string, text: string): Record<string, unknown> {
  return {
    description: name,
    messages: [{
      role: 'user',
      content: { type: 'text', text },
    }],
  };
}

function resourceUri(kind: ResourceKind, revision: string, relativePath: string): string {
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
  return `canmv://${kind}/${encodeURIComponent(revision)}/${encodedPath}`;
}

function parseResourceUri(uri: string): { kind: ResourceKind; revision: string; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid resource URI: ${uri}`);
  }
  if (parsed.protocol !== 'canmv:') {
    throw new Error(`Unsupported resource URI scheme: ${parsed.protocol}`);
  }
  const kind = parsed.hostname as ResourceKind;
  if (kind !== 'examples' && kind !== 'stubs') {
    throw new Error(`Unsupported CanMV resource kind: ${kind}`);
  }
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const revision = parts.shift();
  if (!revision || parts.length === 0) {
    throw new Error(`CanMV resource URI must include revision and path: ${uri}`);
  }
  return { kind, revision, path: parts.join('/') };
}

function mimeTypeForResource(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py' || ext === '.pyi') return 'text/x-python';
  if (ext === '.json') return 'application/json';
  if (ext === '.md') return 'text/markdown';
  if (ext === '.yaml' || ext === '.yml') return 'application/yaml';
  return 'text/plain';
}

function localResourceRouteInfo(): Record<string, unknown> {
  const root = path.join(os.homedir(), '.kendryte', 'k230_canmv_resources');
  const latestPath = path.join(root, 'firmware', 'latest');
  let latest = '';
  try {
    latest = fs.readFileSync(latestPath, 'utf8').trim();
  } catch {
    latest = '';
  }

  const manifests: Array<Record<string, unknown>> = [];
  const firmwareDir = path.join(root, 'firmware');
  try {
    for (const entry of fs.readdirSync(firmwareDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(firmwareDir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifests.push({
        revision: entry.name,
        manifestPath,
        firmwareCommit: manifest.firmware_commit || '',
        stubs: manifest.stubs || null,
        examples: manifest.examples || null,
      });
    }
  } catch {
    // Best-effort cache diagnostic.
  }

  return {
    cacheRoot: root,
    latest: latest || null,
    manifests,
    examples: summarizeResourceCache('examples'),
    stubs: summarizeResourceCache('stubs'),
  };
}

function summarizeResourceCache(kind: ResourceKind): Record<string, unknown> {
  const roots = findResourceRoots(kind);
  const active = roots[0];
  return {
    cacheRoot: resourceBaseDir(kind),
    activeRevision: active?.revision || null,
    activePath: active?.root || null,
    revisions: roots.slice(0, 8).map((root) => ({
      revision: root.revision,
      path: root.root,
      mtimeMs: root.mtimeMs,
      fileCount: countResourceFiles(kind, root.root, 5000),
    })),
  };
}

function listResourceFiles(kind: ResourceKind, args: Record<string, unknown>): Record<string, unknown> {
  const selected = selectResourceRoot(kind, optionalString(args.revision));
  const maxResults = boundedNumber(args.maxResults, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const relativePrefix = optionalString(args.path) || '';
  const start = safeResourcePath(selected.root, relativePrefix || '.');
  const stat = fs.statSync(start);
  const files = stat.isFile()
    ? [start]
    : collectResourceFiles(kind, start, maxResults, selected.root);

  return {
    revision: selected.revision,
    root: selected.root,
    path: normalizeResourceRelativePath(relativePrefix || '.'),
    files: files.slice(0, maxResults).map((file) => resourceFileInfo(selected.root, file)),
    truncated: files.length >= maxResults,
  };
}

function readResourceFile(kind: ResourceKind, args: Record<string, unknown>): Record<string, unknown> {
  const selected = selectResourceRoot(kind, optionalString(args.revision));
  const relativePath = requiredString(args.path, 'path');
  const maxBytes = boundedNumber(args.maxBytes, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);
  const file = safeResourcePath(selected.root, relativePath);
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    throw new Error(`Resource path is not a file: ${relativePath}`);
  }
  if (!isTextResourcePath(kind, file)) {
    throw new Error(`Resource file is not a supported text file: ${relativePath}`);
  }

  const data = fs.readFileSync(file);
  const slice = data.subarray(0, Math.min(data.byteLength, maxBytes));
  return {
    revision: selected.revision,
    path: toResourceRelativePath(selected.root, file),
    size: data.byteLength,
    truncated: data.byteLength > slice.byteLength,
    content: slice.toString('utf8'),
  };
}

function searchResourceFiles(kind: ResourceKind, args: Record<string, unknown>): Record<string, unknown> {
  const query = requiredString(args.query, 'query').trim();
  if (!query) {
    throw new Error('Expected non-empty string argument: query');
  }

  const selected = selectResourceRoot(kind, optionalString(args.revision));
  const maxResults = boundedNumber(args.maxResults, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const relativePrefix = optionalString(args.path) || '';
  const start = safeResourcePath(selected.root, relativePrefix || '.');
  const files = fs.statSync(start).isFile()
    ? [start]
    : collectResourceFiles(kind, start, 10000, selected.root);
  const queryLower = query.toLowerCase();
  const matches: Array<Record<string, unknown>> = [];

  for (const file of files) {
    if (matches.length >= maxResults) break;
    const rel = toResourceRelativePath(selected.root, file);
    const pathMatched = rel.toLowerCase().includes(queryLower);
    const stat = fs.statSync(file);
    if (!pathMatched && stat.size > 512 * 1024) {
      continue;
    }
    const text = stat.size <= 512 * 1024 ? fs.readFileSync(file, 'utf8') : '';
    const snippets = text ? findTextSnippets(text, queryLower) : [];
    if (pathMatched || snippets.length > 0) {
      matches.push({
        path: rel,
        size: stat.size,
        pathMatched,
        snippets,
      });
    }
  }

  return {
    revision: selected.revision,
    root: selected.root,
    query,
    matches,
    truncated: matches.length >= maxResults,
  };
}

function findResourceRoots(kind: ResourceKind): ResourceRoot[] {
  const baseDir = resourceBaseDir(kind);
  try {
    if (!fs.existsSync(baseDir)) return [];
    return fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const root = path.join(baseDir, entry.name);
        return {
          revision: entry.name,
          root,
          mtimeMs: fs.statSync(root).mtimeMs,
        };
      })
      .filter((root) => isUsableResourceRoot(kind, root.root))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    return [];
  }
}

function selectResourceRoot(kind: ResourceKind, revision?: string): ResourceRoot {
  const baseDir = resourceBaseDir(kind);
  if (revision) {
    const root = safeResourcePath(baseDir, revision);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory() || !isUsableResourceRoot(kind, root)) {
      throw new Error(`No cached CanMV ${kind} resource found for revision/id: ${revision}`);
    }
    return { revision, root, mtimeMs: fs.statSync(root).mtimeMs };
  }

  const active = findResourceRoots(kind)[0];
  if (!active) {
    throw new Error(`No cached CanMV ${kind} resources found under ${baseDir}. Connect a board or refresh examples/stubs first.`);
  }
  return active;
}

function resourceBaseDir(kind: ResourceKind): string {
  return path.join(os.homedir(), '.kendryte', kind === 'examples' ? 'k230_canmv_examples' : 'k230_canmv_stubs');
}

function isUsableResourceRoot(kind: ResourceKind, root: string): boolean {
  try {
    if (kind === 'examples') {
      return fs.readdirSync(root, { withFileTypes: true })
        .some((entry) => entry.isDirectory() && (entry.name === 'examples' || entry.name === 'models'));
    }
    return collectResourceFiles(kind, root, 1, root).length > 0;
  } catch {
    return false;
  }
}

function collectResourceFiles(kind: ResourceKind, start: string, maxResults: number, root: string): string[] {
  const files: string[] = [];
  const pending = [start];
  while (pending.length > 0 && files.length < maxResults) {
    const current = pending.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (isTextResourcePath(kind, current)) {
        files.push(current);
      }
      continue;
    }
    if (!stat.isDirectory()) continue;

    const children = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (let index = children.length - 1; index >= 0; index--) {
      const child = path.join(current, children[index].name);
      const relative = path.relative(root, child);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        pending.push(child);
      }
    }
  }
  return files;
}

function countResourceFiles(kind: ResourceKind, root: string, maxScan: number): number {
  return collectResourceFiles(kind, root, maxScan, root).length;
}

function resourceFileInfo(root: string, file: string): Record<string, unknown> {
  const stat = fs.statSync(file);
  return {
    path: toResourceRelativePath(root, file),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function safeResourcePath(root: string, relativePath: string): string {
  const normalized = normalizeResourceRelativePath(relativePath);
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Resource path escapes cache root: ${relativePath}`);
  }
  return target;
}

function normalizeResourceRelativePath(value: string): string {
  const normalized = path.normalize(value || '.').replace(/^[/\\]+/, '');
  return normalized === '' ? '.' : normalized;
}

function toResourceRelativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function isTextResourcePath(kind: ResourceKind, file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  if (kind === 'stubs') {
    return ext === '.pyi' || ext === '.py' || ext === '.md' || ext === '.txt';
  }
  return ['.py', '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.toml', '.ini', '.cfg'].includes(ext);
}

function findTextSnippets(text: string, queryLower: string): Array<Record<string, unknown>> {
  const snippets: Array<Record<string, unknown>> = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && snippets.length < 3; index++) {
    const line = lines[index];
    const foundAt = line.toLowerCase().indexOf(queryLower);
    if (foundAt < 0) continue;
    snippets.push({
      line: index + 1,
      text: trimSnippet(line, foundAt),
    });
  }
  return snippets;
}

function trimSnippet(line: string, foundAt: number): string {
  const start = Math.max(0, foundAt - 80);
  const end = Math.min(line.length, foundAt + 160);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < line.length ? '...' : '';
  return prefix + line.slice(start, end).trim() + suffix;
}

function summarizeBoardInfo(info: BoardInfo, ready: boolean): Record<string, unknown> {
  return {
    boardType: info.boardType,
    boardName: info.boardName,
    fwVersion: info.fwVersion,
    fwVersionFull: info.fwVersionFull,
    archStr: info.archStr,
    memorySize: info.memorySize,
    protocolVersion: info.protocolVersion,
    capabilities: info.capabilities || {},
    port: info.port,
    ready,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string argument: ${name}`);
  }
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected finite number argument: ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = optionalNumber(value);
  if (n === undefined) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function readNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function logStderr(message: string): void {
  process.stderr.write(`[CanMV MCP] ${message}\n`);
}

new CanmvMcpServer().start();
