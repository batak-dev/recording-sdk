/**
 * Collects a time-series of resilience events during a recording session, persists them to
 * IndexedDB (so data survives a tab crash — Scenario S9), and produces a downloadable report.
 *
 * The collector is framework-agnostic: pages feed it data through the recorder/queue callbacks
 * they already own, and call `buildReport()` when they want to download or inspect results.
 */

import type { NetworkStats, NetworkQuality } from '../networkMonitor';
import { getQualityPreset } from '../qualityLevels';
import type { OfflineQueueManager } from '../offlineQueue';
import * as db from '../offlineQueue/db';
import { computeSummary } from './metrics';
import type {
  ResilienceEvent,
  ResilienceReport,
  ResilienceSessionMeta,
  ChunkStatsInput
} from './types';

const FLUSH_DEBOUNCE_MS = 1500;

export class ResilienceCollector {
  private events: ResilienceEvent[] = [];
  private meta: ResilienceSessionMeta;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastQuality: NetworkQuality | null = null;
  private recoveryStartedAt: number | null = null;
  private queueDetach: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  private attachedManager: OfflineQueueManager | null = null;

  constructor(meta: Omit<ResilienceSessionMeta, 'startedAt' | 'userAgent'> & { startedAt?: number }) {
    this.meta = {
      ...meta,
      startedAt: meta.startedAt ?? Date.now(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined
    };
  }

  // ---- recording helpers -------------------------------------------------

  record(event: ResilienceEvent): void {
    this.events.push(event);
    this.scheduleFlush();
  }

  /** Scenario-injection marker used as the reference point for A1 detection latency. */
  mark(label: string): void {
    this.record({ type: 'marker', t: Date.now(), label });
  }

  recordRecordingStart(): void {
    this.record({ type: 'recording_start', t: Date.now() });
  }

  recordRecordingComplete(): void {
    this.record({ type: 'recording_complete', t: Date.now() });
  }

  /**
   * Feed every NetworkMonitor measurement. Emits a `throughput_sample` and, when the detected
   * quality level changes, a `quality_change` (authoritative for A1/A2/A3/A5).
   */
  recordNetworkSample(stats: NetworkStats): void {
    const t = Date.now();
    this.record({
      type: 'throughput_sample',
      t,
      quality: stats.quality,
      throughputKbps: stats.throughputKbps,
      averageThroughputKbps: stats.averageThroughputKbps,
      isOnline: stats.isOnline,
      rtt: stats.rtt
    });

    if (stats.quality !== this.lastQuality) {
      const preset = getQualityPreset(stats.quality);
      this.record({
        type: 'quality_change',
        t,
        to: stats.quality,
        name: preset.name,
        bitrate: preset.videoBitrate,
        throughputKbps: stats.throughputKbps,
        averageThroughputKbps: stats.averageThroughputKbps
      });
      this.lastQuality = stats.quality;
    }
  }

  recordChunkReady(index: number, size: number, quality: NetworkQuality, bitrate: number): void {
    this.record({ type: 'chunk_ready', t: Date.now(), index, size, quality, bitrate });
  }

  recordChunkEnqueued(index: number): void {
    this.record({ type: 'chunk_enqueued', t: Date.now(), index });
  }

  recordNetworkOffline(): void {
    this.record({ type: 'network_offline', t: Date.now() });
  }

  /** Records the online transition and starts the recovery (MTTR) timer. */
  recordNetworkOnline(): void {
    this.record({ type: 'network_online', t: Date.now() });
    this.recoveryStartedAt = Date.now();
  }

  /** Call when the queue has drained (pendingChunks → 0); closes an open recovery window. */
  recordQueueDrained(): void {
    if (this.recoveryStartedAt === null) return;
    this.record({
      type: 'recovery_complete',
      t: Date.now(),
      recoveryTimeMs: Date.now() - this.recoveryStartedAt
    });
    this.recoveryStartedAt = null;
  }

  // ---- queue manager wiring ----------------------------------------------

  attachQueue(manager: OfflineQueueManager): void {
    this.attachedManager = manager;
    const on = (event: string, handler: (...args: any[]) => void) => {
      manager.on(event, handler);
      this.queueDetach.push({ event, handler });
    };

    on('chunkUploaded', (index: number) => {
      this.record({ type: 'chunk_uploaded', t: Date.now(), index });
    });
    on('requestCompleted', (info: { requestId: string; type: string; attempts: number; totalTimeMs: number }) => {
      this.record({
        type: 'request_completed',
        t: Date.now(),
        requestId: info.requestId,
        requestType: info.type,
        attempts: info.attempts,
        totalTimeMs: info.totalTimeMs
      });
    });
    on('requestFailed', (info: { requestId: string; type: string; attempts: number; error?: string }) => {
      this.record({
        type: 'request_failed',
        t: Date.now(),
        requestId: info.requestId,
        requestType: info.type,
        attempts: info.attempts,
        error: info.error
      });
    });
    on('requestRetry', (info: { requestId: string; type: string; attempts: number; delayMs: number }) => {
      this.record({
        type: 'request_retry',
        t: Date.now(),
        requestId: info.requestId,
        requestType: info.type,
        attempts: info.attempts,
        delayMs: info.delayMs
      });
    });
  }

  // ---- persistence -------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /** Persist the full event log + meta to IndexedDB (crash-safe snapshot). */
  async flush(): Promise<void> {
    try {
      await db.saveResilienceLog({
        pathIdentifier: this.meta.pathIdentifier,
        meta: this.meta,
        events: this.events,
        updatedAt: Date.now()
      });
    } catch (err) {
      console.warn('[Resilience] flush failed:', err);
    }
  }

  // ---- reporting ---------------------------------------------------------

  /** Compute B5 queue-state consistency: local COMPLETED status vs MinIO presence. */
  private async computeConsistency(chunkStats?: ChunkStatsInput): Promise<number | null> {
    if (!chunkStats?.presentIndices) return null;
    try {
      const chunks = await db.getChunksByPath(this.meta.pathIdentifier);
      if (chunks.length === 0) return null;
      const present = new Set(chunkStats.presentIndices);
      let matches = 0;
      for (const c of chunks) {
        const inMinio = present.has(c.chunkIndex);
        const localCompleted = c.status === 'COMPLETED';
        if (inMinio === localCompleted) matches++;
      }
      return matches / chunks.length;
    } catch {
      return null;
    }
  }

  async buildReport(chunkStats?: ChunkStatsInput): Promise<ResilienceReport> {
    await this.flush();
    const durationMs = Date.now() - this.meta.startedAt;
    const consistency = await this.computeConsistency(chunkStats);
    const summary = computeSummary(this.events, durationMs, chunkStats, consistency);
    return {
      meta: this.meta,
      summary,
      events: [...this.events],
      chunkStats,
      generatedAt: Date.now()
    };
  }

  getEvents(): ResilienceEvent[] {
    return [...this.events];
  }

  getMeta(): ResilienceSessionMeta {
    return this.meta;
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.attachedManager) {
      for (const { event, handler } of this.queueDetach) {
        this.attachedManager.off(event, handler);
      }
    }
    this.queueDetach = [];
    this.attachedManager = null;
    void this.flush();
  }
}

/** Recover a persisted (possibly crashed) session's report from IndexedDB. */
export async function loadPersistedReport(pathIdentifier: string): Promise<ResilienceReport | null> {
  const log = await db.getResilienceLog(pathIdentifier);
  if (!log) return null;
  const durationMs = (log.updatedAt ?? Date.now()) - log.meta.startedAt;
  const summary = computeSummary(log.events, durationMs);
  return {
    meta: log.meta,
    summary,
    events: log.events,
    generatedAt: Date.now()
  };
}

/** List path identifiers that have a persisted resilience log (for crash-recovery UI). */
export async function listPersistedLogs(): Promise<string[]> {
  return db.listResilienceLogPaths();
}
