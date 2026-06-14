import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface RecordingMeta {
  id: string;
  camId: string;
  name: string;
  date: string;
  time: string;
  startTs: number;
  endTs: number;
  size: number;
  mimeType: string;
  chunkCount: number;
}

interface ChunkRecord {
  id: string;
  recordingId: string;
  index: number;
  data: Blob;
}

interface CctvDB extends DBSchema {
  recordings: {
    key: string;
    value: RecordingMeta;
    indexes: { 'by-date': string; 'by-cam': string };
  };
  chunks: {
    key: string;
    value: ChunkRecord;
    indexes: { 'by-recording': string };
  };
}

const DB_NAME = 'cctv-rd-v1';
const RETENTION_DAYS = 10;

let dbPromise: Promise<IDBPDatabase<CctvDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<CctvDB>(DB_NAME, 1, {
      upgrade(db) {
        const recStore = db.createObjectStore('recordings', { keyPath: 'id' });
        recStore.createIndex('by-date', 'date');
        recStore.createIndex('by-cam', 'camId');
        const chunkStore = db.createObjectStore('chunks', { keyPath: 'id' });
        chunkStore.createIndex('by-recording', 'recordingId');
      },
    });
  }
  return dbPromise;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function makeRecordingName(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function saveChunk(
  recordingId: string,
  index: number,
  data: Blob,
): Promise<void> {
  const db = await getDB();
  await db.put('chunks', {
    id: `${recordingId}_${index}`,
    recordingId,
    index,
    data,
  });
}

export async function finalizeRecording(
  meta: Omit<RecordingMeta, 'size' | 'chunkCount'>,
): Promise<RecordingMeta> {
  const db = await getDB();
  const chunks = await db.getAllFromIndex('chunks', 'by-recording', meta.id);
  const totalSize = chunks.reduce((sum, c) => sum + c.data.size, 0);
  const full: RecordingMeta = {
    ...meta,
    size: totalSize,
    chunkCount: chunks.length,
  };
  await db.put('recordings', full);
  return full;
}

export async function listRecordings(camId?: string): Promise<RecordingMeta[]> {
  const db = await getDB();
  const all = await db.getAll('recordings');
  const filtered = camId ? all.filter((r) => r.camId === camId) : all;
  return filtered.sort((a, b) => b.startTs - a.startTs);
}

export async function getRecordingBlob(id: string): Promise<Blob | null> {
  const db = await getDB();
  const meta = await db.get('recordings', id);
  if (!meta) return null;
  const chunks = await db.getAllFromIndex('chunks', 'by-recording', id);
  chunks.sort((a, b) => a.index - b.index);
  if (!chunks.length) return null;
  return new Blob(
    chunks.map((c) => c.data),
    { type: meta.mimeType || 'video/webm' },
  );
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await getDB();
  const chunks = await db.getAllFromIndex('chunks', 'by-recording', id);
  const tx = db.transaction(['recordings', 'chunks'], 'readwrite');
  await tx.objectStore('recordings').delete(id);
  for (const c of chunks) {
    await tx.objectStore('chunks').delete(c.id);
  }
  await tx.done;
}

export async function getStorageEstimate(): Promise<{
  used: number;
  quota: number;
  percent: number;
}> {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    const used = est.usage ?? 0;
    const quota = est.quota ?? 0;
    return {
      used,
      quota,
      percent: quota > 0 ? Math.round((used / quota) * 1000) / 10 : 0,
    };
  }
  const recs = await listRecordings();
  const used = recs.reduce((s, r) => s + r.size, 0);
  return { used, quota: 0, percent: 0 };
}

export async function cleanupOldRecordings(): Promise<number> {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const recs = await listRecordings();
  let removed = 0;
  for (const r of recs) {
    if (r.startTs < cutoff) {
      await deleteRecording(r.id);
      removed++;
    }
  }
  return removed;
}

export async function exportRecording(id: string, filename: string): Promise<void> {
  const blob = await getRecordingBlob(id);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.webm') ? filename : `${filename}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

export { RETENTION_DAYS };
