/**
 * Resilience measurement types.
 *
 * A `ResilienceCollector` accumulates a time-series of `ResilienceEvent`s during a
 * recording session and, at the end, produces a `ResilienceReport` (raw events plus a
 * computed `ResilienceSummary`). See `resilience-measurement-plan.md` for metric definitions.
 */

import type { NetworkQuality } from '../networkMonitor';

export type ResilienceEventType =
  | 'recording_start'
  | 'recording_complete'
  | 'quality_change'
  | 'throughput_sample'
  | 'chunk_ready'
  | 'chunk_enqueued'
  | 'chunk_uploaded'
  | 'request_completed'
  | 'request_failed'
  | 'request_retry'
  | 'network_online'
  | 'network_offline'
  | 'recovery_complete'
  | 'marker';

/** Every event carries an absolute wall-clock timestamp `t` (ms since epoch). */
export interface BaseEvent {
  type: ResilienceEventType;
  t: number;
}

export interface RecordingStartEvent extends BaseEvent { type: 'recording_start'; }
export interface RecordingCompleteEvent extends BaseEvent { type: 'recording_complete'; }

export interface QualityChangeEvent extends BaseEvent {
  type: 'quality_change';
  to: NetworkQuality;          // detected level the recorder switched to
  name: string;                // preset display name e.g. "Good Quality"
  bitrate: number;             // video bitrate (bps) of the new preset
  throughputKbps?: number;     // instantaneous sample at switch time
  averageThroughputKbps?: number; // rolling average at switch time
}

export interface ThroughputSampleEvent extends BaseEvent {
  type: 'throughput_sample';
  quality: NetworkQuality;
  throughputKbps: number;
  averageThroughputKbps: number;
  isOnline: boolean;
  rtt?: number;
}

export interface ChunkReadyEvent extends BaseEvent {
  type: 'chunk_ready';
  index: number;
  size: number;                // blob size in bytes
  quality: NetworkQuality;     // recorder quality at creation
  bitrate: number;             // preset video bitrate at creation (bps)
}

export interface ChunkEnqueuedEvent extends BaseEvent { type: 'chunk_enqueued'; index: number; }
export interface ChunkUploadedEvent extends BaseEvent { type: 'chunk_uploaded'; index: number; }

export interface RequestCompletedEvent extends BaseEvent {
  type: 'request_completed';
  requestId: string;
  requestType: string;
  attempts: number;
  totalTimeMs: number;
}

export interface RequestFailedEvent extends BaseEvent {
  type: 'request_failed';
  requestId: string;
  requestType: string;
  attempts: number;
  error?: string;
}

export interface RequestRetryEvent extends BaseEvent {
  type: 'request_retry';
  requestId: string;
  requestType: string;
  attempts: number;
  delayMs: number;
}

export interface NetworkOnlineEvent extends BaseEvent { type: 'network_online'; }
export interface NetworkOfflineEvent extends BaseEvent { type: 'network_offline'; }

export interface RecoveryCompleteEvent extends BaseEvent {
  type: 'recovery_complete';
  recoveryTimeMs: number;
}

export interface MarkerEvent extends BaseEvent { type: 'marker'; label: string; }

export type ResilienceEvent =
  | RecordingStartEvent
  | RecordingCompleteEvent
  | QualityChangeEvent
  | ThroughputSampleEvent
  | ChunkReadyEvent
  | ChunkEnqueuedEvent
  | ChunkUploadedEvent
  | RequestCompletedEvent
  | RequestFailedEvent
  | RequestRetryEvent
  | NetworkOnlineEvent
  | NetworkOfflineEvent
  | RecoveryCompleteEvent
  | MarkerEvent;

/** Chunk statistics fetched from the recording-service after a session (CDR / duplicates). */
export interface ChunkStatsInput {
  chunkCount: number;
  duplicateCount: number;
  duplicateIndices: number[];
  presentIndices?: number[];
}

/**
 * Snapshot of each chunk's local upload status, captured just before a completed recording's
 * transient data is purged. Persisted into the resilience log so B5 queue-state consistency
 * (local COMPLETED vs MinIO presence) can be recomputed post-hoc — the per-chunk records are
 * otherwise gone by download time.
 */
export interface ChunkStatusSnapshot {
  chunkIndex: number;
  status: string; // RequestStatus, kept loose to avoid a queue-layer type dependency
}

/** Computed metric summary. Fields are `null` when the underlying data is unavailable. */
export interface ResilienceSummary {
  // Session
  durationMs: number;
  // Dimension A — adaptive quality
  qualitySwitches: number;
  switchRatePerMin: number;
  qualityCV: number;
  oscillationCount: number;
  detectionLatenciesMs: number[];
  meanDetectionLatencyMs: number | null;
  // Dimension B — upload resilience
  chunksCreated: number;
  chunksUploadedClient: number;
  cdr: number | null;              // [0,1] chunk delivery rate (needs chunkStats)
  duplicateRate: number | null;    // [0,1] (needs chunkStats)
  recoveryTimesMs: number[];
  maxRecoveryMs: number | null;
  retrySuccessRate: number | null; // [0,1]
  consistencyRate: number | null;  // [0,1]
  // Composite
  rrs: number | null;              // [0,1] Recording Resilience Score
}

/** Static description of how the recorder was configured for this session. */
export interface ResilienceSessionMeta {
  pathIdentifier: string;
  referenceId?: string;
  page: 'prototype' | 'live';
  codecKey?: string;
  chunkDurationMs?: number;
  networkMonitorInterval?: number;
  enableAdaptiveQuality?: boolean;
  fixedQuality?: string;
  startedAt: number;
  userAgent?: string;
}

export interface ResilienceReport {
  meta: ResilienceSessionMeta;
  summary: ResilienceSummary;
  events: ResilienceEvent[];
  chunkStats?: ChunkStatsInput;
  /** Local chunk statuses snapshotted at completion; source data for B5 consistency. */
  chunkStatuses?: ChunkStatusSnapshot[];
  generatedAt: number;
}
