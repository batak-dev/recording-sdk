/**
 * Quality strategy seam.
 *
 * Encapsulates the two decisions that define "network quality":
 *   1. classify(): map an averaged upload throughput (kbps) to a quality level.
 *   2. getPreset(): resolve the encoder + background-effect preset for a level.
 *
 * The default uses the bundled thresholds + presets; a consumer can inject a custom
 * `IQualityStrategy` (or just custom thresholds/presets) to redefine quality entirely.
 * The same strategy instance is shared by the network monitor (classification) and the
 * recorder (preset resolution) so the two never disagree.
 */
import type { NetworkQuality } from './networkMonitor';
import { getQualityPreset, type QualityPreset } from './qualityLevels';

export interface IQualityStrategy {
  /** Map an averaged upload throughput (in kbps) to a quality level (never 'offline'). */
  classify(throughputKbps: number): NetworkQuality;
  /** Resolve the encoder/effect preset for a quality level. */
  getPreset(quality: NetworkQuality): QualityPreset;
}

export interface QualityThresholds {
  /** kbps at/above which quality is 'excellent'. */
  excellent: number;
  /** kbps at/above which quality is 'good'. */
  good: number;
  /** kbps at/above which quality is 'fair' (below this is 'poor'). */
  fair: number;
}

/** Default thresholds (mirror the original NetworkMonitor.determineQuality cutoffs). */
export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  excellent: 3000, // > 3 Mbps
  good: 1500, // 1.5 - 3 Mbps
  fair: 500 // 0.5 - 1.5 Mbps (below -> poor)
};

export class DefaultQualityStrategy implements IQualityStrategy {
  private thresholds: QualityThresholds;
  private presets: (quality: NetworkQuality) => QualityPreset;

  constructor(
    thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS,
    presets: (quality: NetworkQuality) => QualityPreset = getQualityPreset
  ) {
    this.thresholds = thresholds;
    this.presets = presets;
  }

  classify(throughputKbps: number): NetworkQuality {
    if (throughputKbps >= this.thresholds.excellent) return 'excellent';
    if (throughputKbps >= this.thresholds.good) return 'good';
    if (throughputKbps >= this.thresholds.fair) return 'fair';
    return 'poor';
  }

  getPreset(quality: NetworkQuality): QualityPreset {
    return this.presets(quality);
  }
}
