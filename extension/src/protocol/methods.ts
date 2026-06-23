import { Request, Response, ProtocolError } from './types';

// ── Method Definition ──

export interface MethodDefinition<
  M extends string,
  P = unknown,
  R = unknown,
  E extends Record<number, string> = Record<number, string>
> {
  method: M;
  params: P;
  result: R;
  errors: E;
}

// ── Method Registry ──

export const Methods = {
  /** Scan host serial devices for supported CanMV boards. */
  detectBoards: {
    method: 'detectBoards' as const,
    params: {} as Record<string, never>,
    result: {} as {
      boards: {
        port: string;
        name: string;
        vid: string;
        pid: string;
        serialNumber?: string;
        description?: string;
      }[];
    },
    errors: {},
  },
  /** Open serial connection to the board. */
  connectBoard: {
    method: 'connectBoard' as const,
    params: {} as { port: string; baudRate?: number },
    result: {} as {
      boardType: string;
      fwVersion: string;
      fwVersionFull?: string;
      archStr?: string;
      boardName?: string;
      memorySize?: string;
      protocolVersion: number;
      capabilities?: Record<string, unknown>;
      port?: string;
      repl?: string;
    },
    errors: {
      1001: 'Board not found',
      1002: 'Connection timeout',
      1003: 'Already connected',
    },
  },
  /** Close serial connection. */
  disconnectBoard: {
    method: 'disconnectBoard' as const,
    params: {} as Record<string, never>,
    result: {} as unknown as void,
    errors: { 1004: 'Not connected' },
  },
  /** Execute a Python script on the board. */
  runScript: {
    method: 'runScript' as const,
    params: {} as { script: string },
    result: {} as { status: 'ok' | 'error'; output?: string; message?: string },
    errors: {
      2001: 'Script parse error',
      2002: 'Script timeout',
    },
  },
  /** Interrupt the running script (Ctrl+C). */
  stopScript: {
    method: 'stopScript' as const,
    params: {} as Record<string, never>,
    result: {} as unknown as void,
    errors: {},
  },
  /** Query the board's USBDBG_SCRIPT_RUNNING state. */
  scriptRunning: {
    method: 'scriptRunning' as const,
    params: {} as Record<string, never>,
    result: {} as { running: boolean },
    errors: {
      2003: 'Board not connected',
    },
  },
  /** Send interactive terminal input to the board REPL. */
  terminalInput: {
    method: 'terminalInput' as const,
    params: {} as { text: string },
    result: {} as { status: 'ok' | 'error'; message?: string },
    errors: {
      2004: 'Board not connected',
      2005: 'REPL input unsupported',
    },
  },
  /** Query virtual IDE touch state on the board. */
  virtualTouchStatus: {
    method: 'virtualTouch.status' as const,
    params: {} as Record<string, never>,
    result: {} as {
      supported: boolean;
      enabled: boolean;
      range?: { w: number; h: number };
      queueDepth?: number;
    },
    errors: {},
  },
  /** Inject a virtual IDE touch event. */
  virtualTouchEvent: {
    method: 'virtualTouch.event' as const,
    params: {} as {
      x: number;
      y: number;
      event: 'down' | 'up' | 'move';
      trackId?: number;
      width?: number;
      sourceWidth: number;
      sourceHeight: number;
    },
    result: {} as { accepted: boolean },
    errors: {
      6001: 'Board not connected',
    },
  },
  /** Start video preview streaming. */
  startPreview: {
    method: 'startPreview' as const,
    params: {} as { fps?: number; resolution?: { w: number; h: number } },
    result: {} as { streamId: string },
    errors: {
      3001: 'Not connected',
      3002: 'Camera not available',
    },
  },
  /** Stop video preview streaming. */
  stopPreview: {
    method: 'stopPreview' as const,
    params: {} as Record<string, never>,
    result: {} as unknown as void,
    errors: {},
  },
  /** List directory contents on the board. */
  ioListDir: {
    method: 'io.listDir' as const,
    params: {} as { path: string },
    result: {} as { entries: { name: string; type: 'file' | 'directory'; size: number; mtime?: number }[] },
    errors: { 4001: 'Path not found', 4002: 'Not a directory', 4008: 'File explorer unsupported' },
  },
  /** Query file metadata on the board. */
  ioQueryFileStat: {
    method: 'io.queryFileStat' as const,
    params: {} as { path: string },
    result: {} as { exists: boolean; type?: 'file' | 'directory'; size: number; mtime?: number },
    errors: {},
  },
  /** Read file content from the board. */
  ioReadFile: {
    method: 'io.readFile' as const,
    params: {} as { path: string },
    result: {} as { data?: number[]; dataBase64?: string },
    errors: { 4001: 'File not found', 4003: 'Read error', 4008: 'File read unsupported' },
  },
  /** Write file content to the board (full overwrite). */
  ioWriteFile: {
    method: 'io.writeFile' as const,
    params: {} as { path: string; data?: number[]; dataBase64?: string },
    result: {} as { success: boolean },
    errors: { 4001: 'File not found', 4003: 'Write error' },
  },
  /** Delete a file on the board. */
  ioDeleteFile: {
    method: 'io.deleteFile' as const,
    params: {} as { path: string },
    result: {} as { success: boolean; errorCode?: number },
    errors: { 4001: 'File not found', 4004: 'Delete error' },
  },
  /** Rename a file or directory on the board. */
  ioRenameFile: {
    method: 'io.renameFile' as const,
    params: {} as { oldPath: string; newPath: string },
    result: {} as { success: boolean; errorCode?: number },
    errors: { 4001: 'File not found', 4005: 'Rename error' },
  },
  /** Create a directory on the board. */
  ioMkdir: {
    method: 'io.mkdir' as const,
    params: {} as { path: string },
    result: {} as { success: boolean; errorCode?: number },
    errors: { 4006: 'Create directory error' },
  },
  /** Remove a directory on the board. */
  ioRmdir: {
    method: 'io.rmdir' as const,
    params: {} as { path: string },
    result: {} as { success: boolean; errorCode?: number },
    errors: { 4007: 'Remove directory error' },
  },
  /** Get board firmware git commit hash (for stub version matching). */
  getFirmwareCommit: {
    method: 'getFirmwareCommit' as const,
    params: {} as Record<string, never>,
    result: {} as { commitId: string; fwVersion: string; archStr: string },
    errors: { 5001: 'Not connected', 5002: 'Commit not available' },
  },
  /** Execute a file already on the K230 (fire-and-forget). */
  ioFileExec: {
    method: 'io.fileExec' as const,
    params: {} as { path: string },
    result: {} as { status: string; message?: string },
    errors: { 5001: 'Not connected', 5002: 'Path error' },
  },
} as const;

