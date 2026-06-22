const ENABLED = process.env.CANMV_PROFILE === '1';

export interface FrameRecord {
  frameId: number;
  ts: Map<string, number>;
}

export interface SegmentStats {
  avg: number;
  p95: number;
  max: number;
}

export interface BatchReport {
  frameRange: string;
  segments: Record<string, SegmentStats>;
}

/**
 * FrameProfiler — collects per-frame high-precision timestamps and computes
 * batch statistics every N frames. Zero-overhead when CANMV_PROFILE !== '1'.
 */
export class FrameProfiler {
  private records: FrameRecord[] = [];
  private pending: FrameRecord | null = null;

  startFrame(frameId: number): void {
    if (!ENABLED) return;
    this.pending = { frameId, ts: new Map() };
  }

  mark(frameId: number, phase: string, ts?: number): void {
    if (!ENABLED) return;
    const record = this.pending ?? this.records.find(r => r.frameId === frameId);
    if (record) {
      record.ts.set(phase, ts ?? performance.now());
    }
  }

  finishFrame(): void {
    if (!ENABLED || !this.pending) return;
    this.records.push(this.pending);
    this.pending = null;
  }

  shouldFlush(): boolean {
    return ENABLED && this.records.length >= 100;
  }

  flush(): BatchReport | null {
    if (!ENABLED || this.records.length === 0) return null;
    const batch = this.records.splice(0);
    const first = batch[0]?.frameId ?? 0;
    const last = batch[batch.length - 1]?.frameId ?? 0;
    const report: BatchReport = { frameRange: `${first}-${last}`, segments: {} };

    const phaseNames = new Set<string>();
    for (const r of batch) { for (const k of r.ts.keys()) { phaseNames.add(k); } }

    for (const phase of phaseNames) {
      const values: number[] = [];
      for (const r of batch) {
        const v = r.ts.get(phase);
        if (v !== undefined) values.push(v);
      }
      if (values.length >= 2) {
        report.segments[phase] = computeStats(values);
      }
    }
    return report;
  }

  /** Compute derived segment stats using absolute timestamps. */
  flushSegments(): BatchReport | null {
    if (!ENABLED || this.records.length === 0) return null;
    const batch = this.records.splice(0);
    const first = batch[0]?.frameId ?? 0;
    const last = batch[batch.length - 1]?.frameId ?? 0;
    const report: BatchReport = { frameRange: `${first}-${last}`, segments: {} };

    // Compute deltas from known phase pairs
    const pairs: [string, string, string][] = [
      ['ts_chunk', 'ts_dispatch', 'VSCode Proc'],
      ['ts_dispatch', 'ts_service', 'Dispatch→Service'],
      ['ts_service', 'ts_webview_msg', 'postMessage'],
    ];
    for (const [start, end, label] of pairs) {
      const deltas: number[] = [];
      for (const r of batch) {
        const a = r.ts.get(start);
        const b = r.ts.get(end);
        if (a !== undefined && b !== undefined) deltas.push(b - a);
      }
      if (deltas.length >= 2) {
        report.segments[label] = computeStats(deltas);
      }
    }

    // JPEG decode + canvas draw from webview
    for (const phase of ['ts_decode_delta', 'ts_draw_delta']) {
      const label = phase === 'ts_decode_delta' ? 'JPEG Decode' : 'Canvas Draw';
      const deltas: number[] = [];
      for (const r of batch) {
        const v = r.ts.get(phase);
        if (v !== undefined) deltas.push(v);
      }
      if (deltas.length >= 2) {
        report.segments[label] = computeStats(deltas);
      }
    }

    return report;
  }
}

function computeStats(values: number[]): SegmentStats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    avg: sorted.reduce((s, v) => s + v, 0) / n,
    p95: sorted[Math.floor(n * 0.95)],
    max: sorted[n - 1],
  };
}
