import 'server-only';

import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from '@supabase/supabase-js';

type AdminDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    // Deliberately narrow: the only public RPC the service role calls from
    // app code caches media metadata the server read from the stored file
    // itself (Action 10; clients cannot write temporary_media).
    Functions: {
      cache_temporary_media_metadata: {
        Args: { p_media_id: string; p_room_id: string; p_metadata: Record<string, unknown> };
        Returns: boolean;
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
