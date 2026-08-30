import type { SupabaseClient } from '@supabase/supabase-js';

export interface StorageUploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

function encodeStoragePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Supabase's browser upload helper resolves only after completion. XHR gives
 * the upload screen a real byte-level progress signal while still using the
 * authenticated Supabase storage endpoint.
 */
export async function uploadFileWithProgress(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  file: Blob,
  onProgress?: (progress: StorageUploadProgress) => void,
) {
  if (typeof XMLHttpRequest === 'undefined') {
    const { data, error } = await supabase.storage.from(bucket).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
    });
    if (error) throw error;
    onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
    return data;
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const accessToken = sessionData.session?.access_token;
  if (!supabaseUrl || !supabaseKey || !accessToken) {
    throw new Error('Your session has expired. Please sign in again.');
  }

  return await new Promise<{ path: string }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const encodedPath = encodeStoragePath(path);
    request.open('POST', `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`);
    request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    request.setRequestHeader('apikey', supabaseKey);
    request.setRequestHeader('x-upsert', 'false');

    request.upload.addEventListener('progress', (event) => {
      const total = event.lengthComputable ? event.total : file.size;
      const ratio = total > 0 ? Math.min(1, event.loaded / total) : 0;
      const loaded = Math.min(file.size, Math.round(ratio * file.size));
      onProgress?.({
        loaded,
        total,
        percent: Math.min(100, Math.round(ratio * 100)),
      });
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
        resolve({ path });
        return;
      }

      let message = `Upload failed (${request.status}).`;
      try {
        const response = JSON.parse(request.responseText) as { message?: string; error?: string };
        message = response.message || response.error || message;
      } catch {
        // Keep the useful status fallback when the storage response is not JSON.
      }
      reject(new Error(message));
    });
    request.addEventListener('error', () => reject(new Error('Network error while uploading.')));
    request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    const formData = new FormData();
    formData.append('cacheControl', '3600');
    formData.append('', file);
    request.send(formData);
  });
}
