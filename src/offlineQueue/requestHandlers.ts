/**
 * Request handlers for each operation type
 * Wraps API calls with error handling and offline persistence
 * 
 * IMPORTANT: PREPARE and GET_SALT are NOT queued!
 * They are mandatory synchronous operations that run during setup.
 * If they fail, the entire recording setup fails immediately.
 * 
 * Queued request types (in priority order):
 *   1. START_RECORDING (CRITICAL) - Must succeed before recording begins
 *   2. PRESIGNED_URL + UPLOAD_CHUNK (HIGH) - Chunk uploads
 *   3. COMPLETE_RECORDING (LOW) - Final recording completion (waits for all chunks)
 * 
 * This priority order matches the Service Worker's processing logic.
 */

import type { QueuedRequest } from './types';
import type { OfflineQueueManager } from './manager';
import type { ITransport } from '../transport/types';
import * as db from './db';
import * as blobStorage from './blobStorage';

/**
 * Initialize request handlers for the queue manager
 */
export function setupRequestHandlers(
  queueManager: OfflineQueueManager,
  recordingService: ITransport
) {
  queueManager.on('process', async (request: QueuedRequest) => {
    try {
      switch (request.type) {
        case 'START_RECORDING':
          await handleStartRecording(request, recordingService, queueManager);
          break;
        case 'PRESIGNED_URL':
          await handlePresignedUrl(request, recordingService, queueManager);
          break;
        case 'UPLOAD_CHUNK':
          await handleChunkUpload(request, recordingService, queueManager);
          break;
        case 'COMPLETE_RECORDING':
          await handleCompleteRecording(request, recordingService, queueManager);
          break;
        default:
          console.warn(`Unknown or unsupported request type: ${request.type}`);
          // Mark as failed so it doesn't block the queue
          throw new Error(`Unsupported request type: ${request.type}`);
      }
    } catch (error: any) {
      console.error(`Request handler error for ${request.type}:`, error);
      await queueManager.markFailed(request.id, error);
    }
  });
}

/**
 * Note: PREPARE and GET_SALT are NOT queued.
 * They are mandatory synchronous operations called directly during setup.
 * If they fail, the entire recording setup fails - no retry logic needed.
 */

/**
 * Handle START_RECORDING request
 */
async function handleStartRecording(
  request: QueuedRequest,
  recordingService: any,
  queueManager: OfflineQueueManager
) {
  const { pathIdentifier } = request.data;

  await recordingService.startRecording(pathIdentifier);
  await queueManager.markCompleted(request.id);
}

/**
 * Handle PRESIGNED_URL request
 */
async function handlePresignedUrl(
  request: QueuedRequest,
  recordingService: any,
  queueManager: OfflineQueueManager
) {
  const { pathIdentifier, chunk_index, signature } = request.data;

  // Check if we have a cached valid URL
  const cached = await db.getCachedPresignedUrl(pathIdentifier, chunk_index);
  if (cached && cached.expiresAt > Date.now() + 60000) { // Valid for at least 1 more minute
    console.log(`Using cached presigned URL for chunk ${chunk_index}`);
    request.data.result = { presigned_url: cached.presignedUrl };
    await db.updateRequest(request);
    await queueManager.markCompleted(request.id);
    return;
  }

  // Get new presigned URL from backend
  // NOTE: Signature is now embedded in the chunk file itself
  // Backend will extract and validate it after upload
  const response = await recordingService.getPresignedURL(pathIdentifier, {
    chunk_index
    // No signature sent - it's in the file!
  });

  // Cache the presigned URL
  await db.cachePresignedUrl({
    chunkIndex: chunk_index,
    pathIdentifier,
    presignedUrl: response.presigned_url,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    signature: signature || ''
  });

  // Store result in request data
  request.data.result = response;
  await db.updateRequest(request);

  // Update corresponding chunk with presigned URL
  const chunk = await db.getChunk(pathIdentifier, chunk_index);
  if (chunk) {
    chunk.presignedUrl = response.presigned_url;
    chunk.presignedUrlExpiresAt = Date.now() + 10 * 60 * 1000;
    await db.updateChunk(chunk);
    console.log(`[HandlePresignedUrl] Updated chunk ${chunk_index} with presigned URL: ${response.presigned_url.substring(0, 100)}...`);
  } else {
    console.warn(`[HandlePresignedUrl] Chunk ${chunk_index} not found in database`);
  }

  await queueManager.markCompleted(request.id);
}

