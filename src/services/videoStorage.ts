const DB_NAME = 'autocut_drive_ai_videos_db';
const DB_VERSION = 1;
const STORE_NAME = 'edited_videos';

export const MAX_CACHED_VIDEOS = 10;

export interface StoredVideoRecord {
  id: string;
  blob: Blob;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  savedAt: number;
}

export interface VideoCacheStats {
  count: number;
  totalBytes: number;
  maxItems: number;
}

function isIndexedDbSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openVideoDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbSupported()) {
      reject(new Error('IndexedDB no está disponible en este navegador.'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('No se pudo abrir la caché local de vídeos.'));
  });
}

function getAllRecords(db: IDBDatabase): Promise<StoredVideoRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as StoredVideoRecord[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error('Error leyendo la caché de vídeos.'));
  });
}

/**
 * Saves an edited MP4 Blob into IndexedDB and automatically evicts the oldest
 * cached blobs when exceeding MAX_CACHED_VIDEOS (keeps the latest 10 videos).
 */
export async function saveEditedVideoBlob(
  id: string,
  blob: Blob,
  fileName: string,
  maxItems = MAX_CACHED_VIDEOS
): Promise<{ evictedIds: string[] }> {
  if (!isIndexedDbSupported()) return { evictedIds: [] };

  let db: IDBDatabase | null = null;
  try {
    db = await openVideoDb();
    const record: StoredVideoRecord = {
      id,
      blob,
      fileName,
      sizeBytes: blob.size,
      mimeType: blob.type || 'video/mp4',
      savedAt: Date.now(),
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Smart LRU/FIFO cleanup: keep only the newest `maxItems` videos
    const all = await getAllRecords(db);
    if (all.length <= maxItems) {
      return { evictedIds: [] };
    }

    const sortedDesc = [...all].sort((a, b) => b.savedAt - a.savedAt);
    const toEvict = sortedDesc.slice(maxItems);
    const evictedIds = toEvict.map((entry) => entry.id);

    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const oldId of evictedIds) {
        store.delete(oldId);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return { evictedIds };
  } catch (err) {
    console.warn('[videoStorage] No se pudo guardar el vídeo en IndexedDB:', err);
    return { evictedIds: [] };
  } finally {
    db?.close();
  }
}

export async function getEditedVideoBlob(id: string): Promise<StoredVideoRecord | null> {
  if (!isIndexedDbSupported()) return null;

  let db: IDBDatabase | null = null;
  try {
    db = await openVideoDb();
    return await new Promise<StoredVideoRecord | null>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve((req.result as StoredVideoRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function deleteEditedVideoBlob(id: string): Promise<void> {
  if (!isIndexedDbSupported()) return;

  let db: IDBDatabase | null = null;
  try {
    db = await openVideoDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore cleanup errors
  } finally {
    db?.close();
  }
}

export async function getVideoCacheStats(): Promise<VideoCacheStats> {
  if (!isIndexedDbSupported()) {
    return { count: 0, totalBytes: 0, maxItems: MAX_CACHED_VIDEOS };
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openVideoDb();
    const all = await getAllRecords(db);
    const totalBytes = all.reduce(
      (sum, item) => sum + (item.sizeBytes || item.blob?.size || 0),
      0
    );
    return {
      count: all.length,
      totalBytes,
      maxItems: MAX_CACHED_VIDEOS,
    };
  } catch {
    return { count: 0, totalBytes: 0, maxItems: MAX_CACHED_VIDEOS };
  } finally {
    db?.close();
  }
}

export async function clearAllEditedVideoBlobs(): Promise<void> {
  if (!isIndexedDbSupported()) return;

  let db: IDBDatabase | null = null;
  try {
    db = await openVideoDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[videoStorage] Error al vaciar IndexedDB:', err);
  } finally {
    db?.close();
  }
}
