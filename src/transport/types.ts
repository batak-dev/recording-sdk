/**
 * Transport seam.
 *
 * Abstracts the backend the offline queue talks to. The default implementation
 * targets the recording-service REST contract (presigned-URL + direct object-store
 * upload), but a consumer can supply any object implementing this interface to
 * target a different backend.
 */
export interface PresignedUrlResult {
  presigned_url: string;
  [key: string]: any;
}

export interface GetPresignedUrlInput {
  chunk_index: number;
  signature?: string;
}

export interface ITransport {
  /** Mark a recording session as started (server sets the deadline). */
  startRecording(pathIdentifier: string): Promise<void>;

  /** Obtain a presigned upload URL for a single chunk. */
  getPresignedURL(pathIdentifier: string, data: GetPresignedUrlInput): Promise<PresignedUrlResult>;

  /** Upload a chunk blob to the storage URL returned by {@link getPresignedURL}. */
  uploadChunk(presignedUrl: string, blob: Blob): Promise<void>;

  /** Finalize a recording session once all chunks are uploaded. */
  completeRecording(pathIdentifier: string): Promise<any>;
}
