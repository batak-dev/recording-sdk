import { Muxer, StreamTarget } from 'webm-muxer';
import type { RecorderCodecConfig, RecordingChunk } from './types';
import { signChunk } from './crypto';
import { createSignedChunkBlob } from './signedChunk';

export class ChunkMuxer {
  private muxer: Muxer<StreamTarget> | null = null;
  private muxedSegmentBuffer = new Uint8Array(0);
  private muxedSegmentLength = 0;
  private chunkCounter = 1;
  private currentQuestionOrder = 1;
  private videoMetaCache: EncodedVideoChunkMetadata | undefined;
  private audioMetaCache: EncodedAudioChunkMetadata | undefined;
  private onChunkReadyCallback?: (chunk: RecordingChunk) => void | Promise<void>;
  private pathIdentifier?: string;
  private salt?: string;

  constructor(
    private codec: RecorderCodecConfig,
    private videoWidth: number,
    private videoHeight: number,
    onChunkReady?: (chunk: RecordingChunk) => void | Promise<void>,
    pathIdentifier?: string,
    salt?: string
  ) {
    this.onChunkReadyCallback = onChunkReady;
    this.pathIdentifier = pathIdentifier;
    this.salt = salt;
  }
  
  setSalt(salt: string) {
    this.salt = salt;
  }
  
  setPathIdentifier(pathIdentifier: string) {
    this.pathIdentifier = pathIdentifier;
  }

  // Set the 1-based question order stamped on subsequent finalized chunks. Call
  // this only after finalizing the previous question's chunk so each chunk maps to
  // exactly one question (the recorder forces a chunk boundary at every transition).
  setQuestionOrder(order: number) {
    this.currentQuestionOrder = order >= 1 ? order : 1;
  }

  private ensureSegmentCapacity(requiredLength: number) {
    if (requiredLength <= this.muxedSegmentBuffer.length) return;
    let nextCapacity = Math.max(1024, this.muxedSegmentBuffer.length || 0);
    while (nextCapacity < requiredLength) {
      nextCapacity *= 2;
    }
    const grown = new Uint8Array(nextCapacity);
    if (this.muxedSegmentLength > 0) {
      grown.set(this.muxedSegmentBuffer.subarray(0, this.muxedSegmentLength), 0);
    }
    this.muxedSegmentBuffer = grown;
  }

  createNewSegment() {
    this.muxedSegmentBuffer = new Uint8Array(0);
    this.muxedSegmentLength = 0;
    this.muxer = new Muxer({
      target: new StreamTarget({
        onData: (data: Uint8Array, position: number) => {
          const endPosition = position + data.byteLength;
          this.ensureSegmentCapacity(endPosition);
          this.muxedSegmentBuffer.set(data, position);
          this.muxedSegmentLength = Math.max(this.muxedSegmentLength, endPosition);
        }
      }),
      video: { codec: this.codec.muxerVideoCodec, width: this.videoWidth, height: this.videoHeight },
      audio: { codec: this.codec.muxerAudioCodec, sampleRate: 48000, numberOfChannels: 1 },
      firstTimestampBehavior: 'offset'
    });
  }

  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) {
    if (meta?.decoderConfig) {
      this.videoMetaCache = meta;
    }
    if (!this.muxer) {
      // Segment has been finalized, create new segment to receive this late chunk
      // This preserves all data and prevents gaps during segment rotation
      this.createNewSegment();
    }
    this.muxer!.addVideoChunk(chunk, meta || this.videoMetaCache);
  }

  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) {
    if (meta?.decoderConfig) {
      this.audioMetaCache = meta;
    }
    if (!this.muxer) {
      // Segment has been finalized, create new segment to receive this late chunk
      // This preserves all data and prevents gaps during segment rotation
      this.createNewSegment();
    }
    this.muxer!.addAudioChunk(chunk, meta || this.audioMetaCache);
  }

  async finalizeSegment(): Promise<RecordingChunk | null> {
    if (!this.muxer) return null;
    
    // Save reference and immediately set to null to prevent race condition
    // Late-arriving chunks will see null and create a new segment instead of 
    // trying to add to this finalized muxer
    const muxerToFinalize = this.muxer;
    this.muxer = null;
    
    muxerToFinalize.finalize();
    
    if (this.muxedSegmentLength > 0) {
      const chunkData = this.muxedSegmentBuffer.slice(0, this.muxedSegmentLength);
      
      // Sign chunk if salt and pathIdentifier are available
      let finalBlob: Blob;
      let signature: string | undefined;
      
      if (this.salt && this.pathIdentifier) {
        try {
          // Sign with blob content to prevent tampering
          signature = await signChunk(this.salt, this.chunkCounter, this.pathIdentifier, chunkData);
          
          // Create signed chunk file with embedded signature
          finalBlob = createSignedChunkBlob(chunkData, signature, {
            chunkIndex: this.chunkCounter,
            pathIdentifier: this.pathIdentifier,
            timestamp: Date.now(),
            questionOrder: this.currentQuestionOrder
          });
          
          console.log(`Chunk ${this.chunkCounter} signed and packaged (${finalBlob.size} bytes, ${chunkData.length} WebM + signature)`);
        } catch (error) {
          console.error('Failed to sign chunk, using unsigned:', error);
          finalBlob = new Blob([chunkData], { type: 'video/webm' });
        }
      } else {
        // No salt/path - create unsigned chunk
        finalBlob = new Blob([chunkData], { type: 'video/webm' });
      }
      
      const chunk: RecordingChunk = {
        index: this.chunkCounter,
        size: finalBlob.size,
        url: URL.createObjectURL(finalBlob),
        blob: finalBlob,
        signature: signature
      };
      this.chunkCounter += 1;
      
      if (this.onChunkReadyCallback) {
        // Await the callback if it returns a promise to ensure chunk is fully enqueued
        const result = this.onChunkReadyCallback(chunk);
        if (result instanceof Promise) {
          await result;
        }
      }
      
      this.muxedSegmentBuffer = new Uint8Array(0);
      this.muxedSegmentLength = 0;
      
      return chunk;
    }
    
    this.muxedSegmentBuffer = new Uint8Array(0);
    this.muxedSegmentLength = 0;
    return null;
  }

  reset(startChunkIndex: number = 1) {
    this.chunkCounter = startChunkIndex >= 1 ? startChunkIndex : 1;
    this.videoMetaCache = undefined;
    this.audioMetaCache = undefined;
  }
}
