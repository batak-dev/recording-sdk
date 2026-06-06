/**
 * @batak-dev/recording-sdk — main entry.
 *
 * Re-exports the recorder, adaptive-quality, crypto, and signed-chunk primitives.
 * Sub-systems are available via subpath entries:
 *   - `@batak-dev/recording-sdk/queue`      offline queue manager + recording handlers
 *   - `@batak-dev/recording-sdk/storage`    IndexedDB persistence + blob storage
 *   - `@batak-dev/recording-sdk/network`    network monitor + quality presets
 *   - `@batak-dev/recording-sdk/resilience` resilience telemetry collector + metrics
 *   - `@batak-dev/recording-sdk/transport`  transport interface (backend seam)
 *   - `@batak-dev/recording-sdk/auth`       auth-token provider interface
 */

// Core recorder
export { VideoRecorder } from './VideoRecorder';
export { AudioVisualizer } from './audioVisualizer';
export { isRecorderApiSupported, CODEC_PRESETS } from './config';
export * from './types';

// Adaptive quality / network
export { NetworkMonitor } from './networkMonitor';
export type { NetworkQuality, NetworkStats, NetworkMonitorOptions, INetworkMonitor } from './networkMonitor';
export { QUALITY_PRESETS, getQualityPreset, interpolateQuality } from './qualityLevels';
export type { QualityPreset } from './qualityLevels';
export { DefaultQualityStrategy, DEFAULT_QUALITY_THRESHOLDS } from './qualityStrategy';
export type { IQualityStrategy, QualityThresholds } from './qualityStrategy';

// Crypto + signed chunk format
export { generateRSAKeyPair, exportPublicKeyToPEM, decryptSalt, signChunk } from './crypto';
export {
  createSignedChunkBlob,
  parseSignedChunkBlob,
  getSignedChunkFormatSpec
} from './signedChunk';
export type { SignedChunkMetadata } from './signedChunk';

// Extensibility seams (interfaces)
export type { IAuthTokenProvider } from './auth/types';
export type {
  ITransport,
  PresignedUrlResult,
  GetPresignedUrlInput
} from './transport/types';

// Default transport + recording-service API DTOs
export {
  RecordingServiceTransport,
  type RecordingServiceTransportOptions
} from './transport/RecordingServiceTransport';
export type {
  IHttpClient,
  HttpResponse,
  RecordingStatus,
  PrepareRecordingRequest,
  PrepareRecordingResponse,
  GetSaltRequest,
  GetSaltResponse,
  GetPresignedURLRequest,
  GetPresignedURLResponse,
  CompleteRecordingResponse,
  GetRecordingResponse,
  Question,
  ResumeContextResponse,
  ChunkStatsResponse,
  ReviewStatus,
  OceanScores,
  OceanResult,
  CheatTimeRange,
  CheatEvent,
  CheatDetectionResult,
  ReviewSegment,
  VideoReviewResponse,
  RetryProcessingResponse
} from './transport/recordingServiceTypes';
