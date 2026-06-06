/**
 * `@batak-dev/recording-sdk/network` — network monitoring + adaptive-quality presets.
 */
export { NetworkMonitor } from './networkMonitor';
export type { NetworkQuality, NetworkStats, NetworkMonitorOptions, INetworkMonitor } from './networkMonitor';
export { QUALITY_PRESETS, getQualityPreset, interpolateQuality } from './qualityLevels';
export type { QualityPreset } from './qualityLevels';
export { DefaultQualityStrategy, DEFAULT_QUALITY_THRESHOLDS } from './qualityStrategy';
export type { IQualityStrategy, QualityThresholds } from './qualityStrategy';
