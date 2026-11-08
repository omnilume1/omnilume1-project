-- Shared cache for /api/media/search results.
--
-- YouTube search costs 100 quota units a call (about 100 searches a day), and
-- an in-memory cache per server instance is empty after every cold start. This
-- table is shared by all instances so a repeated query never spends quota.
--
-- Same contract as temporary_media metadata: clients get no access at all
-- (RLS on, no policies, privileges revoked); only the server (service role)
-- reads and writes it, through two RPCs.

CREATE TABLE IF NOT EXISTS public.media_search_cache (
  cache_key text PRIMARY KEY,
  results jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_search_cache_key_check CHECK (char_length(cache_key) BETWEEN 3 AND 300),
  CONSTRAINT media_search_cache_results_check CHECK (jsonb_typeof(results) = 'array' AND octet_length(results::text) <= 262144)
);

ALTER TABLE public.media_search_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.media_search_cache FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_media_search_cache(p_key text, p_max_age_seconds integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT results FROM public.media_search_cache
  WHERE cache_key = p_key
    AND created_at > now() - make_interval(secs => GREATEST(p_max_age_seconds, 0));
$$;

CREATE OR REPLACE FUNCTION public.put_media_search_cache(p_key text, p_results jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_key IS NULL OR p_results IS NULL THEN
    RAISE EXCEPTION 'Invalid search cache entry.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.media_search_cache (cache_key, results, created_at)
  VALUES (p_key, p_results, now())
  ON CONFLICT (cache_key) DO UPDATE SET results = EXCLUDED.results, created_at = EXCLUDED.created_at;
  -- Keep the table small: drop anything a day old.
  DELETE FROM public.media_search_cache WHERE created_at < now() - interval '1 day';
END;
$$;

REVOKE ALL ON FUNCTION public.get_media_search_cache(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.put_media_search_cache(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_media_search_cache(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.put_media_search_cache(text, jsonb) TO service_role;
