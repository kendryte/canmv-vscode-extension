import { Request, BackendMessage } from './types';

// ── Wire format (JSON string) ──

export type WireMessage = string;

// ── Codec Interface ──

export interface ProtocolCodec {
  /** Encode a Request to wire format for transmission to the Backend. */
  encodeRequest(req: Request<string>): WireMessage;

  /** Decode a wire message from the Backend into a typed BackendMessage. */
  decodeMessage(raw: WireMessage): BackendMessage;
}

// ── JSON Codec ──

/** JSON-based codec implementing ProtocolCodec. Used by the native backend transport. */
export class JsonCodec implements ProtocolCodec {
  encodeRequest(req: Request<string>): WireMessage {
    return JSON.stringify(req);
  }

  decodeMessage(raw: WireMessage): BackendMessage {
    const parsed = JSON.parse(raw);
    // Validation: must have at least one of result/error/event
    if ('result' in parsed) {
      return { id: parsed.id, result: parsed.result };
    }
    if ('error' in parsed) {
      return { id: parsed.id, error: parsed.error };
    }
    if ('event' in parsed) {
      return { event: parsed.event, params: parsed.params ?? {} };
    }
    throw new Error(`Invalid protocol message: ${raw}`);
  }
}