// ── Event Names ──

export const Events = {
  frameAvailable: 'frameAvailable' as const,
  boardDisconnected: 'boardDisconnected' as const,
  scriptOutput: 'scriptOutput' as const,
} as const;

// ── Type Helpers ──

export type MethodName = (typeof Methods)[keyof typeof Methods]['method'];

export type EventName = (typeof Events)[keyof typeof Events];

/** Extract params type from a MethodDefinition. */
export type ParamsOf<T> = T extends MethodDefinition<string, infer P, any, any> ? P : never;

/** Extract result type from a MethodDefinition. */
export type ResultOf<T> = T extends MethodDefinition<string, any, infer R, any> ? R : never;

/** Build a typed Request from a MethodDefinition. */
export type RequestOf<T> = T extends MethodDefinition<infer M, infer P, any, any>
  ? Request<M, P>
  : never;

/** Build a typed Response from a MethodDefinition. */
export type ResponseOf<T> = T extends MethodDefinition<string, any, infer R, any>
  ? Response<R>
  : never;

// ── Auto-incrementing Request ID Counter ──

let nextId = 1;

export function resetRequestId(): void {
  nextId = 1;
}

export function nextRequestId(): number {
  return nextId++;
}

/** Create a typed Request with auto-incremented ID. */
export function createRequest<T extends MethodDefinition<string, any, any, any>>(
  def: T,
  params: ParamsOf<T>
): RequestOf<T> {
  return {
    id: nextRequestId(),
    method: def.method,
    params,
  } as RequestOf<T>;
}

/** Build a typed Response for a given Request. */
export function createResponse<R>(id: number, result: R): Response<R> {
  return { id, result };
}

/** Build a typed ProtocolError for a given Request. */
export function createError(
  id: number,
  code: number,
  message: string,
  data?: unknown
): ProtocolError {
  return { id, error: { code, message, data } };
}
