import type { SupabaseClient } from '@supabase/supabase-js';

export interface StorageUploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface StorageUploadTask {
  promise: Promise<{ path: string }>;
  cancel: () => void;
  supportsCancellation: boolean;
}

function uploadBody(file: Blob, contentType?: string) {
  if (!contentType || file.type === contentType) return file;
  return new Blob([file], { type: contentType });
}

/** Upload through the authenticated server route so storage credentials stay server-only. */
export function startUploadFileWithProgress(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  file: Blob,
  onProgress?: (progress: StorageUploadProgress) => void,
  contentType?: string,
): StorageUploadTask {
  void supabase;
  const body = uploadBody(file, contentType);
  const fileName = typeof File !== 'undefined' && file instanceof File ? file.name : 'upload.bin';
  if (typeof XMLHttpRequest === 'undefined') {
    return {
      supportsCancellation: false,
      cancel: () => undefined,
      promise: (async () => {
        const formData = new FormData();
        formData.append('bucket', bucket);
        formData.append('path', path);
        formData.append('file', body, fileName);
        const response = await fetch('/api/storage/upload', { method: 'POST', body: formData, credentials: 'include' });
        const result = (await response.json().catch(() => ({}))) as { path?: string; error?: string };
        if (!response.ok || !result.path) throw new Error(result.error ?? `Upload failed (${response.status}).`);
        onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
        return { path: result.path };
      })(),
    };
  }

  let request: XMLHttpRequest | undefined;
  const promise = new Promise<{ path: string }>((resolve, reject) => {
      request = new XMLHttpRequest();
      request.open('POST', '/api/storage/upload');
      request.withCredentials = true;

      request.upload.addEventListener('progress', (event) => {
        const total = event.lengthComputable ? event.total : file.size;
        const ratio = total > 0 ? Math.min(1, event.loaded / total) : 0;
        const loaded = Math.min(file.size, Math.round(ratio * file.size));
        onProgress?.({ loaded, total, percent: Math.min(100, Math.round(ratio * 100)) });
      });

      request.addEventListener('load', () => {
        let result: { path?: string; error?: string } = {};
        try { result = JSON.parse(request?.responseText ?? '') as { path?: string; error?: string }; } catch { /* status fallback */ }
        if (request && request.status >= 200 && request.status < 300 && result.path) {
          onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
          resolve({ path: result.path });
          return;
        }
        reject(new Error(result.error ?? `Upload failed (${request?.status ?? 0}).`));
      });
      request.addEventListener('error', () => reject(new Error('Network error while uploading.')));
      request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
      const formData = new FormData();
      formData.append('bucket', bucket);
      formData.append('path', path);
      formData.append('file', body, fileName);
      request.send(formData);
    });

  return { promise, cancel: () => request?.abort(), supportsCancellation: true };
}

export async function uploadFileWithProgress(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  file: Blob,
  onProgress?: (progress: StorageUploadProgress) => void,
  contentType?: string,
) {
  return startUploadFileWithProgress(supabase, bucket, path, file, onProgress, contentType).promise;
}
