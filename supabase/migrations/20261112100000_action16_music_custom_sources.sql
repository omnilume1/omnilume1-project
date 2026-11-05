-- Action 16 Stage 4: user-added custom sources (decision 9). Additive only.
--
-- A source is an HTTPS JSON manifest that implements OmniLume's contract
-- (search → tracks with a direct audio URL). The server never fetches these
-- URLs: the browser calls them, so there is no server-side request to abuse.
-- Rows are owner-only; tracks from a source never become uploads, so they
-- cannot be shared, put in Listen Together, presence or history (all of those
-- are keyed on music_uploads). OmniLume ships no sources.
--
-- URL rule (inline CHECKs, so no helper needs an EXECUTE grant): https:// with
-- no user-info, or http:// on localhost/127.0.0.1 for local development.

CREATE TABLE IF NOT EXISTS public.music_custom_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  manifest_url text NOT NULL CHECK (
    char_length(manifest_url) <= 500
    AND (manifest_url ~ '^https://[^/@\s]+(/\S*)?$' OR manifest_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/\S*)?$')
  ),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  search_url text NOT NULL CHECK (
    char_length(search_url) <= 500 AND position('{query}' IN search_url) > 0
    AND (search_url ~ '^https://[^/@\s]+(/\S*)?$' OR search_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/\S*)?$')
  ),
  health_url text CHECK (
    health_url IS NULL OR (
      char_length(health_url) <= 500
      AND (health_url ~ '^https://[^/@\s]+(/\S*)?$' OR health_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/\S*)?$')
    )
  ),
  enabled boolean NOT NULL DEFAULT true,
  -- "I am responsible for what I play from this source" must be ticked to add it.
  responsibility_accepted boolean NOT NULL CHECK (responsibility_accepted),
  last_status text CHECK (last_status IN ('ok', 'error')),
  last_message text CHECK (char_length(last_message) <= 200),
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, manifest_url)
);

ALTER TABLE public.music_custom_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.music_custom_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.music_custom_sources TO authenticated;
GRANT UPDATE (name, search_url, health_url, enabled, last_status, last_message, last_checked_at)
  ON TABLE public.music_custom_sources TO authenticated;

DROP POLICY IF EXISTS "Owners manage their custom sources" ON public.music_custom_sources;
CREATE POLICY "Owners manage their custom sources" ON public.music_custom_sources FOR ALL TO authenticated
USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- At most 10 sources per account.
CREATE OR REPLACE FUNCTION public.music_custom_sources_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (SELECT count(*) FROM public.music_custom_sources s WHERE s.owner_id = NEW.owner_id) >= 10 THEN
    RAISE EXCEPTION 'You can add up to 10 sources.' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.music_custom_sources_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.music_custom_sources_limit() TO authenticated, service_role;
DROP TRIGGER IF EXISTS music_custom_sources_limit ON public.music_custom_sources;
CREATE TRIGGER music_custom_sources_limit BEFORE INSERT ON public.music_custom_sources
FOR EACH ROW EXECUTE FUNCTION public.music_custom_sources_limit();
