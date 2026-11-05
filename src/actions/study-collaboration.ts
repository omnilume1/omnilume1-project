'use server';

import { createClient } from '@/utils/supabase/server';
import { assertActiveRoom } from '@/lib/room-lifecycle';
import { listRoomFiles, type RoomFileRow } from '@/actions/room-files';

export type StudyNote = { id: string; room_id: string; owner_id: string; scope: 'room' | 'personal'; title: string; content: string; version: number; created_at: string; updated_at: string };
export type PdfAnnotation = { id: string; room_id: string; file_id: string; owner_id: string; page_number: number; position: Record<string, unknown>; content: string; created_at: string; updated_at: string };
// state is parsed and sanitized client-side by src/lib/whiteboard-model.ts.
export type RoomWhiteboard = { room_id: string; state: Record<string, unknown>; version: number; updated_by: string; updated_at: string };

async function studyClient(roomId: string) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Unauthorized');
  await assertActiveRoom(supabase, roomId);
  const { data: allowed, error: capabilityError } = await supabase.rpc('room_has_capability', { p_room_id: roomId, p_user_id: user.id, p_capability: 'study' });
  if (capabilityError) throw new Error(capabilityError.message);
  if (!allowed) throw new Error('You do not have permission to use Study in this room.');
  return { supabase, user };
}

export async function listStudyNotes(roomId: string) { const { supabase } = await studyClient(roomId); const { data, error } = await supabase.rpc('list_study_notes', { p_room_id: roomId }); if (error) throw new Error(error.message); return (data ?? []) as StudyNote[]; }
export async function createStudyNote(roomId: string, scope: StudyNote['scope']) { const { supabase } = await studyClient(roomId); const { data, error } = await supabase.rpc('create_study_note', { p_room_id: roomId, p_scope: scope, p_title: 'Untitled note', p_content: '' }); if (error) throw new Error(error.message); return data as StudyNote; }
export async function updateStudyNote(noteId: string, expectedVersion: number, title: string, content: string) { const supabase = await createClient(); const { data, error } = await supabase.rpc('update_study_note', { p_note_id: noteId, p_expected_version: expectedVersion, p_title: title, p_content: content }); if (error) throw new Error(error.message); return data as StudyNote; }
export async function deleteStudyNote(noteId: string) { const supabase = await createClient(); const { error } = await supabase.rpc('delete_study_note', { p_note_id: noteId }); if (error) throw new Error(error.message); }
export async function getRoomWhiteboard(roomId: string) { const { supabase } = await studyClient(roomId); const { data, error } = await supabase.rpc('get_room_whiteboard', { p_room_id: roomId }); if (error) throw new Error(error.message); return (data ?? null) as RoomWhiteboard | null; }
export async function saveRoomWhiteboard(roomId: string, expectedVersion: number, state: RoomWhiteboard['state']) { const { supabase } = await studyClient(roomId); const { data, error } = await supabase.rpc('save_room_whiteboard', { p_room_id: roomId, p_expected_version: expectedVersion, p_state: state }); if (error) throw new Error(error.message); return data as RoomWhiteboard; }
export async function listStudyPdfFiles(roomId: string) { await studyClient(roomId); const files = await listRoomFiles(roomId); return files.filter((file) => file.mime_type === 'application/pdf') as RoomFileRow[]; }
export async function listPdfAnnotations(roomId: string, fileId: string) { const { supabase } = await studyClient(roomId); const { data, error } = await supabase.rpc('list_pdf_annotations', { p_file_id: fileId }); if (error) throw new Error(error.message); return (data ?? []) as PdfAnnotation[]; }
export async function createPdfAnnotation(roomId: string, fileId: string, pageNumber: number, content: string) { const { supabase } = await studyClient(roomId); const { data, error } = await supabase.rpc('create_pdf_annotation', { p_file_id: fileId, p_page_number: pageNumber, p_position: { source: 'study-pdf-viewer' }, p_content: content }); if (error) throw new Error(error.message); return data as PdfAnnotation; }
export async function deletePdfAnnotation(roomId: string, annotationId: string) { const { supabase } = await studyClient(roomId); const { error } = await supabase.rpc('delete_pdf_annotation', { p_annotation_id: annotationId }); if (error) throw new Error(error.message); }
