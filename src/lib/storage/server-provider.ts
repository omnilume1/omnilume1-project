import 'server-only';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
  readonly name: 'supabase' | 'r2';
  readonly supportsResumableUpload: false;
  upload(bucket: string, path: string, file: File): Promise<StorageObjectMetadata>;
  createSignedDownloadUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string>;
  createSignedUploadUrl?(bucket: string, path: string, contentType: string): Promise<string>;
  openRangeReader(bucket: string, path: string): Promise<StorageRangeReader>;
  delete(bucket: string, path: string): Promise<void>;
  getMetadata(bucket: string, path: string): Promise<StorageObjectMetadata | null>;
  exists(bucket: string, path: string): Promise<boolean>;
  list(bucket: string, prefix: string): Promise<string[]>;
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

  async list(bucket: string, prefix: string) {
    const paths: string[] = [];
    const walk = async (directory: string) => {
      let offset = 0;
      while (true) {
        const admin = createAdminClient();
        const { data, error } = await admin.storage.from(bucket).list(directory, { limit: 1000, offset });
        if (error) throw new Error(error.message);
        const entries = data ?? [];
        for (const entry of entries) {
          const path = directory ? `${directory}/${entry.name}` : entry.name;
          if (entry.id) paths.push(path);
          else await walk(path);
        }
        if (entries.length < 1000) break;
        offset += entries.length;
      }
    };
    await walk(prefix);
    return paths;
  }

  async cleanup(bucket: string, paths: string[]) {
    if (paths.length === 0) return;
    const admin = createAdminClient();
    const { error } = await admin.storage.from(bucket).remove(paths);
    if (error) throw new Error(error.message);
  }
}

type R2Config = {
  bucket: string;
  client: S3Client;
};

function getR2Config(): R2Config | null {
  const values = [
    process.env.R2_ACCOUNT_ID,
    process.env.R2_BUCKET_NAME,
    process.env.R2_ACCESS_KEY_ID,
    process.env.R2_SECRET_ACCESS_KEY,
  ];
  const configured = values.some(Boolean);
  if (!configured) return null;
  if (values.some((value) => !value)) {
    throw new Error('R2 storage is partially configured. Set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.');
  }

  const [accountId, bucket, accessKeyId, secretAccessKey] = values as [string, string, string, string];
  return {
    bucket,
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

function r2Key(bucket: string, path: string) {
  if (!bucket || !path || path.startsWith('/') || path.includes('..')) throw new Error('Invalid storage path.');
  return `${bucket}/${path}`;
}

function isMissingObject(error: unknown) {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return candidate?.name === 'NotFound' || candidate?.name === 'NoSuchKey' || candidate?.$metadata?.httpStatusCode === 404;
}

class R2StorageProvider implements ServerStorageProvider {
  readonly name = 'r2' as const;
  readonly supportsResumableUpload = false as const;
  private readonly legacyStorage = new SupabaseStorageProvider();

  constructor(private readonly config: R2Config) {}

  async upload(bucket: string, path: string, file: File) {
    const key = r2Key(bucket, path);
    await this.config.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: new Uint8Array(await file.arrayBuffer()),
      ContentLength: file.size,
      ContentType: file.type || 'application/octet-stream',
      CacheControl: '3600',
    }));
    const metadata = await this.getMetadata(bucket, path);
    if (!metadata) throw new Error('Storage did not return uploaded file metadata.');
    return metadata;
  }

  async createSignedDownloadUrl(bucket: string, path: string, expiresInSeconds: number) {
    if (!(await this.r2Metadata(bucket, path))) {
      return this.legacyStorage.createSignedDownloadUrl(bucket, path, expiresInSeconds);
    }
    const command = new GetObjectCommand({ Bucket: this.config.bucket, Key: r2Key(bucket, path) });
    return getSignedUrl(this.config.client, command, { expiresIn: Math.max(1, Math.min(3600, expiresInSeconds)) });
  }

  async createSignedUploadUrl(bucket: string, path: string, contentType: string) {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: r2Key(bucket, path),
      ContentType: contentType,
    });
    return getSignedUrl(this.config.client, command, { expiresIn: 300 });
  }

  async openRangeReader(bucket: string, path: string): Promise<StorageRangeReader> {
    if (!(await this.r2Metadata(bucket, path))) return this.legacyStorage.openRangeReader(bucket, path);
    return async (start: number, endInclusive: number) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start || endInclusive - start + 1 > MAX_STORAGE_RANGE_BYTES) {
        throw new Error('Invalid byte range.');
      }
      const response = await this.config.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: r2Key(bucket, path),
        Range: `bytes=${start}-${endInclusive}`,
      }));
      if (!response.Body) throw new Error('Unable to read the stored file.');
      const bytes = await response.Body.transformToByteArray();
      return bytes.subarray(0, endInclusive - start + 1);
    };
  }

  async delete(bucket: string, path: string) {
    await this.cleanup(bucket, [path]);
  }

  async getMetadata(bucket: string, path: string) {
    const metadata = await this.r2Metadata(bucket, path);
    return metadata ?? this.legacyStorage.getMetadata(bucket, path);
  }

  private async r2Metadata(bucket: string, path: string): Promise<StorageObjectMetadata | null> {
    try {
      const result = await this.config.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: r2Key(bucket, path) }));
      return {
        path,
        size: typeof result.ContentLength === 'number' ? result.ContentLength : null,
        mimeType: typeof result.ContentType === 'string' ? result.ContentType.toLowerCase() : null,
        updatedAt: result.LastModified?.toISOString() ?? null,
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async exists(bucket: string, path: string) {
    return (await this.getMetadata(bucket, path)) !== null;
  }

  async list(bucket: string, prefix: string) {
    const keyPrefix = `${bucket}/${prefix ? `${prefix.replace(/\/$/, '')}/` : ''}`;
    const paths: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.config.client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: keyPrefix,
        ContinuationToken: continuationToken,
      }));
      for (const item of result.Contents ?? []) {
        if (item.Key?.startsWith(`${bucket}/`)) paths.push(item.Key.slice(bucket.length + 1));
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    const legacyPaths = await this.legacyStorage.list(bucket, prefix);
    return [...new Set([...paths, ...legacyPaths])];
  }

  async cleanup(bucket: string, paths: string[]) {
    if (paths.length === 0) return;
    for (let index = 0; index < paths.length; index += 1000) {
      const result = await this.config.client.send(new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: { Objects: paths.slice(index, index + 1000).map((path) => ({ Key: r2Key(bucket, path) })) },
      }));
      if (result.Errors?.length) throw new Error('Unable to remove one or more R2 objects.');
    }
    await this.legacyStorage.cleanup(bucket, paths);
  }
}

let provider: ServerStorageProvider | undefined;

// This provider boundary is deliberately server-only. R2 is selected when all
// four R2 variables are present; otherwise Supabase remains the local fallback.
export function getServerStorageProvider(): ServerStorageProvider {
  provider ??= (() => {
    const config = getR2Config();
    return config ? new R2StorageProvider(config) : new SupabaseStorageProvider();
  })();
  return provider;
}