/**
 * Handle UPLOAD_CHUNK request (upload to MinIO)
 */
async function handleChunkUpload(
  request: QueuedRequest,
  recordingService: any,
  queueManager: OfflineQueueManager
) {
  const { presignedUrl, chunkIndex, pathIdentifier, blobId, signature } = request.data;

  // Get chunk from storage and verify it's not already being processed
  const chunk = await db.getChunk(pathIdentifier, chunkIndex);
  if (!chunk) {
    throw new Error(`Chunk ${chunkIndex} not found in storage`);
  }
  
  // Race condition check: if chunk is already completed or in progress by SW, skip
  if (chunk.status === 'COMPLETED') {
    console.log(`[RequestHandler] Chunk ${chunkIndex} already completed, marking request as completed`);
    await queueManager.markCompleted(request.id);
    return;
  }
  
  if (chunk.status === 'IN_PROGRESS') {
    console.log(`[RequestHandler] Chunk ${chunkIndex} is being processed by another worker (likely SW), marking as completed to avoid blocking`);
    // Mark request as completed since the other worker will handle it
    // This prevents the request from blocking the queue
    await queueManager.markCompleted(request.id);
    return;
  }
  
  // Mark chunk as in progress to prevent SW from also processing it
  chunk.status = 'IN_PROGRESS';
  await db.updateChunk(chunk);

  try {
    // Check if presigned URL is expired or missing
    let uploadUrl = presignedUrl || chunk.presignedUrl;
    
    if (!uploadUrl || chunk.presignedUrlExpiresAt && chunk.presignedUrlExpiresAt < Date.now()) {
      console.log(`[RequestHandler] Presigned URL ${!uploadUrl ? 'missing' : 'expired'} for chunk ${chunkIndex}, requesting new one`);
      
      // Request new presigned URL
      const presignedResponse = await recordingService.getPresignedURL(pathIdentifier, {
        chunk_index: chunkIndex,
        signature
      });

      uploadUrl = presignedResponse.presigned_url;
      chunk.presignedUrl = uploadUrl;
      chunk.presignedUrlExpiresAt = Date.now() + 10 * 60 * 1000;
      await db.updateChunk(chunk);
      
      console.log(`[RequestHandler] Got new presigned URL for chunk ${chunkIndex}: ${uploadUrl.substring(0, 100)}...`);
    } else {
      console.log(`[RequestHandler] Using existing presigned URL for chunk ${chunkIndex}: ${uploadUrl.substring(0, 100)}...`);
    }

    // Retrieve blob from storage
    const blob = await blobStorage.retrieveBlob(blobId);
    if (!blob) {
      throw new Error(`Blob ${blobId} not found in storage`);
    }
    
    console.log(`[RequestHandler] Retrieved blob for chunk ${chunkIndex}, size: ${blob.size} bytes`);

    // Upload to MinIO
    console.log(`[RequestHandler] Uploading chunk ${chunkIndex} to MinIO...`);
    await recordingService.uploadChunk(uploadUrl, blob);

    console.log(`Chunk ${chunkIndex} uploaded successfully`);

    // Update chunk status
    chunk.status = 'COMPLETED';
    await db.updateChunk(chunk);

    // Update metadata
    const metadata = await db.getMetadata(pathIdentifier);
    if (metadata) {
      if (!metadata.completedChunks.includes(chunkIndex)) {
        metadata.completedChunks.push(chunkIndex);
        metadata.completedChunks.sort((a, b) => a - b);
        metadata.updatedAt = Date.now();
        await db.saveMetadata(metadata);
      }
    }

    // Clean up blob from storage
    await blobStorage.deleteBlob(blobId);

    await queueManager.markCompleted(request.id);

    // Emit event for UI update
    queueManager.emit('chunkUploaded', chunkIndex);
  } catch (error) {
    // Reset chunk status on error so it can be retried
    const freshChunk = await db.getChunk(pathIdentifier, chunkIndex);
    if (freshChunk && freshChunk.status === 'IN_PROGRESS') {
      freshChunk.status = 'PENDING';
      freshChunk.retryCount = (freshChunk.retryCount ?? 0) + 1; // B2 retry-success metric
      await db.updateChunk(freshChunk);
    }
    // Re-throw so the main error handler can process it
    throw error;
  }
}

