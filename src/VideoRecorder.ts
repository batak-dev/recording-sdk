import { ImageSegmenter } from '@mediapipe/tasks-vision';
import { ChunkMuxer } from './muxer';
import { initializeSegmenter, applyBackgroundEffect } from './segmentation';
import { CODEC_PRESETS } from './config';
import { NetworkMonitor, type NetworkStats, type NetworkQuality, type INetworkMonitor } from './networkMonitor';
import { DefaultQualityStrategy, type IQualityStrategy } from './qualityStrategy';
import { type QualityPreset } from './qualityLevels';
import type { RecorderOptions, RecordingChunk, VideoConfig, AudioConfig, RecorderCodecConfig } from './types';

const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  width: 1280,
  height: 720,
  frameRate: 30,
  bitrate: 2_500_000
};

const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  sampleRate: 48000,
  numberOfChannels: 1,
  bitrate: 128_000
};

export class VideoRecorder {
  private stream: MediaStream | null = null;
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private segmenter: ImageSegmenter | null = null;
  private muxer: ChunkMuxer | null = null;
  private isRecording = false;
  private videoConfig: VideoConfig;
  private audioConfig: AudioConfig;
  private chunkDurationMs: number;
  private onChunkReady?: (chunk: RecordingChunk) => void;
  private onError?: (error: Error) => void;
  private onQualityChange?: (quality: string, bitrate: number) => void;
  private codec: RecorderCodecConfig;
  private networkMonitor: INetworkMonitor | null = null;
  private qualityStrategy: IQualityStrategy;
  private currentQuality: NetworkQuality = 'excellent';
  private currentQualityPreset: QualityPreset;
  private enableAdaptiveQuality: boolean;
  private pathIdentifier?: string;
  private salt?: string;
  private startChunkIndex: number = 1;
  private currentQuestionOrder: number = 1;
  private pendingQuestionOrder: number | null = null;
  private forceRotate: boolean = false;
  private qualityJustChanged: boolean = false;
  private keyframeIntervalSeconds: number = 2; // Target keyframe interval
  private onNetworkSample?: (stats: NetworkStats) => void;
  private probeUrl?: string;
  private forceProbe: boolean;
  private networkMonitorInterval: number;

  constructor(options: RecorderOptions = {}) {
    this.videoConfig = { ...DEFAULT_VIDEO_CONFIG, ...options.videoConfig };
    this.audioConfig = { ...DEFAULT_AUDIO_CONFIG, ...options.audioConfig };
    this.chunkDurationMs = options.chunkDurationMs ?? 10000;
    this.onChunkReady = options.onChunkReady;
    this.onError = options.onError;
    this.onQualityChange = options.onQualityChange;
    this.enableAdaptiveQuality = options.enableAdaptiveQuality ?? false;
    this.pathIdentifier = options.pathIdentifier;
    this.salt = options.salt;
    this.startChunkIndex = options.startChunkIndex && options.startChunkIndex >= 1 ? options.startChunkIndex : 1;
    this.currentQuestionOrder = options.initialQuestionOrder && options.initialQuestionOrder >= 1 ? options.initialQuestionOrder : 1;
    this.onNetworkSample = options.onNetworkSample;
    this.probeUrl = options.probeUrl;
    this.forceProbe = options.forceProbe ?? false;
    this.networkMonitorInterval = options.networkMonitorInterval ?? 3000;

    const codecKey = options.codecKey ?? 'av1_opus';
    this.codec = CODEC_PRESETS[codecKey];

    // Quality strategy: maps throughput->quality and quality->preset. Injectable so a
    // consumer can redefine "network quality" (custom thresholds and/or presets).
    this.qualityStrategy = options.qualityStrategy ?? new DefaultQualityStrategy();

    // Set initial quality based on adaptive mode
    if (this.enableAdaptiveQuality) {
      this.currentQuality = 'excellent';
      this.currentQualityPreset = this.qualityStrategy.getPreset('excellent');
    } else {
      const fixedQuality = options.fixedQuality ?? 'excellent';
      this.currentQuality = fixedQuality;
      this.currentQualityPreset = this.qualityStrategy.getPreset(fixedQuality);
    }
    
    this.muxer = new ChunkMuxer(
      this.codec,
      this.videoConfig.width,
      this.videoConfig.height,
      this.onChunkReady,
      this.pathIdentifier,
      this.salt
    );
    this.muxer.setQuestionOrder(this.currentQuestionOrder);
    
    // Initialize network monitor if adaptive quality is enabled. The monitor can be
    // fully replaced via `createNetworkMonitor`; otherwise the bundled NetworkMonitor is
    // used. Either way it shares this recorder's quality strategy.
    if (this.enableAdaptiveQuality) {
      const monitorOptions = {
        onQualityChange: (stats: NetworkStats) => this.handleQualityChange(stats),
        onMeasurement: this.onNetworkSample,
        probeUrl: this.probeUrl,
        forceProbe: this.forceProbe,
        qualityStrategy: this.qualityStrategy
      };
      this.networkMonitor = options.createNetworkMonitor
        ? options.createNetworkMonitor(monitorOptions)
        : new NetworkMonitor(monitorOptions.onQualityChange, {
            onMeasurement: monitorOptions.onMeasurement,
            probeUrl: monitorOptions.probeUrl,
            forceProbe: monitorOptions.forceProbe,
            qualityStrategy: monitorOptions.qualityStrategy
          });
    }
  }
  
