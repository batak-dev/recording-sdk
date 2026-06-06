/**
 * Pure metric computations over a resilience event log.
 *
 * Kept free of any browser/Vue dependency so the same functions can recompute metrics
 * offline from a downloaded report. Definitions follow `resilience-measurement-plan.md`.
 */

import type { NetworkQuality } from '../networkMonitor';
import type {
  ResilienceEvent,
  ResilienceSummary,
  ChunkStatsInput,
  QualityChangeEvent
} from './types';

// RRS weights (Section 4.3) and normalisation constants (Section 4.4).
export const RRS_WEIGHTS = { cdr: 0.5, stability: 0.2, recovery: 0.2, consistency: 0.1 };
export const MAX_ACCEPTABLE_SWITCH_FREQUENCY = 2; // switches/minute
export const MAX_ACCEPTABLE_RECOVERY_S = 30;

// Ordinal mapping for coefficient-of-variation (A3) computation.
const QUALITY_RANK: Record<NetworkQuality, number> = {
  offline: 0,
  poor: 1,
  fair: 2,
  good: 3,
  excellent: 4
};

const OSCILLATION_WINDOW_MS = 30_000;

function byType<T extends ResilienceEvent['type']>(
  events: ResilienceEvent[],
  type: T
): Extract<ResilienceEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<ResilienceEvent, { type: T }>[];
}

/** A3 — quality transitions per minute over the session. */
export function switchRatePerMin(events: ResilienceEvent[], durationMs: number): number {
  const switches = byType(events, 'quality_change').length;
  const minutes = durationMs / 60_000;
  return minutes > 0 ? switches / minutes : 0;
}

/** A3 — coefficient of variation of the quality level held over time (lower = stabler). */
export function qualityCV(events: ResilienceEvent[]): number {
  const ranks = byType(events, 'quality_change').map((e) => QUALITY_RANK[e.to]);
  if (ranks.length < 2) return 0;
  const mean = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  if (mean === 0) return 0;
  const variance = ranks.reduce((a, r) => a + (r - mean) ** 2, 0) / ranks.length;
  return Math.sqrt(variance) / mean;
}

/** A5 — up-switch followed by a down-switch (or vice-versa) within a 30s window. */
export function oscillationCount(events: ResilienceEvent[]): number {
  const changes = byType(events, 'quality_change');
  let count = 0;
  for (let i = 1; i < changes.length; i++) {
    const prev = changes[i - 1];
    const cur = changes[i];
    const prevDir = QUALITY_RANK[cur.to] - QUALITY_RANK[prev.to];
    if (i >= 2) {
      const before = changes[i - 2];
      const firstDir = QUALITY_RANK[prev.to] - QUALITY_RANK[before.to];
      if (firstDir !== 0 && prevDir !== 0 && Math.sign(firstDir) !== Math.sign(prevDir)
        && cur.t - before.t <= OSCILLATION_WINDOW_MS) {
        count++;
      }
    }
  }
  return count;
}

/**
 * A1 — detection latency: for each scenario marker, the gap to the next quality_change.
 * The tester presses "Marker" (or calls window.__resilience.mark) at the moment a network
 * condition is injected; the next quality_change is the system's response.
 */
export function detectionLatencies(events: ResilienceEvent[]): number[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const latencies: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].type !== 'marker') continue;
    const next = sorted.slice(i + 1).find((e) => e.type === 'quality_change') as
      | QualityChangeEvent
      | undefined;
    if (next) latencies.push(next.t - sorted[i].t);
  }
  return latencies;
}

/** B3 — recovery times already emitted by the page when the queue drains after reconnect. */
export function recoveryTimes(events: ResilienceEvent[]): number[] {
  return byType(events, 'recovery_complete').map((e) => e.recoveryTimeMs);
}

/**
 * B2 — retry success rate: of requests that failed/retried at least once, the fraction that
 * eventually completed. Returns null when nothing was retried.
 */
export function retrySuccessRate(events: ResilienceEvent[]): number | null {
  const retriedIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'request_retry' || e.type === 'request_failed') retriedIds.add(e.requestId);
  }
  if (retriedIds.size === 0) return null;
  const completedIds = new Set(byType(events, 'request_completed').map((e) => e.requestId));
  let succeeded = 0;
  retriedIds.forEach((id) => {
    if (completedIds.has(id)) succeeded++;
  });
  return succeeded / retriedIds.size;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function computeSummary(
  events: ResilienceEvent[],
  durationMs: number,
  chunkStats?: ChunkStatsInput,
  consistencyRate?: number | null
): ResilienceSummary {
  const chunksCreated = byType(events, 'chunk_ready').length;
  const chunksUploadedClient = byType(events, 'chunk_uploaded').length;

  const cdr = chunkStats && chunksCreated > 0
    ? clamp01(chunkStats.chunkCount / chunksCreated)
    : null;
  const duplicateRate = chunkStats && chunkStats.chunkCount > 0
    ? clamp01(chunkStats.duplicateCount / chunkStats.chunkCount)
    : null;

  const switchRate = switchRatePerMin(events, durationMs);
  const recovery = recoveryTimes(events);
  const maxRecoveryMs = recovery.length ? Math.max(...recovery) : null;
  const latencies = detectionLatencies(events);
  const consistency = consistencyRate ?? null;

  // Composite RRS (Section 4) — every term is a reward in [0,1].
  let rrs: number | null = null;
  if (cdr !== null) {
    const stabilityScore = Math.max(0, 1 - switchRate / MAX_ACCEPTABLE_SWITCH_FREQUENCY);
    const recoveryScore = maxRecoveryMs === null
      ? 1
      : Math.max(0, 1 - (maxRecoveryMs / 1000) / MAX_ACCEPTABLE_RECOVERY_S);
    const consistencyScore = consistency ?? 1;
    rrs = clamp01(
      RRS_WEIGHTS.cdr * cdr +
      RRS_WEIGHTS.stability * stabilityScore +
      RRS_WEIGHTS.recovery * recoveryScore +
      RRS_WEIGHTS.consistency * consistencyScore
    );
  }

  return {
    durationMs,
    qualitySwitches: byType(events, 'quality_change').length,
    switchRatePerMin: switchRate,
    qualityCV: qualityCV(events),
    oscillationCount: oscillationCount(events),
    detectionLatenciesMs: latencies,
    meanDetectionLatencyMs: latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : null,
    chunksCreated,
    chunksUploadedClient,
    cdr,
    duplicateRate,
    recoveryTimesMs: recovery,
    maxRecoveryMs,
    retrySuccessRate: retrySuccessRate(events),
    consistencyRate: consistency,
    rrs
  };
}