/**
 * Handle COMPLETE_RECORDING request
 */
async function handleCompleteRecording(
  request: QueuedRequest,
  recordingService: any,
  queueManager: OfflineQueueManager
) {
  const { pathIdentifier } = request.data;

  // Verify all chunks are uploaded
  const metadata = await db.getMetadata(pathIdentifier);
  if (!metadata) {
    throw new Error(`Recording metadata not found for ${pathIdentifier}`);
  }

  const pendingChunks = await db.getChunksByPath(pathIdentifier);
  const incompletChunks = pendingChunks.filter(c => c.status !== 'COMPLETED');

  if (incompletChunks.length > 0) {
    throw new Error(
      `Cannot complete recording: ${incompletChunks.length} chunks still pending`
    );
  }

  // Call complete recording API
  const response = await recordingService.completeRecording(pathIdentifier);

  // Store result
  request.data.result = response;
  await db.updateRequest(request);

  // Update metadata
  metadata.status = 'COMPLETED';
  metadata.updatedAt = Date.now();
  await db.saveMetadata(metadata);

  await queueManager.markCompleted(request.id);

  console.log(`Recording completed: ${pathIdentifier}`);
}

/**
 * Helper: Enqueue chunk upload with dependencies
 */
export async function enqueueChunkUpload(
  queueManager: OfflineQueueManager,
  pathIdentifier: string,
  chunkIndex: number,
  signature: string,
  blob: Blob
): Promise<string> {
  console.log(`[EnqueueChunkUpload] Enqueuing chunk ${chunkIndex} for path ${pathIdentifier}, blob size: ${blob.size} bytes`);
  // Store blob
  const blobId = blobStorage.generateBlobId(pathIdentifier, chunkIndex);
  await blobStorage.storeBlob(blobId, blob);
  console.log(`[EnqueueChunkUpload] Blob stored with ID: ${blobId}`);

  // Enqueue presigned URL request first
  const presignedRequestId = await queueManager.enqueue('PRESIGNED_URL', {
    pathIdentifier,
    chunk_index: chunkIndex,
    signature
  });
  console.log(`[EnqueueChunkUpload] Presigned URL request enqueued: ${presignedRequestId}`);

  // Enqueue upload request (depends on presigned URL)
  const uploadRequestId = await queueManager.enqueue(
    'UPLOAD_CHUNK',
    {
      presignedUrl: '', // Will be filled from chunk metadata
      chunkIndex,
      pathIdentifier,
      blobId,
      signature,
      size: blob.size
    },
    [presignedRequestId] // Dependency
  );
  
  console.log(`[EnqueueChunkUpload] Upload request enqueued: ${uploadRequestId}, depends on ${presignedRequestId}`);

  // Store chunk metadata with request IDs
  await db.addChunk({
    chunkIndex,
    blobId,
    signature,
    pathIdentifier,
    status: 'PENDING',
    size: blob.size,
    createdAt: Date.now(),
    attempts: 0,
    presignedRequestId,
    uploadRequestId
  });

  return uploadRequestId;
}

/**
 * Helper: Enqueue complete recording request
 */
export async function enqueueCompleteRecording(
  queueManager: OfflineQueueManager,
  pathIdentifier: string
): Promise<string> {
  console.log(`[EnqueueCompleteRecording] Enqueuing complete recording for ${pathIdentifier}`);
  
  // Get all pending upload chunk requests for this path to use as dependencies
  const allRequests = await db.getAllRequests();
  const chunkUploadDependencies = allRequests
    .filter(r => 
      r.type === 'UPLOAD_CHUNK' && 
      r.data.pathIdentifier === pathIdentifier &&
      r.status !== 'COMPLETED' &&
      r.status !== 'FAILED'
    )
    .map(r => r.id);
  
  console.log(`[EnqueueCompleteRecording] Waiting for ${chunkUploadDependencies.length} chunk uploads to complete`);
  
  return queueManager.enqueue(
    'COMPLETE_RECORDING', 
    { pathIdentifier },
    chunkUploadDependencies // Wait for all chunks to upload first
  );
}
