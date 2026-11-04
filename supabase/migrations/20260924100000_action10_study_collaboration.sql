-- Action 10: additive, server-authorized Study collaboration persistence.
-- This migration does not alter Actions 01-09 tables, storage objects, or policies.

CREATE TABLE public.study_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('room', 'personal')),
  title text NOT NULL DEFAULT 'Untitled note' CHECK (char_length(title) BETWEEN 1 AND 160),
  content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 100000),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX study_notes_room_updated_idx ON public.study_notes(room_id, updated_at DESC);
CREATE INDEX study_notes_owner_updated_idx ON public.study_notes(owner_id, updated_at DESC);

CREATE TABLE public.pdf_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES public.room_files(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number > 0 AND page_number <= 100000),
  position jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(position) = 'object' AND octet_length(convert_to(position::text, 'UTF8')) <= 10000),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pdf_annotations_file_page_idx ON public.pdf_annotations(file_id, page_number, created_at);

CREATE TABLE public.room_whiteboards (
  room_id uuid PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
  state jsonb NOT NULL DEFAULT '{"dataUrl":null}'::jsonb CHECK (jsonb_typeof(state) = 'object' AND octet_length(convert_to(state::text, 'UTF8')) <= 524288),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.study_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pdf_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_whiteboards ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.study_notes, public.pdf_annotations, public.room_whiteboards FROM PUBLIC, anon, authenticated;

CREATE POLICY "Study members read scoped notes" ON public.study_notes FOR SELECT TO authenticated
USING (
  public.room_has_capability(room_id, auth.uid(), 'study')
  AND (scope = 'room' OR owner_id = auth.uid())
);

CREATE POLICY "Study members read PDF annotations" ON public.pdf_annotations FOR SELECT TO authenticated
USING (
  public.room_has_capability(room_id, auth.uid(), 'study')
  AND public.room_has_capability(room_id, auth.uid(), 'files')
);

CREATE POLICY "Study members read whiteboards" ON public.room_whiteboards FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'study'));

CREATE OR REPLACE FUNCTION public.create_study_note(
  p_room_id uuid,
  p_scope text,
  p_title text DEFAULT 'Untitled note',
  p_content text DEFAULT ''
)
RETURNS public.study_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study')
     OR p_scope NOT IN ('room', 'personal')
     OR char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 160
     OR char_length(COALESCE(p_content, '')) > 100000 THEN
    RAISE EXCEPTION 'Invalid or unauthorized study note.';
  END IF;

  INSERT INTO public.study_notes(room_id, owner_id, scope, title, content)
  VALUES (p_room_id, auth.uid(), p_scope, btrim(p_title), COALESCE(p_content, ''))
  RETURNING * INTO note_row;
  RETURN note_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_study_notes(p_room_id uuid)
