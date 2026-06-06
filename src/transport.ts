/**
 * `@ta/recording-sdk/transport` — backend transport seam.
 */
export type {
  ITransport,
  PresignedUrlResult,
  GetPresignedUrlInput
} from './transport/types';

export {
  RecordingServiceTransport,
  type RecordingServiceTransportOptions
} from './transport/RecordingServiceTransport';

export type {
  IHttpClient,
  HttpResponse,
  RecordingStatus,
  PrepareRecordingRequest,
  PrepareRecordingResponse,
  GetSaltRequest,
  GetSaltResponse,
  GetPresignedURLRequest,
  GetPresignedURLResponse,
  CompleteRecordingResponse,
  GetRecordingResponse,
  Question,
  ResumeContextResponse,
  ChunkStatsResponse,
  ReviewStatus,
  OceanScores,
  OceanResult,
  CheatTimeRange,
  CheatEvent,
  CheatDetectionResult,
  ReviewSegment,
  VideoReviewResponse,
  RetryProcessingResponse
} from './transport/recordingServiceTypes';
