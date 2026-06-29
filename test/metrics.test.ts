import { describe, it, expect } from 'vitest';
import {
  switchRatePerMin,
  qualityCV,
  oscillationCount,
  detectionLatencies,
  recoveryTimes,
  retrySuccessRate,
  computeSummary,
  computeConsistencyRate,
  RRS_WEIGHTS
} from '../src/resilience/metrics';
import type { ResilienceEvent } from '../src/resilience/types';

// Small helpers to keep the event fixtures readable.
const qc = (t: number, to: ResilienceEvent['type'] extends never ? never : any) =>
  ({ type: 'quality_change', t, to, name: `${to}`, bitrate: 1 }) as ResilienceEvent;
const marker = (t: number): ResilienceEvent => ({ type: 'marker', t, label: 'm' });
const recovery = (t: number, ms: number): ResilienceEvent =>
  ({ type: 'recovery_complete', t, recoveryTimeMs: ms });

describe('switchRatePerMin', () => {
  it('counts quality_change events per minute', () => {
    const events: ResilienceEvent[] = [qc(0, 'good'), qc(1000, 'fair'), qc(2000, 'poor')];
    // 3 switches over 2 minutes => 1.5/min
    expect(switchRatePerMin(events, 120_000)).toBe(1.5);
  });

  it('returns 0 for zero duration', () => {
    expect(switchRatePerMin([qc(0, 'good')], 0)).toBe(0);
  });
});

describe('qualityCV', () => {
  it('is 0 with fewer than two changes', () => {
    expect(qualityCV([qc(0, 'good')])).toBe(0);
  });

  it('is 0 when quality is constant', () => {
    expect(qualityCV([qc(0, 'good'), qc(1, 'good')])).toBe(0);
  });

  it('is positive when quality varies', () => {
    expect(qualityCV([qc(0, 'excellent'), qc(1, 'poor')])).toBeGreaterThan(0);
  });
});

describe('oscillationCount', () => {
  it('detects an up-then-down reversal within the 30s window', () => {
    // poor -> good (up) -> poor (down) within 30s = one oscillation
    const events = [qc(0, 'poor'), qc(1000, 'good'), qc(2000, 'poor')];
    expect(oscillationCount(events)).toBe(1);
  });

  it('ignores reversals outside the 30s window', () => {
    const events = [qc(0, 'poor'), qc(1000, 'good'), qc(40_000, 'poor')];
    expect(oscillationCount(events)).toBe(0);
  });

  it('does not count a monotonic ramp', () => {
    const events = [qc(0, 'poor'), qc(1000, 'fair'), qc(2000, 'good')];
    expect(oscillationCount(events)).toBe(0);
  });
});

describe('detectionLatencies', () => {
  it('measures the gap from each marker to the next quality_change', () => {
    const events: ResilienceEvent[] = [marker(100), qc(450, 'fair'), marker(1000), qc(1700, 'poor')];
    expect(detectionLatencies(events)).toEqual([350, 700]);
  });

  it('ignores a marker with no following quality_change', () => {
    expect(detectionLatencies([qc(0, 'fair'), marker(500)])).toEqual([]);
  });
});

describe('recoveryTimes', () => {
  it('extracts recovery_complete durations', () => {
    expect(recoveryTimes([recovery(0, 1200), recovery(1, 3400)])).toEqual([1200, 3400]);
  });
});

describe('retrySuccessRate', () => {
  it('is null when nothing was retried', () => {
    expect(retrySuccessRate([qc(0, 'good')])).toBeNull();
  });

  it('is the fraction of retried/failed requests that later completed', () => {
    const events: ResilienceEvent[] = [
      { type: 'request_retry', t: 0, requestId: 'a', requestType: 'chunk', attempts: 1, delayMs: 10 },
      { type: 'request_failed', t: 1, requestId: 'b', requestType: 'chunk', attempts: 1 },
      { type: 'request_completed', t: 2, requestId: 'a', requestType: 'chunk', attempts: 2, totalTimeMs: 5 }
    ];
    // a retried+completed, b failed+never completed => 1/2
    expect(retrySuccessRate(events)).toBe(0.5);
  });
});

describe('computeConsistencyRate', () => {
  it('is null without a snapshot or present indices', () => {
    expect(computeConsistencyRate(undefined, [0, 1])).toBeNull();
    expect(computeConsistencyRate([], [0, 1])).toBeNull();
    expect(computeConsistencyRate([{ chunkIndex: 0, status: 'COMPLETED' }], undefined)).toBeNull();
  });

  it('is 1 when local COMPLETED status agrees with MinIO presence', () => {
    const snapshot = [
      { chunkIndex: 0, status: 'COMPLETED' },
      { chunkIndex: 1, status: 'COMPLETED' }
    ];
    expect(computeConsistencyRate(snapshot, [0, 1])).toBe(1);
  });

  it('counts agreement on both presence and absence', () => {
    const snapshot = [
      { chunkIndex: 0, status: 'COMPLETED' }, // present  -> agree
      { chunkIndex: 1, status: 'PENDING' },   // absent   -> agree
      { chunkIndex: 2, status: 'COMPLETED' }  // absent   -> disagree
    ];
    // present indices: only 0 made it to MinIO
    expect(computeConsistencyRate(snapshot, [0])).toBeCloseTo(2 / 3);
  });
});

describe('computeSummary', () => {
  it('leaves cdr/rrs null without chunk stats', () => {
    const s = computeSummary([qc(0, 'good')], 60_000);
    expect(s.cdr).toBeNull();
    expect(s.rrs).toBeNull();
    expect(s.qualitySwitches).toBe(1);
  });

  it('computes a perfect RRS for a flawless session', () => {
    const events: ResilienceEvent[] = [
      { type: 'chunk_ready', t: 0, index: 1, size: 10, quality: 'good', bitrate: 1 },
      { type: 'chunk_ready', t: 1, index: 2, size: 10, quality: 'good', bitrate: 1 }
    ];
    const s = computeSummary(events, 60_000, {
      chunkCount: 2,
      duplicateCount: 0,
      duplicateIndices: []
    }, 1);
    expect(s.cdr).toBe(1);
    expect(s.duplicateRate).toBe(0);
    // No switches, no recovery delays, consistency 1 => every RRS term is 1.
    expect(s.rrs).toBeCloseTo(
      RRS_WEIGHTS.cdr + RRS_WEIGHTS.stability + RRS_WEIGHTS.recovery + RRS_WEIGHTS.consistency,
      5
    );
    expect(s.rrs).toBeCloseTo(1, 5);
  });

  it('clamps cdr to 1 when more chunks are reported than created', () => {
    const events: ResilienceEvent[] = [
      { type: 'chunk_ready', t: 0, index: 1, size: 10, quality: 'good', bitrate: 1 }
    ];
    const s = computeSummary(events, 60_000, {
      chunkCount: 5,
      duplicateCount: 0,
      duplicateIndices: []
    });
    expect(s.cdr).toBe(1);
  });
});
