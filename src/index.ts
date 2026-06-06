/**
 * @ta/recording-sdk — main entry.
 *
 * Re-exports the recorder, adaptive-quality, crypto, and signed-chunk primitives.
 * Sub-systems are available via subpath entries:
 *   - `@ta/recording-sdk/queue`      offline queue manager + recording handlers
 *   - `@ta/recording-sdk/storage`    IndexedDB persistence + blob storage
 *   - `@ta/recording-sdk/network`    network monitor + quality presets
 *   - `@ta/recording-sdk/resilience` resilience telemetry collector + metrics
 *   - `@ta/recording-sdk/transport`  transport interface (backend seam)
 *   - `@ta/recording-sdk/auth`       auth-token provider interface
 */

// Core recorder
export { VideoRecorder } from './VideoRecorder';
export { AudioVisualizer } from './audioVisualizer';
export { isRecorderApiSupported, CODEC_PRESETS } from './config';
export * from './types';

// Adaptive quality / network
export { NetworkMonitor } from './networkMonitor';
export type { NetworkQuality, NetworkStats, NetworkMonitorOptions } from './networkMonitor';
export { QUALITY_PRESETS, getQualityPreset, interpolateQuality } from './qualityLevels';
export type { QualityPreset } from './qualityLevels';

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
