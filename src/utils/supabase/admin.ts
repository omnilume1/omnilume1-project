import 'server-only';

import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from '@supabase/supabase-js';

type AdminDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    // Deliberately narrow: the public RPCs the service role calls from app
    // code. Action 10 caches media metadata the server read from the stored
    // file itself; Action 16 registers a music upload after the server sniffed
    // its first bytes, and finalises deletes after removing the objects.
    Functions: {
      get_media_search_cache: {
        Args: { p_key: string; p_max_age_seconds: number };
        Returns: unknown;
      };
      put_media_search_cache: {
        Args: { p_key: string; p_results: unknown };
        Returns: undefined;
      };
      cache_temporary_media_metadata: {
        Args: { p_media_id: string; p_room_id: string; p_metadata: Record<string, unknown> };
        Returns: boolean;
      };
      register_music_upload: {
        Args: {
          p_owner_id: string; p_upload_id: string; p_ext: string; p_mime_type: string; p_original_name: string;
          p_title: string; p_artist: string; p_album: string; p_album_artist: string; p_track_no: number | null;
          p_year: number | null; p_genre: string; p_duration_ms: number | null; p_hue: number; p_lyrics: string;
          p_has_cover: boolean;
        };
        Returns: { id: string; expires_at: string };
      };
      complete_music_upload_cleanup: {
        Args: { p_upload_id: string; p_error: string | null };
        Returns: undefined;
      };
      // Push notifications: who gets one for an event, and removing dead or stale devices.
      push_deliveries: {
        Args: { p_kind: string; p_id: string };
        Returns: Array<Record<string, unknown>>;
      };
      prune_push_subscription: {
        Args: { p_endpoint: string };
        Returns: undefined;
      };
      prune_stale_push_subscriptions: {
        Args: { p_days: number };
        Returns: number;
      };
    };
  };
  storage: {
    Tables: {
      objects: {
        Row: { bucket_id: string; name: string; owner_id: string | null };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};

let adminClient: SupabaseClient<AdminDatabase> | undefined;

export function createAdminClient() {
  if (adminClient) return adminClient;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Server administration is not configured.');
  }

  adminClient = createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  return adminClient;
}
