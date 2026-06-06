/**
 * Utilities for storing and retrieving Blobs in IndexedDB
 * Converts Blob <-> ArrayBuffer for efficient storage
 */

import { getDB, STORES } from './db';

export interface StoredBlob {
  id: string;
  data: ArrayBuffer;
  type: string;
  size: number;
  createdAt: number;
}

/**
 * Generate a unique ID for blob storage
 */
export function generateBlobId(pathIdentifier: string, chunkIndex: number): string {
  return `${pathIdentifier}_chunk_${chunkIndex}_${Date.now()}`;
}

/**
 * Store a Blob in IndexedDB
 * @returns The blob ID
 */
export async function storeBlob(id: string, blob: Blob): Promise<string> {
  // Convert Blob to ArrayBuffer first (before opening transaction)
  const arrayBuffer = await blob.arrayBuffer();
  
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.BLOB_STORE], 'readwrite');
    const store = transaction.objectStore(STORES.BLOB_STORE);

    const storedBlob: StoredBlob = {
      id,
      data: arrayBuffer,
      type: blob.type,
      size: blob.size,
      createdAt: Date.now()
    };

    const request = store.put(storedBlob);
    request.onsuccess = () => resolve(id);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retrieve a Blob from IndexedDB
 */
export async function retrieveBlob(id: string): Promise<Blob | null> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.BLOB_STORE], 'readonly');
    const store = transaction.objectStore(STORES.BLOB_STORE);
    const request = store.get(id);

    request.onsuccess = () => {
      const storedBlob = request.result as StoredBlob | undefined;
      if (!storedBlob) {
        resolve(null);
        return;
      }

      // Convert ArrayBuffer back to Blob
      const blob = new Blob([storedBlob.data], { type: storedBlob.type });
      resolve(blob);
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete a Blob from IndexedDB
 */
export async function deleteBlob(id: string): Promise<void> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.BLOB_STORE], 'readwrite');
    const store = transaction.objectStore(STORES.BLOB_STORE);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all blob IDs
 */
export async function getAllBlobIds(): Promise<string[]> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.BLOB_STORE], 'readonly');
    const store = transaction.objectStore(STORES.BLOB_STORE);
    const request = store.getAllKeys();

    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Cleanup old blobs (older than 24 hours)
 */
export async function cleanupOldBlobs(): Promise<number> {
  const db = await getDB();
  const cutoffTime = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.BLOB_STORE], 'readwrite');
    const store = transaction.objectStore(STORES.BLOB_STORE);
    const index = store.index('createdAt');
    const range = IDBKeyRange.upperBound(cutoffTime);
    const request = index.openCursor(range);

    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (cursor) {
        cursor.delete();
        deletedCount++;
        cursor.continue();
      } else {
        resolve(deletedCount);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Get total size of all stored blobs
 */
export async function getTotalBlobSize(): Promise<number> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.BLOB_STORE], 'readonly');
    const store = transaction.objectStore(STORES.BLOB_STORE);
    const request = store.getAll();

    request.onsuccess = () => {
      const blobs = request.result as StoredBlob[];
      const totalSize = blobs.reduce((sum, blob) => sum + blob.size, 0);
      resolve(totalSize);
    };

    request.onerror = () => reject(request.error);
  });
}
