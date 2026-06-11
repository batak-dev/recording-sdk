/**
 * Recording-service REST API DTOs.
 *
 * These describe the wire contract of the default backend that
 * {@link RecordingServiceTransport} targets. They were previously declared in the
 * host app's `types/nuxt.d.ts`; they now live with the transport so the package is
 * the single source of truth and consumers can import them directly.
 */

export type RecordingStatus =
  | 'CREATED'
  | 'RECORDING_DONE'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'FAILED';

export interface PrepareRecordingRequest {
  reference_id: string;
  description?: string;
  duration: number; // in seconds
  language: string;
  is_test?: boolean; // prototype/experiment recordings skip the backend callback
  questions?: { order: number; text: string }[]; // ordered interview questions
}

export interface PrepareRecordingResponse {
  path_identifier: string;
  reference_id: string;
  status: RecordingStatus;
  deadline: string; // ISO date string
  created_at: string; // ISO date string
}

export interface GetSaltRequest {
  public_key: string;
}

export interface GetSaltResponse {
  encrypted_salt: string;
  path_identifier: string;
}

export interface GetPresignedURLRequest {
  chunk_index: number;
  // NOTE: signature is now embedded in the chunk file itself
  // Backend extracts and validates it after upload
}

export interface GetPresignedURLResponse {
  presigned_url: string;
  expires_at: string;
  chunk_path: string;
}

export interface CompleteRecordingResponse {
  path_identifier: string;
  status: RecordingStatus;
  processing_job_id?: string;
  message: string;
}

export interface GetRecordingResponse {
  path_identifier: string;
  reference_id: string;
  status: RecordingStatus;
  deadline: string;
  created_at: string;
  updated_at: string;
  storage_path?: string;
  file_size?: number;
  duration?: number;
  format?: string;
  processing_job_id?: string;
}

export interface Question {
  id: number;
  text: string;
}

export interface ResumeContextResponse {
  path_identifier: string;
  status: RecordingStatus;
  deadline: string;
  last_chunk_index: number;
  last_question_order: number;
}

export interface ChunkStatsResponse {
  path_identifier: string;
  avg_chunk_size: number;
  avg_chunk_size_per_sec: number;
  total_duration_seconds: number;
  chunk_count: number;
  total_size: number;
  // Resilience measurement additions (per-index): CDR + duplicate detection
  present_indices?: number[];
  duplicate_indices?: number[];
  duplicate_count?: number;
}

// ===== Recruiter video-interview review =====

export type ReviewStatus = 'IN_PROGRESS' | 'PROCESSING' | 'DONE' | 'FAILED';

export interface OceanScores {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;

  answer_score?: number;
  confidence_score?: number;
  facial_expression?: number;
  interview_score?: number;
  overall_performance?: number;
  overall_personality?: number;
  speaking_skills?: number;
}

export interface OceanResult {
  status?: string;
  interview_id?: string;
  aggregate_scores?: OceanScores;
  per_answer_scores?: Record<string, OceanScores>;
  failed_questions?: string[];
  error?: string;
}

export interface CheatTimeRange {
  start_second: number;
  end_second: number;
  duration_second: number;
}

export interface CheatEvent {
  type: string;
  label?: string;
  time_range: CheatTimeRange[];
}

export interface CheatDetectionResult {
  status?: string;
  filename?: string;
  is_cheated?: boolean;
  events?: CheatEvent[];
  error?: string;
}

export interface ReviewSegment {
  order: number;
  question: string;
  transcript: string;
  duration: number;
  video_url?: string;
}

export interface VideoReviewResponse {
  path_identifier: string;
  reference_id: string;
  status: RecordingStatus;
  review_status: ReviewStatus;
  language: string;
  duration: number;
  full_video_url?: string;
  ocean_result?: OceanResult;
  cheat_detection_result?: CheatDetectionResult;
  segments: ReviewSegment[];
}

export interface RetryProcessingResponse {
  path_identifier: string;
  review_status: ReviewStatus;
  retried: string[];
  message: string;
}

/**
 * Minimal HTTP client contract (axios-compatible) used by the default transport.
 * A Nuxt app's axios `$api` instance satisfies this directly; consumers can wrap
 * `fetch` or any other client to the same shape.
 */
export interface HttpResponse<T = any> {
  data: T;
}

export interface IHttpClient {
  get<T = any>(url: string): Promise<HttpResponse<T>>;
  post<T = any>(url: string, data?: any): Promise<HttpResponse<T>>;
}
