import type { NetworkQuality } from './networkMonitor';

export interface QualityPreset {
  name: string;
  videoBitrate: number;
  audioBitrate: number;
  frameRate: number;
  // Background effect settings
  grayscaleBackground: boolean;
  pixelateBackground: boolean;
  pixelationScale: number; // Lower = more pixelation
  // Foreground settings
  keepForegroundSharp: boolean;
}

export const QUALITY_PRESETS: Record<NetworkQuality, QualityPreset> = {
  excellent: {
    name: 'Excellent Quality',
    videoBitrate: 2_500_000, // 2.5 Mbps
    audioBitrate: 128_000,   // 128 Kbps
    frameRate: 30,
    grayscaleBackground: false,
    pixelateBackground: false,
    pixelationScale: 1.0, // No pixelation
    keepForegroundSharp: true
  },
  good: {
    name: 'Good Quality',
    videoBitrate: 1_500_000, // 1.5 Mbps
    audioBitrate: 96_000,    // 96 Kbps
    frameRate: 30,
    grayscaleBackground: true, // Grayscale to save bandwidth
    pixelateBackground: false,
    pixelationScale: 1.0,
    keepForegroundSharp: true
  },
  fair: {
    name: 'Fair Quality',
    videoBitrate: 800_000,   // 800 Kbps
    audioBitrate: 64_000,    // 64 Kbps
    frameRate: 24,
    grayscaleBackground: true,
    pixelateBackground: true, // Pixelate background to save more
    pixelationScale: 0.375,    // 25% scale = ~12.8x7.2 blocks at 1280x720
    keepForegroundSharp: true
  },
  poor: {
    name: 'Poor Quality',
    videoBitrate: 400_000,   // 400 Kbps
    audioBitrate: 32_000,    // 32 Kbps (voice quality)
    frameRate: 15,
    grayscaleBackground: true,
    pixelateBackground: true,
    pixelationScale: 0.175,   // 17.5% scale = ~12.8x7.2 blocks at 1280x720
    keepForegroundSharp: true
  },
  offline: {
    name: 'Offline - Continue Recording',
    videoBitrate: 400_000,   // Keep same as poor
    audioBitrate: 32_000,
    frameRate: 15,
    grayscaleBackground: true,
    pixelateBackground: true,
    pixelationScale: 0.175,
    keepForegroundSharp: true
  }
};

export function getQualityPreset(quality: NetworkQuality): QualityPreset {
  return QUALITY_PRESETS[quality];
}

export function interpolateQuality(
  fromPreset: QualityPreset,
  toPreset: QualityPreset,
  progress: number // 0 to 1
): Partial<QualityPreset> {
  // Smooth transition between quality levels
  return {
    videoBitrate: Math.round(
      fromPreset.videoBitrate + (toPreset.videoBitrate - fromPreset.videoBitrate) * progress
    ),
    audioBitrate: Math.round(
      fromPreset.audioBitrate + (toPreset.audioBitrate - fromPreset.audioBitrate) * progress
    ),
    frameRate: Math.round(
      fromPreset.frameRate + (toPreset.frameRate - fromPreset.frameRate) * progress
    ),
    pixelationScale: 
      fromPreset.pixelationScale + (toPreset.pixelationScale - fromPreset.pixelationScale) * progress
  };
}
