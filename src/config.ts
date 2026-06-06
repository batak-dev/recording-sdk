import type { RecorderCodecConfig } from './types';

export const CODEC_PRESETS: Record<string, RecorderCodecConfig> = {
  vp8_opus: {
    videoEncoderCodec: 'vp8',
    muxerVideoCodec: 'V_VP8',
    audioEncoderCodec: 'opus',
    muxerAudioCodec: 'A_OPUS'
  },
  vp9_opus: {
    videoEncoderCodec: 'vp09.00.10.08',
    muxerVideoCodec: 'V_VP9',
    audioEncoderCodec: 'opus',
    muxerAudioCodec: 'A_OPUS'
  },
  av1_opus: {
    videoEncoderCodec: 'av01.0.08M.08',
    muxerVideoCodec: 'V_AV1',
    audioEncoderCodec: 'opus',
    muxerAudioCodec: 'A_OPUS'
  }
};

export function isRecorderApiSupported(): boolean {
  return (
    typeof MediaStreamTrackProcessor !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}
