import { describe, it, expect } from 'vitest';
import {
  DefaultQualityStrategy,
  DEFAULT_QUALITY_THRESHOLDS,
  type IQualityStrategy
} from '../src/qualityStrategy';
import { QUALITY_PRESETS } from '../src/qualityLevels';
import type { NetworkQuality } from '../src/networkMonitor';

describe('DefaultQualityStrategy.classify', () => {
  const s = new DefaultQualityStrategy();

  it('maps throughput to the original threshold bands', () => {
    expect(s.classify(5000)).toBe('excellent'); // >= 3000
    expect(s.classify(3000)).toBe('excellent'); // boundary inclusive
    expect(s.classify(2000)).toBe('good'); // >= 1500
    expect(s.classify(800)).toBe('fair'); // >= 500
    expect(s.classify(100)).toBe('poor'); // below fair
  });

  it('resolves the bundled preset for a level', () => {
    expect(s.getPreset('good')).toEqual(QUALITY_PRESETS.good);
  });

  it('exposes the documented default cutoffs', () => {
    expect(DEFAULT_QUALITY_THRESHOLDS).toEqual({ excellent: 3000, good: 1500, fair: 500 });
  });
});

describe('custom thresholds', () => {
  it('honours injected thresholds', () => {
    const strict = new DefaultQualityStrategy({ excellent: 8000, good: 4000, fair: 2000 });
    expect(strict.classify(5000)).toBe('good'); // would be 'excellent' under defaults
    expect(strict.classify(2500)).toBe('fair');
  });
});

describe('quality strategy seam (adapter swap)', () => {
  it('accepts a fully custom IQualityStrategy', () => {
    // A consumer's strategy that always reports 'excellent' and a fixed preset.
    const fixedPreset = { ...QUALITY_PRESETS.excellent, name: 'Custom Max' };
    const custom: IQualityStrategy = {
      classify: (_kbps: number): NetworkQuality => 'excellent',
      getPreset: () => fixedPreset
    };
    expect(custom.classify(10)).toBe('excellent');
    expect(custom.getPreset('poor').name).toBe('Custom Max');
  });
});
