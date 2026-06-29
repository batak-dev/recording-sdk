/**
 * OfflineQueueManager - Core queue management logic
 * Handles request queuing, retry logic, dependency resolution, and offline persistence
 */

import type {
  QueuedRequest,
  RequestType,
  RequestStatus,
  QueueStatus
} from './types';
import { Priority } from './types';
import * as db from './db';
import { EventEmitter } from '../eventEmitter';
import type { IAuthTokenProvider } from '../auth/types';

const MAX_CONCURRENT_OPERATIONS = 2;
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 30000; // 30 seconds
const PRESIGNED_URL_VALIDITY = 5 * 60 * 1000; // 5 minutes

export interface QueueManagerOptions {
  onStatusChange?: (status: QueueStatus) => void;
  onError?: (error: Error) => void;
  onChunkUploaded?: (chunkIndex: number) => void;
  /**
   * Optional auth-token provider. Used to refresh the token before retrying
   * `NEEDS_AUTH` requests and to detect session changes. When omitted, the queue
   * still retries `NEEDS_AUTH` requests and assumes the session is valid.
   */
  authProvider?: IAuthTokenProvider;
}

export class OfflineQueueManager extends EventEmitter {
  private isProcessing = false;
  private isOnline = navigator.onLine;
  private activeOperations = 0;
  private options: QueueManagerOptions;
  private processingLoop: number | null = null;
  private recovered = false; // orphaned-IN_PROGRESS reclaim runs once per manager

  constructor(options: QueueManagerOptions = {}) {
    super();
    this.options = options;
    this.setupEventListeners();
  }

  /**
   * Setup online/offline event listeners
   */
  private setupEventListeners() {
    window.addEventListener('online', () => {
      console.log('Network: Online');
      this.isOnline = true;
      this.resume();
    });

    window.addEventListener('offline', () => {
      console.log('Network: Offline');
      this.isOnline = false;
      this.pause();
    });
    
    // Listen for messages from Service Worker
    navigator.serviceWorker?.addEventListener('message', (event) => {
      if (event.data.type === 'CHUNK_UPLOADED') {
        console.log(`[QueueManager] SW uploaded chunk ${event.data.chunkIndex}`);
        // Decrement active operations if needed (SW completed a request we were tracking)
        if (this.activeOperations > 0) {
          this.activeOperations--;
          console.log(`[QueueManager] Decremented activeOperations to ${this.activeOperations}`);
        }
        // Continue processing queue
        if (this.isOnline && !this.isProcessing) {
          this.startProcessing();
        } else if (this.isProcessing) {
          // Trigger next request processing
          this.processNextRequest();
        }
      } else if (event.data.type === 'SYNC_COMPLETE') {
        console.log(`[QueueManager] SW sync complete: ${event.data.successCount} succeeded, ${event.data.failCount} failed`);
        // Reset activeOperations counter since SW handled uploads independently
        if (this.activeOperations > 0) {
          console.log(`[QueueManager] Resetting activeOperations from ${this.activeOperations} to 0 after SW sync`);
          this.activeOperations = 0;
        }
        // Resume normal queue processing and check for pending COMPLETE_RECORDING requests
        if (this.isOnline && !this.isProcessing) {
          console.log('[QueueManager] Starting queue processing after SW sync');
          this.startProcessing();
        } else if (this.isProcessing) {
          console.log('[QueueManager] Queue already processing, triggering next request check');
          this.processNextRequest();
        }
        // Log current queue status for debugging
        this.getStatus().then(status => {
          console.log('[QueueManager] Queue status after sync:', status);
        });
      }
    });
  }

