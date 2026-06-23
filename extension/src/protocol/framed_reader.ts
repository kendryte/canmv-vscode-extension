/**
 * FramedMessageReader — unified transport protocol parser.
 *
 * Parses the backend's framed JSON/binary stdout stream with a single
 * deterministic parser based on the 7-byte header:
 *   [2B magic "CM"][1B type][4B LE payloadLen][payload bytes]
 *
 * States: HEADER → PAYLOAD → dispatch → HEADER
 *         HEADER → DISCARD (oversized) → consume bytes → HEADER
 * Magic sync: skip bytes until 0x43 0x4D found, then read type + length.
 */
import { BackendMessage } from './types';
import { JsonCodec } from './codec';

export const MSG_REQUEST  = 0x01;
export const MSG_RESPONSE = 0x02;
export const MSG_EVENT    = 0x03;
export const MSG_FRAME    = 0x04;

export const MAGIC = Buffer.from([0x43, 0x4D]); // "CM"

const HEADER_SIZE = 7;
const MAX_FRAME_SIZE = 50 * 1024 * 1024; // 50 MB
const FRAME_TIMEOUT_MS = 5000;

type ReaderState = 'HEADER' | 'PAYLOAD' | 'DISCARD';

export interface FramedMessageCallbacks {
  /** Called for REQUEST (0x01), RESPONSE (0x02), EVENT (0x03) messages. */
  onMessage: (msg: BackendMessage, rawId?: number) => void;
  /** Called for FRAME (0x04) messages: frameId extracted from payload header, JPEG data, optional profiling timestamps. */
  onFrame: (frameId: number, data: Uint8Array, chunkTs?: number, dispatchTs?: number) => void;
}

export class FramedMessageReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private state: ReaderState = 'HEADER';
  private currentType = 0;
  private currentPayloadLen = 0;
  private remainingDiscardBytes = 0;     // remaining to skip in DISCARD state
  private frameTimer: ReturnType<typeof setTimeout> | null = null;

  private codec = new JsonCodec();
  private callbacks: FramedMessageCallbacks;

  constructor(callbacks: FramedMessageCallbacks) {
    this.callbacks = callbacks;
  }

  /** Feed a chunk of raw stdout data. May dispatch zero, one, or multiple messages. */
  handleData(chunk: Buffer): void {
    // Record first-chunk timestamp for profiling
    if (process.env.CANMV_PROFILE === '1') {
      (this as any)._chunkTs = performance.now();
    }
    // DISCARD state: consume oversized frame bytes directly, don't accumulate
    if (this.state === 'DISCARD') {
      const consume = Math.min(chunk.length, this.remainingDiscardBytes);
      this.remainingDiscardBytes -= consume;
      if (chunk.length > consume) {
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(consume)]);
      }
      if (this.remainingDiscardBytes <= 0) {
        this.state = 'HEADER';
      }
      while (this.tryConsume()) { /* loop */ }
      return;
    }

    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.tryConsume()) { /* loop */ }
  }

  /** Reset all state — called on disconnect. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.state = 'HEADER';
    this.currentType = 0;
    this.currentPayloadLen = 0;
    this.remainingDiscardBytes = 0;
    this.clearFrameTimer();
  }

  // ── private ──

  private tryConsume(): boolean {
    if (this.state === 'DISCARD') return false; // handleData already consumed
    if (this.state === 'HEADER') return this.tryReadHeader();
    return this.tryReadPayload();
  }

  private tryReadHeader(): boolean {
    if (this.buffer.length < HEADER_SIZE) return false;

    // Validate magic "CM" — jump to the next candidate instead of shifting byte-by-byte.
    if (this.buffer[0] !== MAGIC[0] || this.buffer[1] !== MAGIC[1]) {
      const magicAt = this.buffer.indexOf(MAGIC);
      if (magicAt >= 0) {
        this.buffer = this.buffer.subarray(magicAt);
      } else {
        const keepLast = this.buffer[this.buffer.length - 1] === MAGIC[0];
        this.buffer = keepLast ? this.buffer.subarray(this.buffer.length - 1) : Buffer.alloc(0);
      }
      return this.buffer.length >= HEADER_SIZE;
    }

    this.currentType = this.buffer[2];
    this.currentPayloadLen = this.buffer.readUInt32LE(3);
    this.buffer = this.buffer.subarray(HEADER_SIZE);

    // Max frame size guard: enter DISCARD state to drain oversized payload
    if (this.currentType === MSG_FRAME && this.currentPayloadLen > MAX_FRAME_SIZE) {
      this.remainingDiscardBytes = this.currentPayloadLen;
      this.state = 'DISCARD';
      // Drain what we already have in buffer, then return to HEADER if done
      const skip = Math.min(this.buffer.length, this.remainingDiscardBytes);
      this.remainingDiscardBytes -= skip;
      this.buffer = this.buffer.subarray(skip);
      if (this.remainingDiscardBytes <= 0) {
        this.state = 'HEADER';
      }
      return this.buffer.length >= HEADER_SIZE;
    }

    // Start frame timeout for FRAME type
    if (this.currentType === MSG_FRAME) {
      this.startFrameTimer();
    }

    this.state = 'PAYLOAD';
    return this.buffer.length > 0; // re-check for payload
  }

  private tryReadPayload(): boolean {
    if (this.buffer.length < this.currentPayloadLen) return false;

    const payload = this.buffer.subarray(0, this.currentPayloadLen);
    this.buffer = this.buffer.subarray(this.currentPayloadLen);
    this.state = 'HEADER';

    if (this.currentType === MSG_FRAME) {
      this.clearFrameTimer();
    }

    this.dispatch(this.currentType, payload);
    return this.buffer.length > 0; // re-check for more
  }

  private dispatch(type: number, payload: Buffer): void {
    if (type === MSG_REQUEST || type === MSG_RESPONSE || type === MSG_EVENT) {
      // Text message: UTF-8 decode → JSON parse → BackendMessage
      const raw = payload.toString('utf-8');
      try {
        const msg = this.codec.decodeMessage(raw);
        this.callbacks.onMessage(msg);
      } catch {
        // Skip corrupted messages
      }
    } else if (type === MSG_FRAME) {
      const dispatchTs = performance.now();
      // Payload format: [4B LE frame_id][JPEG]
      if (payload.length < 8) return; // minimum: 4B id + 4B SOI+EOI
      const frameId = payload.readUInt32LE(0);
      const jpeg = payload.subarray(4);
      // Validate SOI and trim any padding after the final EOI marker. Some
      // firmware paths report an aligned frame size, so EOI is not always the
      // last byte in the payload.
      const len = jpeg.length;
      if (len >= 4 && jpeg[0] === 0xFF && jpeg[1] === 0xD8) {
        let end = len;
        for (let i = len - 2; i >= 2; i--) {
          if (jpeg[i] === 0xFF && jpeg[i + 1] === 0xD9) {
            end = i + 2;
            break;
          }
        }
        const frame = end === len ? jpeg : jpeg.subarray(0, end);
        const view = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        this.callbacks.onFrame(frameId, view, (this as any)._chunkTs, dispatchTs);
      }
    }
    // Unknown types: silently skip
  }

  private startFrameTimer(): void {
    this.clearFrameTimer();
    this.frameTimer = setTimeout(() => {
      this.buffer = Buffer.alloc(0);
      this.state = 'HEADER';
      this.currentPayloadLen = 0;
      this.remainingDiscardBytes = 0;
      this.frameTimer = null;
    }, FRAME_TIMEOUT_MS);
  }

  private clearFrameTimer(): void {
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
  }
}
