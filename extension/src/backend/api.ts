import * as vscode from 'vscode';
import { Request, Response, ProtocolError, Event } from '../protocol/types';

/**
 * Abstract backend communication interface with protocol-level typing.
 *
 * request() replaces the old generic send() — each call is a typed
 * Request/Response pair with proper error channels.
 * Caller (Session) is responsible for timeout enforcement.
 */
export interface BackendApi {
  /** Open connection to the board. */
  open(path: string, baudRate: number): Promise<void>;

  /** Close the connection. */
  close(): Promise<void>;

  /** Whether the backend connection is currently open. */
  isOpen(): boolean;

  /**
   * Send a protocol Request. Returns Response on success or ProtocolError.
   * No built-in timeout — Session layer enforces via Promise.race.
   */
  request(req: Request<string>): Promise<Response | ProtocolError>;

  /** Send a protocol Request without waiting for the backend response. */
  notify?(req: Request<string>): void;

  /** Fires on backend-initiated Events: frameAvailable, boardDisconnected, scriptOutput. */
  onEvent: vscode.Event<Event<string>>;

  /** Fires when connection is unexpectedly lost. */
  onDisconnect: vscode.Event<void>;
}
