import { createStore, del, get, keys, set } from 'idb-keyval';

const store = createStore('montaj-v2', 'media');
const urlCache = new Map<string, string>();

export async function saveFile(id: string, file: File): Promise<void> {
  await set(id, file, store);
}

export async function getFile(id: string): Promise<File | null> {
  const v = await get<File>(id, store);
  return v ?? null;
}

export async function deleteFile(id: string): Promise<void> {
  const url = urlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(id);
  }
  await del(id, store);
}

export async function listIds(): Promise<string[]> {
  return (await keys(store)) as string[];
}

export function getOrCreateObjectUrl(id: string, file: File): string {
  const existing = urlCache.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(file);
  urlCache.set(id, url);
  return url;
}

export function revokeObjectUrl(id: string): void {
  const url = urlCache.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  urlCache.delete(id);
}

export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function checkQuota(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}