  setSalt(salt: string) {
    this.salt = salt;
    this.muxer?.setSalt(salt);
  }
  
  setPathIdentifier(pathIdentifier: string) {
    this.pathIdentifier = pathIdentifier;
    this.muxer?.setPathIdentifier(pathIdentifier);
  }

  // Mark the 1-based question now being presented. Forces a clean chunk boundary so
  // no chunk straddles two questions: the in-flight chunk is flushed with the current
  // (previous) question's order, then subsequent chunks carry the new order. Server-side
  // segmentation groups chunks by this order (one question = one segment).
  setQuestionOrder(order: number) {
    const next = order >= 1 ? order : 1;
    this.currentQuestionOrder = next;

    if (!this.isRecording) {
      // No active capture loop yet (e.g. presenting the first question before/at start):
      // apply directly so the first emitted chunk is already tagged.
      this.muxer?.setQuestionOrder(next);
      return;
    }

    // Defer to the capture loop so the previous chunk finalizes with the old order first.
    this.pendingQuestionOrder = next;
    this.forceRotate = true;
  }

  /**
   * Pre-initialize the MediaPipe segmenter (downloads WASM + tflite model, GPU init)
   * ahead of start(), so the 2-4s of heavy work can overlap a countdown/spinner
   * instead of freezing the UI when recording begins. Safe to call before start()
   * and idempotent — a no-op once a segmenter is already prepared.
   */
  async prepare(): Promise<void> {
    if (!this.segmenter) {
      this.segmenter = await initializeSegmenter();
    }
  }

