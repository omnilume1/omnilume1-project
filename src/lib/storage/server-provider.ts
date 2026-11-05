import 'server-only';

import { createAdminClient } from '@/utils/supabase/admin';

export type StorageObjectMetadata = {
  path: string;
  size: number | null;
  mimeType: string | null;
  updatedAt: string | null;
};

// Reads inclusive byte ranges of one stored object (for example to parse a
// media file's embedded tags without downloading all of it).
export type StorageRangeReader = (start: number, endInclusive: number) => Promise<Uint8Array>;

// Largest single range a reader returns.
export const MAX_STORAGE_RANGE_BYTES = 4 * 1024 * 1024 + 64;

export interface ServerStorageProvider {
  readonly name: 'supabase';
  readonly supportsResumableUpload: false;
  upload(bucket: string, path: string, file: File): Promise<StorageObjectMetadata>;
  createSignedDownloadUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string>;
  openRangeReader(bucket: string, path: string): Promise<StorageRangeReader>;
  delete(bucket: string, path: string): Promise<void>;
  getMetadata(bucket: string, path: string): Promise<StorageObjectMetadata | null>;
  exists(bucket: string, path: string): Promise<boolean>;
  cleanup(bucket: string, paths: string[]): Promise<void>;
}

function parentAndName(path: string) {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex === -1
    ? { parent: '', name: path }
    : { parent: path.slice(0, slashIndex), name: path.slice(slashIndex + 1) };
}

function toMetadata(path: string, row: { name: string; updated_at?: string | null; metadata?: unknown }): StorageObjectMetadata {
  const metadata = row.metadata && typeof row.metadata === 'object'
    ? row.metadata as Record<string, unknown>
    : {};
  return {
    path,
    size: typeof metadata.size === 'number' ? metadata.size : null,
    mimeType: typeof metadata.mimetype === 'string' ? metadata.mimetype.toLowerCase() : null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

class SupabaseStorageProvider implements ServerStorageProvider {
  readonly name = 'supabase' as const;
  readonly supportsResumableUpload = false as const;

  async upload(bucket: string, path: string, file: File) {
    const admin = createAdminClient();
    const { error } = await admin.storage.from(bucket).upload(path, file, {
      cacheControl: '3600',
      contentType: file.type,
      upsert: false,
    });
    if (error) throw new Error(error.message);
    const metadata = await this.getMetadata(bucket, path);
    if (!metadata) throw new Error('Storage did not return uploaded file metadata.');
    return metadata;
  }

  async createSignedDownloadUrl(bucket: string, path: string, expiresInSeconds: number) {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
    if (error || !data?.signedUrl) throw new Error(error?.message || 'Unable to create a private download URL.');
    return data.signedUrl;
  }

  // Provider-neutral: a short-lived signed URL plus standard HTTP Range
  // requests, which any object store with signed URLs supports.
  async openRangeReader(bucket: string, path: string): Promise<StorageRangeReader> {
    const url = await this.createSignedDownloadUrl(bucket, path, 120);
    return async (start: number, endInclusive: number) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start || endInclusive - start + 1 > MAX_STORAGE_RANGE_BYTES) {
        throw new Error('Invalid byte range.');
      }
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${endInclusive}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 206 && response.status !== 200) throw new Error('Unable to read the stored file.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      // A server that ignores Range returns the whole object.
      return response.status === 200 ? bytes.subarray(start, endInclusive + 1) : bytes.subarray(0, endInclusive - start + 1);
    };
  }

  async delete(bucket: string, path: string) {
    await this.cleanup(bucket, [path]);
  }

  async getMetadata(bucket: string, path: string) {
    const admin = createAdminClient();
    const { parent, name } = parentAndName(path);
    const { data, error } = await admin.storage.from(bucket).list(parent, {
      limit: 100,
      search: name,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(error.message);
    const row = (data ?? []).find((entry) => entry.name === name && entry.id);
    return row ? toMetadata(path, row) : null;
  }

  async exists(bucket: string, path: string) {
    return (await this.getMetadata(bucket, path)) !== null;
  }

  async cleanup(bucket: string, paths: string[]) {
    if (paths.length === 0) return;
    const admin = createAdminClient();
    const { error } = await admin.storage.from(bucket).remove(paths);
    if (error) throw new Error(error.message);
  }
}

let provider: ServerStorageProvider | undefined;

// This provider boundary is deliberately server-only. A future R2 adapter can
// satisfy the same contract without exposing credentials or changing room UI.
export function getServerStorageProvider(): ServerStorageProvider {
  provider ??= new SupabaseStorageProvider();
  return provider;
}
