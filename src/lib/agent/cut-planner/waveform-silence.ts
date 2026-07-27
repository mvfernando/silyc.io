/**
 * Waveform-first silence detection.
 *
 * Measures short-window RMS across the PCM signal and returns silence ranges
 * whose RMS stays below `thresholdDb` for at least `minSilenceSec`. Each
 * boundary is snapped to the nearest zero-crossing so downstream FFmpeg cuts
 * fall on clean audio samples (no click, no chopped plosive).
 *
 * Pure function — no DOM, no I/O. Safe to unit-test with synthetic buffers.
 */
import { snapToZeroCrossing } from "./snap";

export type WaveformSilence = {
  start: number;
  end: number;
  /** Mean RMS in dBFS across the silent window (negative number). */
  rmsDb: number;
};

export type DetectSilencesOptions = {
  /** Threshold in dBFS. Anything below is considered silent. Default −40. */
  thresholdDb?: number;
  /** Minimum silent duration to keep (seconds). Default 0.35. */
  minSilenceSec?: number;
  /** Symmetric padding shaved from each detected silence. Default 0.08. */
  paddingSec?: number;
  /** Analysis hop, ms. Default 10. */
  hopMs?: number;
  /** RMS window size, ms. Default 25. */
  windowMs?: number;
  /** Max gap between silent windows to bridge, ms. Default 100. */
  bridgeMs?: number;
  /** Zero-crossing search radius around each boundary, sec. Default 0.008. */
  snapWindowSec?: number;
};

const DB_FLOOR = -100;

function rmsDb(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  const n = to - from;
  if (n <= 0) return DB_FLOOR;
  for (let i = from; i < to; i++) {
    const s = samples[i];
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  if (rms <= 1e-8) return DB_FLOOR;
  return 20 * Math.log10(rms);
}

export function detectSilencesFromWaveform(
  samples: Float32Array,
  sampleRate: number,
  opts: DetectSilencesOptions = {},
): WaveformSilence[] {
  if (!samples || samples.length === 0 || !sampleRate || sampleRate <= 0) {
    return [];
  }
  const thresholdDb = opts.thresholdDb ?? -40;
  const minSilenceSec = opts.minSilenceSec ?? 0.35;
  const paddingSec = opts.paddingSec ?? 0.08;
  const hopMs = opts.hopMs ?? 10;
  const windowMs = opts.windowMs ?? 25;
  const bridgeMs = opts.bridgeMs ?? 100;
  const snapWindowSec = opts.snapWindowSec ?? 0.008;

  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const win = Math.max(hop, Math.round((windowMs / 1000) * sampleRate));
  const totalSec = samples.length / sampleRate;

  // 1. Walk the signal, mark each hop as silent/loud.
  type Frame = { t: number; db: number; silent: boolean };
  const frames: Frame[] = [];
  for (let i = 0; i + win <= samples.length; i += hop) {
    const db = rmsDb(samples, i, i + win);
    frames.push({ t: i / sampleRate, db, silent: db < thresholdDb });
  }
  if (frames.length === 0) return [];

  // 2. Group consecutive silent frames into runs.
  type Run = { start: number; end: number; dbSum: number; dbCount: number };
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const f of frames) {
    if (f.silent) {
      if (!cur) cur = { start: f.t, end: f.t + hop / sampleRate, dbSum: f.db, dbCount: 1 };
      else {
        cur.end = f.t + hop / sampleRate;
        cur.dbSum += f.db;
        cur.dbCount += 1;
      }
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  // 3. Bridge short non-silent gaps between runs.
  const bridgeSec = bridgeMs / 1000;
  const bridged: Run[] = [];
  for (const r of runs) {
    const last = bridged[bridged.length - 1];
    if (last && r.start - last.end <= bridgeSec) {
      last.end = r.end;
      last.dbSum += r.dbSum;
      last.dbCount += r.dbCount;
    } else {
      bridged.push({ ...r });
    }
  }

  // 4. Filter by minimum duration, apply padding (shrink), snap to ZC.
  const out: WaveformSilence[] = [];
  for (const r of bridged) {
    const rawDur = r.end - r.start;
    if (rawDur < minSilenceSec) continue;
    let start = r.start + paddingSec;
    let end = r.end - paddingSec;
    if (end - start < 0.02) continue; // padding ate the whole thing
    start = snapToZeroCrossing(samples, start, sampleRate, snapWindowSec).time;
    end = snapToZeroCrossing(samples, end, sampleRate, snapWindowSec).time;
    if (end - start < 0.02) continue;
    start = Math.max(0, start);
    end = Math.min(totalSec, end);
    out.push({ start, end, rmsDb: r.dbSum / r.dbCount });
  }
  return out;
}