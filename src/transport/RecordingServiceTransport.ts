import type { ITransport, GetPresignedUrlInput, PresignedUrlResult } from './types';
import type {
  IHttpClient,
  PrepareRecordingRequest,
  PrepareRecordingResponse,
  GetSaltRequest,
  GetSaltResponse,
  GetPresignedURLResponse,
  CompleteRecordingResponse,
  GetRecordingResponse,
  ResumeContextResponse,
  ChunkStatsResponse,
  VideoReviewResponse,
  RetryProcessingResponse
} from './recordingServiceTypes';

export interface RecordingServiceTransportOptions {
  /** Base URL of the recording-service (no trailing slash required). */
  baseURL: string;
  /** Content-Type sent on the direct object-store chunk upload. Defaults to `video/webm`. */
  uploadContentType?: string;
}

/**
 * Default {@link ITransport} implementation targeting the recording-service REST
 * contract (presigned-URL + direct object-store upload).
 *
 * Framework-agnostic: it takes an axios-compatible {@link IHttpClient} and a base URL.
 * The host app supplies these (e.g. Nuxt's `$api` + `runtimeConfig.recordingServiceUrl`);
 * the package no longer reads `import.meta.env`.
 *
 * Beyond the four {@link ITransport} methods that the offline queue and service worker
 * depend on, this exposes the full recording-service surface (prepare, salt, resume
 * context, stats, review, retry) for consumers that drive the recording lifecycle.
 */
export class RecordingServiceTransport implements ITransport {
  private api: IHttpClient;
  private baseURL: string;
  private uploadContentType: string;

  constructor(api: IHttpClient, options: RecordingServiceTransportOptions) {
    this.api = api;
    this.baseURL = (options.baseURL || '').replace(/\/$/, '');
    this.uploadContentType = options.uploadContentType ?? 'video/webm';
  }

  /**
   * Step 3: Prepare a new recording session
   */
  async prepareRecording(data: PrepareRecordingRequest): Promise<PrepareRecordingResponse> {
    const response = await this.api.post<PrepareRecordingResponse>(
      `${this.baseURL}/api/v0/all/recordings/prepare`,
      data
    );
    return response.data;
  }

  /**
   * Step 8: Get encrypted salt for chunk signing
   */
  async getSalt(pathIdentifier: string, data: GetSaltRequest): Promise<GetSaltResponse> {
    const response = await this.api.post<GetSaltResponse>(
      `${this.baseURL}/api/v0/all/recordings/${pathIdentifier}/salt`,
      data
    );
    return response.data;
  }

  /**
   * Step 5: Start recording (sets deadline)
   */
  async startRecording(pathIdentifier: string): Promise<void> {
    await this.api.post(`${this.baseURL}/api/v0/all/recordings/${pathIdentifier}/start`);
  }

  /**
   * Step 9-10: Get presigned URL for chunk upload
   */
  async getPresignedURL(
    pathIdentifier: string,
    data: GetPresignedUrlInput
  ): Promise<PresignedUrlResult & GetPresignedURLResponse> {
    const response = await this.api.post<GetPresignedURLResponse>(
      `${this.baseURL}/api/v0/all/recordings/${pathIdentifier}/presigned`,
      data
    );
    return response.data;
  }

  /**
   * Step 11: Complete recording (triggers processing)
   */
  async completeRecording(pathIdentifier: string): Promise<CompleteRecordingResponse> {
    const response = await this.api.post<CompleteRecordingResponse>(
      `${this.baseURL}/api/v0/all/recordings/${pathIdentifier}/complete`
    );
    return response.data;
  }

  /**
   * Get recording details
   */
  async getRecording(pathIdentifier: string): Promise<GetRecordingResponse> {
    const response = await this.api.get<GetRecordingResponse>(
      `${this.baseURL}/api/v0/all/recordings/${pathIdentifier}`
    );
    return response.data;
  }

  /**
   * Get resume context for an interrupted recording
   */
  async getResumeContext(pathIdentifier: string): Promise<ResumeContextResponse> {
    const response = await this.api.get<ResumeContextResponse>(
      `${this.baseURL}/api/v0/all/recordings/${pathIdentifier}/resume-context`
    );
    return response.data;
  }

  /**
   * Get chunk statistics (public endpoint) - used for resilience CDR + duplicate metrics
   */
  async getChunkStats(pathIdentifier: string): Promise<ChunkStatsResponse> {
    const response = await this.api.get<ChunkStatsResponse>(
      `${this.baseURL}/api/v0/public/chunks/stats/${pathIdentifier}`
    );
    return response.data;
  }

  /**
   * Recruiter/admin review of a video interview by backend interview id (reference_id):
   * processing status, OCEAN + cheat-detection results, transcripts, and playback URLs.
   */
  async getVideoReview(referenceId: string): Promise<VideoReviewResponse> {
    const response = await this.api.get<VideoReviewResponse>(
      `${this.baseURL}/api/v0/all/recordings/by-reference/${referenceId}/review`
    );
    return response.data;
  }

  /**
   * Recruiter/admin retry of failed processing/analysis for a recording.
   */
  async retryProcessing(pathIdentifier: string): Promise<RetryProcessingResponse> {
    const response = await this.api.post<RetryProcessingResponse>(
      `${this.baseURL}/api/v0/all/recordings/${pathIdentifier}/retry`
    );
    return response.data;
  }

  /**
   * Upload chunk to object storage using a presigned URL.
   * Note: the chunk blob is a signed chunk file with an embedded signature; the
   * backend extracts and validates it after upload. This bypasses the configured
   * HTTP client (and any interceptors) and uploads directly via `fetch`.
   */
  async uploadChunk(presignedURL: string, chunkBlob: Blob): Promise<void> {
    if (!presignedURL) {
      throw new Error('Presigned URL is required for chunk upload');
    }

    if (!presignedURL.startsWith('http://') && !presignedURL.startsWith('https://')) {
      throw new Error(`Invalid presigned URL: ${presignedURL}`);
    }

    console.log(`[RecordingService] Uploading chunk to presigned URL: ${presignedURL.substring(0, 100)}...`);

    // Direct upload to object storage, bypassing the HTTP client's interceptors.
    const response = await fetch(presignedURL, {
      method: 'PUT',
      body: chunkBlob,
      headers: {
        'Content-Type': this.uploadContentType
      }
    });

    if (!response.ok) {
      throw new Error(`Chunk upload failed: ${response.status} ${response.statusText}`);
    }

    console.log(`[RecordingService] Chunk uploaded successfully`);
  }
}
