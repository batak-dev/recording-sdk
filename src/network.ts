/**
 * `@ta/recording-sdk/network` — network monitoring + adaptive-quality presets.
 */
export { NetworkMonitor } from './networkMonitor';
export type { NetworkQuality, NetworkStats, NetworkMonitorOptions } from './networkMonitor';
export { QUALITY_PRESETS, getQualityPreset, interpolateQuality } from './qualityLevels';
export type { QualityPreset } from './qualityLevels';
