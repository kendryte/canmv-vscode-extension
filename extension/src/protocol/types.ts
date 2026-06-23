// ── Core Protocol Message Types (LSP-inspired) ──

// ── Request (Service → Backend) ──
export interface Request<M extends string = string, P = unknown> {
  id: number;
  method: M;
  params: P;
}

// ── Response (Backend → Service) ──
export interface Response<R = unknown> {
  id: number;
  result: R;
}

// ── Error (Backend → Service) ──
export interface ProtocolError {
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ── Event / Notification (Backend → Service, no id, no response expected) ──
export interface Event<E extends string = string, P = unknown> {
  event: E;
  params: P;
}

// ── Union type for all messages from Backend ──
export type BackendMessage = Response | ProtocolError | Event<string>;

// ── Type Guards ──

export function isResponse(msg: BackendMessage): msg is Response {
  return 'result' in msg;
}

export function isError(msg: BackendMessage): msg is ProtocolError {
  return 'error' in msg;
}

export function isEvent(msg: BackendMessage): msg is Event<string> {
  return 'event' in msg;
}

export function isFrameEvent(msg: Event<string>): msg is Event<'frameAvailable'> {
  return msg.event === 'frameAvailable';
}

export function isDisconnectEvent(msg: Event<string>): msg is Event<'boardDisconnected'> {
  return msg.event === 'boardDisconnected';
}

// ── Error Codes ──

export const ErrorCodes = {
  // 1000–1999: Connection errors
  CONNECTION: {
    BOARD_NOT_FOUND: 1001,
    TIMEOUT: 1002,
    ALREADY_CONNECTED: 1003,
    NOT_CONNECTED: 1004,
  },
  // 2000–2999: Script execution errors
  SCRIPT: {
    PARSE_ERROR: 2001,
    TIMEOUT: 2002,
  },
  // 3000–3999: Preview / frame errors
  PREVIEW: {
    NOT_CONNECTED: 3001,
    CAMERA_NOT_AVAILABLE: 3002,
  },
  // 9000–9999: Protocol-level errors
  PROTOCOL: {
    INVALID_REQUEST: 9001,
    METHOD_NOT_FOUND: 9002,
    PARSE_ERROR: 9003,
  },
} as const;

// ── Event Param Types ──

export interface FrameAvailableParams {
  streamId: string;
  data: ArrayBuffer | Uint8Array;
}

export interface ScriptOutputParams {
  text: string;
}