  async start(): Promise<MediaStream> {
    if (this.isRecording) {
      throw new Error('Recording already in progress');
    }

    try {
      // 1. Initialize MediaPipe Segmenter (reuse one prepared via prepare(), if any)
      if (!this.segmenter) {
        this.segmenter = await initializeSegmenter();
      }

      // 2. Access Camera
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          width: this.videoConfig.width, 
          height: this.videoConfig.height, 
          frameRate: this.videoConfig.frameRate 
        },
        audio: { 
          sampleRate: this.audioConfig.sampleRate, 
          channelCount: this.audioConfig.numberOfChannels 
        }
      });

      const videoTrack = this.stream.getVideoTracks()[0];
      const audioTrack = this.stream.getAudioTracks()[0];

      this.isRecording = true;
      this.muxer?.reset(this.startChunkIndex);
      this.muxer?.createNewSegment();

      // 3. Initialize Encoders
      this.initializeVideoEncoder();
      this.initializeAudioEncoder();

      // 4. Start Processing Pipelines
      const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
      const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
      const videoReader = videoProcessor.readable.getReader();
      const audioReader = audioProcessor.readable.getReader();

      this.processVideoFrames(videoReader);
      this.processAudioFrames(audioReader);
      
      // Start network monitoring if enabled
      if (this.networkMonitor) {
        await this.networkMonitor.start(this.networkMonitorInterval);
      }

      return this.stream;
    } catch (error) {
      await this.stop();
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.onError) {
        this.onError(err);
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.isRecording = false;
    
    // Stop network monitoring
    if (this.networkMonitor) {
      this.networkMonitor.stop();
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (this.videoEncoder) {
      await this.videoEncoder.flush();
      this.videoEncoder.close();
      this.videoEncoder = null;
    }

    if (this.audioEncoder) {
      await this.audioEncoder.flush();
      this.audioEncoder.close();
      this.audioEncoder = null;
    }

    await this.muxer?.finalizeSegment();

    if (this.segmenter) {
      this.segmenter.close();
      this.segmenter = null;
    }
  }

  getIsRecording(): boolean {
    return this.isRecording;
  }

  private initializeVideoEncoder() {
    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        this.muxer?.addVideoChunk(chunk, meta);
      },
      error: (e) => {
        console.error('Video Encoder Error:', e);
        if (this.onError) {
          this.onError(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

    this.configureVideoEncoder();
  }
  
  private configureVideoEncoder() {
    if (!this.videoEncoder) return;
    
    // Always use quality preset values
    const bitrate = this.currentQualityPreset.videoBitrate;
    const framerate = this.currentQualityPreset.frameRate;

    this.videoEncoder.configure({
      codec: this.codec.videoEncoderCodec,
      width: this.videoConfig.width,
      height: this.videoConfig.height,
      bitrate,
      framerate
    });
  }

  private initializeAudioEncoder() {
    this.audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        this.muxer?.addAudioChunk(chunk, meta);
      },
      error: (e) => {
        console.error('Audio Encoder Error:', e);
        if (this.onError) {
          this.onError(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

    this.configureAudioEncoder();
  }
  
  private configureAudioEncoder() {
    if (!this.audioEncoder) return;
    
    // Always use quality preset values
    const bitrate = this.currentQualityPreset.audioBitrate;

    this.audioEncoder.configure({
      codec: this.codec.audioEncoderCodec,
      sampleRate: this.audioConfig.sampleRate,
      numberOfChannels: this.audioConfig.numberOfChannels,
      bitrate
    });
  }

  private async processVideoFrames(reader: ReadableStreamDefaultReader<VideoFrame>) {
    let frameCounter = 0;
    let segmentStartTimestampUs: number | null = null;
    let lastTimestamp = -1;

    // Calculate keyframe interval based on current framerate
    // Target: 2 seconds, but cap at half chunk duration to ensure multiple keyframes per chunk
    const maxKeyframeIntervalSeconds = Math.min(this.keyframeIntervalSeconds, this.chunkDurationMs / 2000);
    let keyframeInterval = Math.round(this.currentQualityPreset.frameRate * maxKeyframeIntervalSeconds);
    
    try {
      while (this.isRecording) {
        const { done, value: frame } = await reader.read();
        if (done) break;

        if (frame) {
          const currentTimestamp = frame.timestamp ?? 0;
          
          // MediaPipe requires strictly increasing timestamps
          if (currentTimestamp <= lastTimestamp) {
            frame.close();
            continue;
          }
          lastTimestamp = currentTimestamp;

          if (segmentStartTimestampUs === null) {
            segmentStartTimestampUs = currentTimestamp;
          }
          
          const elapsedMs = (currentTimestamp - segmentStartTimestampUs) / 1000;
          // Rotate on the normal cadence, or immediately when a question transition
          // requested a forced boundary so each chunk maps to exactly one question.
          const shouldRotateSegment = elapsedMs >= this.chunkDurationMs || this.forceRotate;

          if (shouldRotateSegment) {
            // Flush the in-flight chunk with the CURRENT (previous) question's order...
            await this.muxer?.finalizeSegment();
            this.muxer?.createNewSegment();
            segmentStartTimestampUs = currentTimestamp;
            // ...then apply the new question order to subsequent chunks.
            if (this.forceRotate) {
              if (this.pendingQuestionOrder !== null) {
                this.muxer?.setQuestionOrder(this.pendingQuestionOrder);
                this.pendingQuestionOrder = null;
              }
              this.forceRotate = false;
            }
            // Recalculate keyframe interval in case quality changed
            const maxKeyframeIntervalSeconds = Math.min(this.keyframeIntervalSeconds, this.chunkDurationMs / 2000);
            keyframeInterval = Math.round(this.currentQualityPreset.frameRate * maxKeyframeIntervalSeconds);
          }

          frameCounter++;
          const insertKeyframe = shouldRotateSegment || 
                                frameCounter % keyframeInterval === 0 || 
                                this.qualityJustChanged;
          
          // Reset quality change flag after inserting keyframe
          if (this.qualityJustChanged) {
            this.qualityJustChanged = false;
            console.log(`Keyframe inserted after quality change to ${this.currentQuality}`);
          }

          // Apply AI background effect with current quality preset
          // Skip background effects if segmenter not available
          let processedFrame: VideoFrame | null = null;
          
          if (this.segmenter) {
            try {
              processedFrame = applyBackgroundEffect(
                frame, 
                this.segmenter, 
                this.videoConfig.width, 
                this.videoConfig.height,
                this.currentQualityPreset
              );
            } catch (error) {
              console.warn('Background effect error, using original frame:', error);
              processedFrame = null;
            }
          }

          if (processedFrame) {
            this.videoEncoder?.encode(processedFrame, { keyFrame: insertKeyframe });
            frame.close();
            processedFrame.close();
          } else {
            this.videoEncoder?.encode(frame, { keyFrame: insertKeyframe });
            frame.close();
          }
        }
      }
    } catch (error) {
      console.error('Video processing loop error:', error);
      if (this.onError && error instanceof Error) {
        this.onError(error);
      }
    }
  }

  private async processAudioFrames(reader: ReadableStreamDefaultReader<AudioData>) {
    try {
      while (this.isRecording) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          this.audioEncoder?.encode(value);
          value.close();
        }
      }
    } catch (error) {
      console.error('Audio processing loop error:', error);
      if (this.onError && error instanceof Error) {
        this.onError(error);
      }
    }
  }
  
  private handleQualityChange(stats: NetworkStats) {
    const newQuality = stats.quality;
    
    if (newQuality === this.currentQuality) return;
    
    console.log(`Adjusting quality from ${this.currentQuality} to ${newQuality}`);
    this.currentQuality = newQuality;
    
    // Apply the new preset to the encoders. The 'offline' level resolves to the
    // same encoder + background settings as 'poor' (see QUALITY_PRESETS), so going
    // offline drops the encoder to the lowest bitrate. This keeps the chunks that
    // are queued while disconnected as small as possible instead of retaining the
    // previous (possibly high) online bitrate.
    this.currentQualityPreset = this.qualityStrategy.getPreset(newQuality);

    // Reconfigure encoders with new bitrates
    // Note: Encoder reconfiguration during recording can cause brief quality artifacts
    try {
      if (this.videoEncoder && this.videoEncoder.state === 'configured') {
        this.configureVideoEncoder();
        // Flag that quality changed - next frame will be a keyframe for clean transition
        this.qualityJustChanged = true;
        console.log(`Quality changed, keyframe will be inserted on next frame`);
      }

      if (this.audioEncoder && this.audioEncoder.state === 'configured') {
        this.configureAudioEncoder();
      }

      // Notify callback
      if (this.onQualityChange) {
        if (newQuality === 'offline') {
          this.onQualityChange('Offline - Continue Recording', 0);
        } else {
          this.onQualityChange(
            this.currentQualityPreset.name,
            this.currentQualityPreset.videoBitrate
          );
        }
      }
    } catch (error) {
      console.error('Error adjusting quality:', error);
    }
  }
  
  getCurrentQuality(): NetworkQuality {
    return this.currentQuality;
  }
  
  getCurrentQualityPreset(): QualityPreset {
    return this.currentQualityPreset;
  }
}
