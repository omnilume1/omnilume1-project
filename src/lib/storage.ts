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

function encodeStoragePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Request a short-lived upload authorization, then upload directly to the selected private store. */
export function startUploadFileWithProgress(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  file: Blob,
  onProgress?: (progress: StorageUploadProgress) => void,
  contentType?: string,
): StorageUploadTask {
  const fileName = typeof File !== 'undefined' && file instanceof File ? file.name : 'upload.bin';
  const body = uploadBody(file, contentType);
  let request: XMLHttpRequest | undefined;
  const promise = (async () => {
    const sessionResult = await supabase.auth.getSession();
    if (sessionResult.error) throw sessionResult.error;
    const session = sessionResult.data.session;
    if (!session?.access_token) throw new Error('Your session has expired. Please sign in again.');

    const intentResponse = await fetch('/api/storage/upload', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket, path, fileName, contentType: body.type || contentType || 'application/octet-stream', size: file.size }),
    });
    const intent = (await intentResponse.json().catch(() => ({}))) as {
      provider?: 'r2' | 'supabase'; uploadUrl?: string; contentType?: string; error?: string;
    };
    if (!intentResponse.ok || !intent.provider) throw new Error(intent.error ?? `Upload could not start (${intentResponse.status}).`);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (intent.provider === 'supabase' && (!supabaseUrl || !supabaseKey)) {
      throw new Error('Storage is not configured.');
    }
    if (intent.provider === 'r2' && !intent.uploadUrl) throw new Error('R2 did not return an upload URL.');
    if (typeof XMLHttpRequest === 'undefined') {
      let uploadResponse: Response;
      if (intent.provider === 'r2') {
        uploadResponse = await fetch(intent.uploadUrl!, {
          method: 'PUT',
          headers: { 'Content-Type': intent.contentType ?? body.type },
          body,
        });
      } else {
        const formData = new FormData();
        formData.append('cacheControl', '3600');
        formData.append('', body, fileName);
        uploadResponse = await fetch(`${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}`, apikey: supabaseKey!, 'x-upsert': 'false' },
          body: formData,
        });
      }
      if (!uploadResponse.ok) throw new Error(`Upload failed (${uploadResponse.status}).`);
      onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
      return { path };
    }

    return new Promise<{ path: string }>((resolve, reject) => {
      request = new XMLHttpRequest();
      let uploadPayload: XMLHttpRequestBodyInit = body;
      if (intent.provider === 'r2') {
        request.open('PUT', intent.uploadUrl!);
        request.setRequestHeader('Content-Type', intent.contentType ?? body.type);
      } else {
        const encodedPath = encodeStoragePath(path);
        request.open('POST', `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`);
        request.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
        request.setRequestHeader('apikey', supabaseKey!);
        request.setRequestHeader('x-upsert', 'false');
        const formData = new FormData();
        formData.append('cacheControl', '3600');
        formData.append('', body, fileName);
        uploadPayload = formData;
      }

      request.upload.addEventListener('progress', (event) => {
        const total = event.lengthComputable ? event.total : file.size;
        const ratio = total > 0 ? Math.min(1, event.loaded / total) : 0;
        const loaded = Math.min(file.size, Math.round(ratio * file.size));
        onProgress?.({ loaded, total, percent: Math.min(100, Math.round(ratio * 100)) });
      });
      request.addEventListener('load', () => {
        if (request && request.status >= 200 && request.status < 300) {
          onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
          resolve({ path });
          return;
        }
        reject(new Error(`Upload failed (${request?.status ?? 0}).`));
      });
      request.addEventListener('error', () => reject(new Error('Network error while uploading.')));
      request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
      request.send(uploadPayload);
    });
  })();

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
