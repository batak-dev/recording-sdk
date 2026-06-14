export interface RecorderCodecConfig {
  videoEncoderCodec: string;
  muxerVideoCodec: 'V_VP8' | 'V_VP9' | 'V_AV1';
  audioEncoderCodec: 'opus';
  muxerAudioCodec: 'A_OPUS';
}

export interface VideoConfig {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
}

export interface AudioConfig {
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

export interface RecordingChunk {
  index: number;
  size: number;
  url: string;
  signature?: string; // HMAC-SHA256(salt, "salt:index:path:SHA256(blob)") - includes blob hash for integrity
  blob?: Blob; // Optional blob data
}

export interface RecorderOptions {
  /** Key into the codec preset map. Built-in keys: 'vp8_opus' | 'vp9_opus' | 'av1_opus'.
   *  Open-ended so a consumer can select one of their own `codecs` entries. */
  codecKey?: string;
  /** Extra/override codec presets, merged over the built-ins (consumer-defined codecs). */
  codecs?: Record<string, RecorderCodecConfig>;
  videoConfig?: Partial<VideoConfig>;
  audioConfig?: Partial<AudioConfig>;
  chunkDurationMs?: number;
  enableAdaptiveQuality?: boolean; // Enable automatic quality adjustment
  fixedQuality?: 'excellent' | 'good' | 'fair' | 'poor'; // Quality to use when adaptive is disabled
  networkMonitorInterval?: number; // How often to check network (ms)
  pathIdentifier?: string; // Recording path identifier for signing
  salt?: string; // Decrypted salt for chunk signing
  startChunkIndex?: number; // First chunk index to emit (>1 when resuming an interrupted recording)
  initialQuestionOrder?: number; // 1-based question active for the first emitted chunk (set on resume)
  onChunkReady?: (chunk: RecordingChunk) => void | Promise<void>;
  onError?: (error: Error) => void;
  onQualityChange?: (quality: string, bitrate: number) => void; // Notify when quality changes
  // Resilience instrumentation (optional, used by the measurement system)
  onNetworkSample?: (stats: import('./networkMonitor').NetworkStats) => void; // every monitor measurement
  probeUrl?: string; // base URL for the real upload-throughput probe endpoint
  forceProbe?: boolean; // use the upload probe even when the Network Information API is available
  // Extensibility seams (optional; bundled defaults are used when omitted)
  qualityStrategy?: import('./qualityStrategy').IQualityStrategy; // redefine throughput->quality + presets
  createNetworkMonitor?: (options: {
    onQualityChange: (stats: import('./networkMonitor').NetworkStats) => void;
    onMeasurement?: (stats: import('./networkMonitor').NetworkStats) => void;
    probeUrl?: string;
    forceProbe?: boolean;
    qualityStrategy: import('./qualityStrategy').IQualityStrategy;
  }) => import('./networkMonitor').INetworkMonitor; // plug in a fully custom monitor
}