RETURNS SETOF public.study_notes
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to view study notes.';
  END IF;

  RETURN QUERY
  SELECT sn.* FROM public.study_notes sn
  WHERE sn.room_id = p_room_id AND (sn.scope = 'room' OR sn.owner_id = auth.uid())
  ORDER BY sn.updated_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_study_note(
  p_note_id uuid,
  p_expected_version bigint,
  p_title text,
  p_content text
)
RETURNS public.study_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  SELECT * INTO note_row FROM public.study_notes sn WHERE sn.id = p_note_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT public.room_has_capability(note_row.room_id, auth.uid(), 'study')
     OR (note_row.scope = 'personal' AND note_row.owner_id <> auth.uid())
     OR p_expected_version IS NULL OR p_expected_version <> note_row.version
     OR char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 160
     OR char_length(COALESCE(p_content, '')) > 100000 THEN
    RAISE EXCEPTION 'Study note update rejected: expected version does not match or access is denied.';
  END IF;

  UPDATE public.study_notes
  SET title = btrim(p_title), content = COALESCE(p_content, ''), version = version + 1, updated_at = now()
  WHERE id = p_note_id
  RETURNING * INTO note_row;
  RETURN note_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_study_note(p_note_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  SELECT * INTO note_row FROM public.study_notes sn WHERE sn.id = p_note_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(note_row.room_id, auth.uid(), 'study')
     OR NOT (
       note_row.owner_id = auth.uid()
       OR (note_row.scope = 'room' AND public.is_room_admin_or_owner(note_row.room_id, auth.uid()))
     ) THEN
    RAISE EXCEPTION 'Not authorized to delete this study note.';
  END IF;
  DELETE FROM public.study_notes WHERE id = p_note_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_pdf_annotations(p_file_id uuid)
RETURNS SETOF public.pdf_annotations
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE file_row public.room_files%ROWTYPE;
BEGIN
  SELECT * INTO file_row FROM public.room_files rf WHERE rf.id = p_file_id AND rf.deleted_at IS NULL;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'study')
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'files') THEN
    RAISE EXCEPTION 'Not authorized to view PDF annotations.';
  END IF;
  RETURN QUERY SELECT pa.* FROM public.pdf_annotations pa WHERE pa.file_id = p_file_id ORDER BY pa.page_number, pa.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_pdf_annotation(
  p_file_id uuid,
  p_page_number integer,
  p_position jsonb,
  p_content text
)
RETURNS public.pdf_annotations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE file_row public.room_files%ROWTYPE;
DECLARE annotation_row public.pdf_annotations%ROWTYPE;
BEGIN
  SELECT * INTO file_row FROM public.room_files rf WHERE rf.id = p_file_id AND rf.deleted_at IS NULL;
  IF NOT FOUND OR auth.uid() IS NULL
     OR file_row.mime_type <> 'application/pdf'
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'study')
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'files')
     OR p_page_number IS NULL OR p_page_number < 1 OR p_page_number > 100000
     OR p_position IS NULL OR jsonb_typeof(p_position) <> 'object' OR octet_length(convert_to(p_position::text, 'UTF8')) > 10000
     OR char_length(COALESCE(btrim(p_content), '')) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid or unauthorized PDF annotation.';
  END IF;
  INSERT INTO public.pdf_annotations(room_id, file_id, owner_id, page_number, position, content)
  VALUES (file_row.room_id, p_file_id, auth.uid(), p_page_number, p_position, btrim(p_content))
  RETURNING * INTO annotation_row;
  RETURN annotation_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_pdf_annotation(p_annotation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE annotation_row public.pdf_annotations%ROWTYPE;
BEGIN
  SELECT * INTO annotation_row FROM public.pdf_annotations pa WHERE pa.id = p_annotation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(annotation_row.room_id, auth.uid(), 'study')
     OR NOT public.room_has_capability(annotation_row.room_id, auth.uid(), 'files')
     OR NOT (annotation_row.owner_id = auth.uid() OR public.is_room_admin_or_owner(annotation_row.room_id, auth.uid())) THEN
    RAISE EXCEPTION 'Not authorized to delete this PDF annotation.';
  END IF;
  DELETE FROM public.pdf_annotations WHERE id = p_annotation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_room_whiteboard(p_room_id uuid)
RETURNS public.room_whiteboards
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE board_row public.room_whiteboards%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to view this whiteboard.';
  END IF;
  SELECT * INTO board_row FROM public.room_whiteboards rw WHERE rw.room_id = p_room_id;
  RETURN board_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_room_whiteboard(
  p_room_id uuid,
  p_expected_version bigint,
  p_state jsonb
)
RETURNS public.room_whiteboards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE board_row public.room_whiteboards%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study')
     OR p_expected_version IS NULL OR p_expected_version < 0
     OR p_state IS NULL OR jsonb_typeof(p_state) <> 'object'
     OR octet_length(convert_to(p_state::text, 'UTF8')) > 524288 THEN
    RAISE EXCEPTION 'Invalid or unauthorized whiteboard update.';
  END IF;

  SELECT * INTO board_row FROM public.room_whiteboards rw WHERE rw.room_id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version <> 0 THEN RAISE EXCEPTION 'Whiteboard update rejected: expected version does not match.'; END IF;
    INSERT INTO public.room_whiteboards(room_id, state, version, updated_by)
    VALUES (p_room_id, p_state, 1, auth.uid())
    RETURNING * INTO board_row;
    RETURN board_row;
  END IF;
  IF board_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'Whiteboard update rejected: expected version does not match.';
  END IF;
  UPDATE public.room_whiteboards
  SET state = p_state, version = version + 1, updated_by = auth.uid(), updated_at = now()
  WHERE room_id = p_room_id
  RETURNING * INTO board_row;
  RETURN board_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_study_note(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_study_notes(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_study_note(uuid, bigint, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_study_note(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_pdf_annotations(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_pdf_annotation(uuid, integer, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_pdf_annotation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_whiteboard(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_room_whiteboard(uuid, bigint, jsonb) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_study_note(uuid, text, text, text), public.list_study_notes(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_study_note(uuid, bigint, text, text), public.delete_study_note(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_pdf_annotations(uuid), public.create_pdf_annotation(uuid, integer, jsonb, text), public.delete_pdf_annotation(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_room_whiteboard(uuid), public.save_room_whiteboard(uuid, bigint, jsonb) TO authenticated, service_role;
