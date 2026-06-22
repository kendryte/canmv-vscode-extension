import * as vscode from 'vscode';

// ── USBDBG Opcode Constants ──

/**
 * USBDBG command opcodes — CORRECTED from CanMV IDE Qt Creator source.
 * Source: canmv_ide_qt_creator/src/plugins/openmv/openmvpluginserialport.h
 * Verified: K230 hardware test 2026-06-12 (6/6 passed, FW v0.4.0)
 *
 * Packet format: [0x30] [opcode:1B] [responseLen:4B LE] [payload...]
 *
 * Host backends SHALL use these identical constants.
 */
export const CMD_PREFIX = 0x30;

export const USBDBG_CMD = {
  /** Execute uploaded Python script */
  SCRIPT_EXEC: 0x05,
  /** Stop running script */
  SCRIPT_STOP: 0x06,
  /** Write sensor attribute */
  ATTR_WRITE: 0x0B,
  /** System reset */
  SYS_RESET: 0x0C,
  /** Enable frame buffer (returns 0 on success) */
  FB_ENABLE: 0x0D,
  /** Get firmware version — 3× deserializeLong: (major, minor, patch) */
  FW_VERSION: 0x80,
  /** Query frame dimensions — 3× deserializeLong: (w, h, bpp) */
  FRAME_SIZE: 0x81,
  /** Read one JPEG frame */
  FRAME_DUMP: 0x82,
  /** Get architecture string (up to 64B ASCII) */
  ARCH_STR: 0x83,
  /** Learn MTU size */
  LEARN_MTU: 0x84,
  /** Query if script is running — deserializeLong (0=no, non-zero=yes) */
  SCRIPT_RUNNING: 0x87,
  /** Read sensor attribute (v1) — deserializeByte */
  ATTR_READ: 0x8A,
  /** Read sensor attribute (v2) */
  ATTR_READ_2: 0xCA,
  /** Get TX buffer readable byte count — deserializeLong */
  TX_BUF_LEN: 0x8E,
  /** Read TX buffer data */
  TX_BUF: 0x8F,
} as const;

export type UsbDbgOpcode = (typeof USBDBG_CMD)[keyof typeof USBDBG_CMD];

/**
 * Response lengths from IDE source (openmvpluginserialport.h).
 * The responseLen field in the command packet tells the board
 * exactly how many response bytes to return.
 */
export const RESPONSE_LEN: Record<number, number> = {
  [USBDBG_CMD.FW_VERSION]: 12,       // 3× deserializeLong
  [USBDBG_CMD.FRAME_SIZE]: 12,       // 3× deserializeLong
  [USBDBG_CMD.ARCH_STR]: 64,         // ASCII string
  [USBDBG_CMD.SCRIPT_RUNNING]: 4,    // deserializeLong
  [USBDBG_CMD.ATTR_READ]: 1,         // deserializeByte
  [USBDBG_CMD.TX_BUF_LEN]: 4,        // deserializeLong
  [USBDBG_CMD.LEARN_MTU]: 4,         // deserializeLong
  [USBDBG_CMD.FB_ENABLE]: 4,         // deserializeLong
  [USBDBG_CMD.SYS_RESET]: 4,         // deserializeLong
};

// ── BoardProtocol Interface ──

/**
 * BoardProtocol abstracts USBDBG board communication.
 *
 * Architecture:
 *   Service → Session → BackendApi → BoardProtocol → USB CDC
 *
 * The IDE does NOT use a separate QUERY_STATUS command.
 * The 0x30 prefix byte serves as the IDE mode activation.
 * Response length is embedded in every command packet.
 *
 * BoardProtocol does NOT manage connection state or sessions —
 * those are Session layer responsibilities.
 */
export interface BoardProtocol {
  /**
   * Send a USBDBG command and receive response bytes.
   * Packet: [0x30] [opcode] [responseLen:4B LE] [payload...]
   * @param opcode  USBDBG command opcode
   * @param payload Optional payload bytes
   * @returns Response bytes (length per RESPONSE_LEN mapping)
   */
  sendCommand(opcode: UsbDbgOpcode, payload?: Uint8Array): Promise<Uint8Array>;

  /**
   * Get firmware version as a git describe string.
   * Sends FW_VERSION_FULL(0x91), response is 128B null-terminated string like 'v1.0-45-g<full-hash>'.
   */
  fwVersion(): Promise<string>;

  /**
   * Query frame dimensions as (width, height, bpp).
   * Sends FRAME_SIZE(0x81), response is 3× deserializeLong.
   */
  frameSize(): Promise<{ w: number; h: number; bpp: number }>;

  /**
   * Get TX buffer available byte count.
   * Sends TX_BUF_LEN(0x8E), response is deserializeLong.
   */
  txBufLen(): Promise<number>;

  /**
   * Check if a script is currently running.
   * Sends SCRIPT_RUNNING(0x87), response is deserializeLong.
   */
  isScriptRunning(): Promise<boolean>;

  /**
   * Enable frame buffer. Returns true on success.
   * Sends FB_ENABLE(0x0D), response is deserializeLong.
   */
  enableFrameBuffer(): Promise<boolean>;

  /** Execute a MicroPython script via two-phase SCRIPT_EXEC(0x05). */
  scriptExec(scriptBytes: Uint8Array): Promise<void>;

  /** Stop the running script via SCRIPT_STOP(0x06). */
  scriptStop(): Promise<void>;

  /** Read N bytes from TX buffer via TX_BUF(0x8F). */
  readTxBuf(length: number): Promise<Uint8Array>;

  /** Fires when a complete video frame is received. */
  onFrame: vscode.Event<Uint8Array>;

  /** Fires when the USB connection is unexpectedly lost. */
  onDisconnect: vscode.Event<void>;
}