  /**
   * Generate unique ID for request
   */
  private generateId(type: RequestType, data: any): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `${type}_${timestamp}_${random}`;
  }

  /**
   * Get priority for request type
   * Note: PREPARE and GET_SALT are NOT queued - they run synchronously during setup
   */
  private getPriority(type: RequestType): Priority {
    switch (type) {
      case 'START_RECORDING':
        return Priority.CRITICAL;
      case 'PRESIGNED_URL':
      case 'UPLOAD_CHUNK':
        return Priority.HIGH;
      case 'COMPLETE_RECORDING':
        return Priority.LOW;
      default:
        return Priority.MEDIUM;
    }
  }

  /**
   * Enqueue a new request
   */
  async enqueue(type: RequestType, data: any, dependencies: string[] = []): Promise<string> {
    const request: QueuedRequest = {
      id: this.generateId(type, data),
      type,
      data,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      priority: this.getPriority(type),
      dependencies
    };

    await db.addRequest(request);
    console.log(`Enqueued ${type} request: ${request.id}`);

    // Start processing if not already running
    if (!this.isProcessing && this.isOnline) {
      this.startProcessing();
    }

    return request.id;
  }

  /**
   * Start processing queue
   */
  async startProcessing() {
    if (this.isProcessing) return;

    this.isProcessing = true;

    // One-time crash recovery: reclaim work orphaned at IN_PROGRESS by a previous page/worker
    // that died mid-upload. Must run before the loop sets its own IN_PROGRESS locks, and only
    // once per manager (setting isProcessing above locks out re-entry during the await).
    if (!this.recovered) {
      this.recovered = true;
      try {
        const reclaimed = await db.resetStuckProcessing();
        if (reclaimed > 0) console.log(`[QueueManager] Reclaimed ${reclaimed} orphaned in-progress operation(s)`);
      } catch (err) {
        console.warn('[QueueManager] Failed to reclaim orphaned operations:', err);
      }
    }

    console.log('Queue processing started');

    // Tell the Service Worker we're actively draining so it defers to us (avoids double-
    // processing). Heartbeating — not a one-shot — so that if this page goes idle or dies, the
    // worker stops hearing it and takes over the leftover queue itself.
    this.notifyServiceWorkerDraining();

    // Process queue periodically
    this.processingLoop = window.setInterval(async () => {
      if (this.isOnline) {
        this.notifyServiceWorkerDraining();
        if (this.activeOperations < MAX_CONCURRENT_OPERATIONS) {
          await this.processNextRequest();
        }
      }
    }, 1000);

    // Also process immediately
    await this.processNextRequest();
  }

  /**
   * Heartbeat to the active Service Worker that this page is draining the queue, so it defers
   * rather than processing in parallel. Best-effort: no SW (or no controller yet) is a no-op.
   */
  private notifyServiceWorkerDraining() {
    try {
      const sw = navigator.serviceWorker;
      if (!sw) return;
      if (sw.controller) {
        sw.controller.postMessage({ type: 'CLIENT_DRAINING' });
      } else {
        // Not yet controlled (first load before claim) — post to the active worker directly.
        sw.ready.then((reg) => reg.active?.postMessage({ type: 'CLIENT_DRAINING' })).catch(() => {});
      }
    } catch {
      // ignore — heartbeat is advisory
    }
  }

  /**
   * Stop processing queue
   */
  stopProcessing() {
    this.isProcessing = false;
    if (this.processingLoop !== null) {
      clearInterval(this.processingLoop);
      this.processingLoop = null;
    }
    console.log('Queue processing stopped');
  }

  /**
   * Pause processing (when offline)
   */
  pause() {
    console.log('Queue paused (offline)');
    this.isProcessing = false;
  }

  /**
   * Resume processing (when online)
   */
  async resume() {
    console.log('Queue resumed (online)');
    
    // Check for NEEDS_AUTH requests and refresh token
    await this.retryNeedsAuthRequests();
    
    await this.startProcessing();
  }
  
  /**
   * Retry requests that need fresh auth token
   */
  private async retryNeedsAuthRequests() {
    try {
      const needsAuthRequests = await db.getRequestsByStatus('NEEDS_AUTH');
      
      if (needsAuthRequests.length === 0) {
        return;
      }
      
      console.log(`Found ${needsAuthRequests.length} requests needing auth, refreshing token...`);

      // Refresh the auth token via the injected provider (if any) before retrying.
      if (this.options.authProvider?.cacheCurrentToken) {
        await this.options.authProvider.cacheCurrentToken();
      }

      // Mark all NEEDS_AUTH requests as PENDING so they'll be retried
      for (const request of needsAuthRequests) {
        request.status = 'PENDING';
        request.updatedAt = Date.now();
        await db.updateRequest(request);
        console.log(`Marked request ${request.id} as PENDING for retry`);
      }
      
      console.log('NEEDS_AUTH requests marked for retry');
    } catch (error) {
      console.error('Error retrying NEEDS_AUTH requests:', error);
    }
  }

  /**
   * Get next request to process based on priority and dependencies
   * Priority order (lower = higher priority):
   *   0 (CRITICAL): START_RECORDING
   *   1 (HIGH): PRESIGNED_URL, UPLOAD_CHUNK
   *   3 (LOW): COMPLETE_RECORDING
   */
  private async getNextRequest(): Promise<QueuedRequest | null> {
    const pending = await db.getRequestsByStatus('PENDING');
    
    if (pending.length === 0) {
      return null;
    }

    // Sort by priority (lower number = higher priority), then by createdAt
    pending.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.createdAt - b.createdAt;
    });

    // Find first request with no pending dependencies
    for (const request of pending) {
      if (!request.dependencies || request.dependencies.length === 0) {
        console.log(`[QueueManager] Next request: ${request.type} (priority ${request.priority})`);
        return request;
      }

      // Check if all dependencies are completed
      const depStatuses = await Promise.all(
        request.dependencies.map(depId => db.getRequest(depId))
      );

      const allCompleted = depStatuses.every(
        dep => dep && dep.status === 'COMPLETED'
      );

      if (allCompleted) {
        console.log(`[QueueManager] Next request: ${request.type} (priority ${request.priority}, dependencies met)`);
        return request;
      } else {
        const pendingDeps = depStatuses.filter(dep => dep && dep.status !== 'COMPLETED').length;
        console.log(`[QueueManager] Skipping ${request.type} - ${pendingDeps} dependencies not met`);
      }
    }

    return null;
  }

  /**
   * Process next request in queue
   */
  private async processNextRequest() {
    if (!this.isOnline || this.activeOperations >= MAX_CONCURRENT_OPERATIONS) {
      return;
    }

    const request = await this.getNextRequest();
    if (!request) {
      // No more pending requests, stop processing
      if (this.activeOperations === 0) {
        this.stopProcessing();
        await this.notifyStatusChange();
      }
      return;
    }

    this.activeOperations++;

    try {
      // Double-check status to avoid race condition with SW
      const freshRequest = await db.getRequest(request.id);
      if (!freshRequest || freshRequest.status !== 'PENDING') {
        console.log(`[QueueManager] Request ${request.id} status changed to ${freshRequest?.status || 'NOT_FOUND'}, skipping`);
        this.activeOperations--;
        // Try next request
        await this.processNextRequest();
        return;
      }
      
      // Update status to in progress (acts as a lock)
      freshRequest.status = 'IN_PROGRESS';
      freshRequest.updatedAt = Date.now();
      await db.updateRequest(freshRequest);

      // Emit event to process request
      this.emit('process', freshRequest);

      console.log(`Processing ${freshRequest.type} request: ${freshRequest.id}`);

    } catch (error: any) {
      console.error(`Error processing request ${request.id}:`, error);
      await this.handleRequestFailure(request, error);
    }
  }

  /**
   * Mark request as completed
   */
  async markCompleted(requestId: string) {
    const request = await db.getRequest(requestId);
    if (!request) return;

    request.status = 'COMPLETED';
    request.updatedAt = Date.now();
    await db.updateRequest(request);

    console.log(`Request completed: ${requestId}`);

    // Resilience instrumentation (B-dimension upload metrics)
    this.emit('requestCompleted', {
      requestId,
      type: request.type,
      attempts: request.attempts,
      totalTimeMs: Date.now() - request.createdAt
    });

    this.activeOperations--;
    await this.notifyStatusChange();

    // Process next request
    if (this.isProcessing && this.isOnline) {
      await this.processNextRequest();
    }
  }

  /**
   * Mark request as failed and schedule retry
   */
  async markFailed(requestId: string, error: Error) {
    const request = await db.getRequest(requestId);
    if (!request) return;

    await this.handleRequestFailure(request, error);
    this.activeOperations--;
  }

  /**
   * Handle request failure with exponential backoff
   */
  private async handleRequestFailure(request: QueuedRequest, error: Error) {
    request.attempts++;
    request.error = error.message;
    request.updatedAt = Date.now();

    if (request.attempts >= request.maxAttempts) {
      // Max attempts reached, mark as failed
      request.status = 'FAILED';
      console.error(`Request failed after ${request.attempts} attempts: ${request.id}`, error);

      // Resilience instrumentation
      this.emit('requestFailed', {
        requestId: request.id,
        type: request.type,
        attempts: request.attempts,
        error: error.message
      });

      if (this.options.onError) {
        this.options.onError(error);
      }
    } else {
      // Schedule retry with exponential backoff
      request.status = 'PENDING';
      const delay = Math.min(
        INITIAL_RETRY_DELAY * Math.pow(2, request.attempts - 1),
        MAX_RETRY_DELAY
      );

      console.log(`Request failed, retrying in ${delay}ms (attempt ${request.attempts}/${request.maxAttempts}): ${request.id}`);

      // Resilience instrumentation (B2 retry tracking)
      this.emit('requestRetry', {
        requestId: request.id,
        type: request.type,
        attempts: request.attempts,
        delayMs: delay
      });

      // Schedule retry
      setTimeout(() => {
        if (this.isOnline && this.isProcessing) {
          this.processNextRequest();
        }
      }, delay);
    }

    await db.updateRequest(request);
    await this.notifyStatusChange();
  }

  /**
   * Get current queue status
   */
  async getStatus(): Promise<QueueStatus> {
    const [pendingRequests, inProgressRequests, pendingChunks, failedRequests] = await Promise.all([
      db.getRequestsByStatus('PENDING'),
      db.getRequestsByStatus('IN_PROGRESS'),
      db.getChunksByStatus('PENDING'),
      db.getRequestsByStatus('FAILED')
    ]);

    const allChunks = await db.getAllChunks();
    const completedChunks = allChunks.filter(c => c.status === 'COMPLETED');

    return {
      pendingRequests: pendingRequests.length + inProgressRequests.length,
      pendingChunks: pendingChunks.length,
      isProcessing: this.isProcessing,
      failedOperations: failedRequests.length,
      completedChunks: completedChunks.length,
      totalChunks: allChunks.length
    };
  }

  /**
   * Get status for a specific recording session
   */
  async getStatusForRecording(pathIdentifier: string): Promise<QueueStatus> {
    const [allPendingRequests, allInProgressRequests, pendingChunks, allFailedRequests] = await Promise.all([
      db.getRequestsByStatus('PENDING'),
      db.getRequestsByStatus('IN_PROGRESS'),
      db.getChunksByStatus('PENDING'),
      db.getRequestsByStatus('FAILED')
    ]);

    // Filter requests by pathIdentifier in their data
    const pendingRequests = allPendingRequests.filter(r => r.data?.pathIdentifier === pathIdentifier);
    const inProgressRequests = allInProgressRequests.filter(r => r.data?.pathIdentifier === pathIdentifier);
    const failedRequests = allFailedRequests.filter(r => r.data?.pathIdentifier === pathIdentifier);

    // Filter chunks by pathIdentifier
    const sessionChunks = pendingChunks.filter(c => c.pathIdentifier === pathIdentifier);

    // Get all chunks for this recording
    const allChunks = await db.getChunksByPath(pathIdentifier);
    const completedChunks = allChunks.filter(c => c.status === 'COMPLETED');

    return {
      pendingRequests: pendingRequests.length + inProgressRequests.length,
      pendingChunks: sessionChunks.length,
      isProcessing: this.isProcessing,
      failedOperations: failedRequests.length,
      completedChunks: completedChunks.length,
      totalChunks: allChunks.length
    };
  }

  /**
   * Notify status change to listeners
   */
  private async notifyStatusChange() {
    if (this.options.onStatusChange) {
      const status = await this.getStatus();
      this.options.onStatusChange(status);
    }
  }

  /**
   * Wait for all pending operations to complete
   */
  async waitForCompletion(timeoutMs: number = 60000, pathIdentifier?: string): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const status = pathIdentifier 
        ? await this.getStatusForRecording(pathIdentifier)
        : await this.getStatus();
      
      if (status.pendingRequests === 0 && status.pendingChunks === 0) {
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return false;
  }

  /**
   * Cleanup expired and old data
   */
  async cleanup() {
    await db.cleanupExpiredRequests();
    await db.cleanupExpiredPresignedUrls();
    console.log('Cleanup completed');
  }

  /**
   * Clear all data (for testing or reset)
   */
  async clearAll() {
    await db.clearAllData();
    console.log('All queue data cleared');
  }

  /**
   * Destroy the manager and cleanup resources
   */
  destroy() {
    this.stopProcessing();
    this.removeAllListeners();
    window.removeEventListener('online', () => {});
    window.removeEventListener('offline', () => {});
  }
  
  /**
   * Check session and clean up abandoned requests from previous sessions
   */
  async checkSession(): Promise<boolean> {
    try {
      const authProvider = this.options.authProvider;
      if (!authProvider?.validateSession) {
        return true; // No provider wired up: assume the session is valid.
      }

      const isValidSession = await authProvider.validateSession();
      
      if (!isValidSession) {
        console.warn('[QueueManager] Session mismatch detected, clearing old requests');
        // TODO: Clear only requests from old session, not all data
        // For now, just log warning
        await this.notifyStatusChange();
      }
      
      return isValidSession;
    } catch (error) {
      console.error('[QueueManager] Error checking session:', error);
      return true; // Assume valid to avoid blocking
    }
  }
}
