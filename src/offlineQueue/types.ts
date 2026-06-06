// Request types for queue operations
export type RequestType =
  | 'PREPARE'
  | 'GET_SALT'
  | 'START_RECORDING'
  | 'PRESIGNED_URL'
  | 'UPLOAD_CHUNK'
  | 'COMPLETE_RECORDING';

// Priority levels for queue processing
export enum Priority {
  CRITICAL = 0,  // prepare, salt, start
  HIGH = 1,      // chunks
  MEDIUM = 2,    // reserved
  LOW = 3        // complete
}

// Request status
export type RequestStatus = 'PENDING' | 'IN_PROGRESS' | 'FAILED' | 'COMPLETED' | 'EXPIRED' | 'NEEDS_AUTH';

// Base request structure
export interface QueuedRequest {
  id: string;
  type: RequestType;
  data: any;
  status: RequestStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  priority: Priority;
  dependencies?: string[]; // IDs of requests this depends on
  error?: string;
}

// Specific request data structures
export interface PrepareRecordingData {
  reference_id: string;
  description?: string;
  duration: number;
}

export interface GetSaltData {
  pathIdentifier: string;
  public_key: string;
}

export interface StartRecordingData {
  pathIdentifier: string;
}

export interface PresignedUrlData {
  pathIdentifier: string;
  chunk_index: number;
  signature: string;
}

export interface UploadChunkData {
  presignedUrl: string;
  chunkIndex: number;
  pathIdentifier: string;
  blob?: Blob;
  blobId?: string; // Reference to blob in storage
  signature: string;
  size: number;
}

export interface CompleteRecordingData {
  pathIdentifier: string;
}

// Chunk storage structure
export interface StoredChunk {
  chunkIndex: number;
  blobId: string;
  signature: string;
  pathIdentifier: string;
  status: RequestStatus;
  presignedUrl?: string;
  presignedUrlExpiresAt?: number;
  size: number;
  createdAt: number;
  attempts: number;
  retryCount?: number; // times this chunk transitioned back to PENDING (B2 retry-success metric)
  // Request IDs for tracking
  presignedRequestId?: string;
  uploadRequestId?: string;
}

// Recording metadata storage
export interface RecordingMetadata {
  pathIdentifier: string;
  deadline: number;
  status: 'SETUP' | 'RECORDING' | 'UPLOADING' | 'COMPLETED' | 'FAILED';
  completedChunks: number[];
  totalChunks: number;
  createdAt: number;
  updatedAt: number;
  // Checkpoint fields for resume
  referenceId?: string;
  currentQuestionIndex?: number;
  currentPhase?: 'reading' | 'answering';
  phaseEndsAt?: number; // absolute ms timestamp
  lastChunkIndex?: number;
}

// Queue status response
export interface QueueStatus {
  pendingRequests: number;
  pendingChunks: number;
  isProcessing: boolean;
  failedOperations: number;
  completedChunks: number;
  totalChunks: number;
}

// Presigned URL cache entry
export interface PresignedUrlCache {
  chunkIndex: number;
  pathIdentifier: string;
  presignedUrl: string;
  expiresAt: number;
  signature: string;
}

// Auth token cache entry (for SW access)
export interface AuthTokenCache {
  userId: string;
  token: string;
  expiresAt: number;
  sessionId: string; // For detecting user/session changes
  createdAt: number;
}
