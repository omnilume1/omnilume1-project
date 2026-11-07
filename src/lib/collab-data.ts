import { createClient } from '@/utils/supabase/client';
import { MAX_UPLOAD_BYTES } from '@/lib/upload-limits';

// Action 12 collaboration data, read through RLS and written only through the
// capability-checked RPCs in 20261107100000_action12_collaboration.sql.
// Called from the browser on purpose (room pages queue server actions one at
// a time). Errors come back as values; database wording is shown only for the
// RPCs' own user-facing codes, never raw permission/RLS errors.

export type DataResult<T> = { ok: true; data: T } | { ok: false; error: string };

const USER_FACING = new Set(['42501', '23505', '23514', 'P0002', '22023', '40001']);
function failure(error: { code?: string; message?: string } | null, fallback: string): { ok: false; error: string } {
  if (error?.code && USER_FACING.has(error.code) && error.message && !/permission denied|row-level security/i.test(error.message)) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: fallback };
}

async function rpc<T>(name: string, args: Record<string, unknown>, fallback: string): Promise<DataResult<T>> {
  const { data, error } = await createClient().rpc(name, args);
  if (error) return failure(error, fallback);
  return { ok: true, data: data as T };
}

async function select<T>(query: PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>, fallback: string): Promise<DataResult<T>> {
  const { data, error } = await query;
  if (error) return failure(error, fallback);
  return { ok: true, data: (data ?? []) as T };
}

// --- Notes history / lock --------------------------------------------------
export type NoteVersion = { version: number; title: string; content: string; edited_by: string | null; saved_at: string };
export const listNoteVersions = (noteId: string) =>
  rpc<NoteVersion[]>('list_study_note_versions', { p_note_id: noteId }, 'Unable to load the note history.');
export const restoreNoteVersion = (noteId: string, version: number, expectedVersion: number) =>
  rpc<Record<string, unknown>>('restore_study_note_version', { p_note_id: noteId, p_version: version, p_expected_version: expectedVersion }, 'Unable to restore this version.');
export const setNoteLocked = (noteId: string, locked: boolean) =>
  rpc<Record<string, unknown>>('set_study_note_locked', { p_note_id: noteId, p_locked: locked }, 'Unable to change read-only mode.');

// --- Raise hand ---------------------------------------------------------------
export type HandRaise = { user_id: string; raised_at: string };
export const listHands = (roomId: string) =>
  select<HandRaise[]>(createClient().from('room_hand_raises').select('user_id, raised_at').eq('room_id', roomId).order('raised_at'), 'Unable to load raised hands.');
export const raiseHand = (roomId: string) => rpc<null>('raise_room_hand', { p_room_id: roomId }, 'Unable to raise your hand.');
export const lowerHand = (roomId: string, userId?: string) =>
  rpc<null>('lower_room_hand', { p_room_id: roomId, p_user_id: userId ?? null }, 'Unable to lower this hand.');

// --- Polls --------------------------------------------------------------------
export type Poll = { id: string; question: string; options: string[]; created_by: string; closed_at: string | null; created_at: string };
export type PollResult = { poll_id: string; counts: number[]; total: number; my_vote: number | null };
export const listPolls = (roomId: string) =>
  select<Poll[]>(createClient().from('room_polls').select('id, question, options, created_by, closed_at, created_at').eq('room_id', roomId).order('created_at', { ascending: false }).limit(50), 'Unable to load polls.');
export const pollResults = (roomId: string) => rpc<PollResult[]>('get_room_poll_results', { p_room_id: roomId }, 'Unable to load poll results.');
export const createPoll = (roomId: string, question: string, options: string[]) =>
  rpc<string>('create_room_poll', { p_room_id: roomId, p_question: question, p_options: options }, 'Unable to create the poll.');
export const votePoll = (pollId: string, optionIndex: number) =>
  rpc<null>('vote_room_poll', { p_poll_id: pollId, p_option_index: optionIndex }, 'Unable to record your vote.');
export const closePoll = (pollId: string) => rpc<null>('close_room_poll', { p_poll_id: pollId }, 'Unable to close the poll.');
export const deletePoll = (pollId: string) => rpc<null>('delete_room_poll', { p_poll_id: pollId }, 'Unable to delete the poll.');

// --- Countdowns ---------------------------------------------------------------
export type Countdown = { id: string; label: string; ends_at: string; created_by: string; cancelled_at: string | null };
export const listCountdowns = (roomId: string) =>
  select<Countdown[]>(createClient().from('room_countdowns').select('id, label, ends_at, created_by, cancelled_at').eq('room_id', roomId).is('cancelled_at', null).gt('ends_at', new Date(Date.now() - 60_000).toISOString()).order('ends_at'), 'Unable to load countdowns.');
export const createCountdown = (roomId: string, label: string, endsAt: Date) =>
  rpc<string>('create_room_countdown', { p_room_id: roomId, p_label: label, p_ends_at: endsAt.toISOString() }, 'Unable to start the countdown.');
export const cancelCountdown = (id: string) => rpc<null>('cancel_room_countdown', { p_countdown_id: id }, 'Unable to cancel the countdown.');

// --- Tasks --------------------------------------------------------------------
export type RoomTask = {
  id: string; title: string; details: string; assignee_id: string | null; due_at: string | null;
  status: 'open' | 'done'; created_by: string; completed_by: string | null; completed_at: string | null; created_at: string;
};
export const listTasks = (roomId: string) =>
  select<RoomTask[]>(createClient().from('room_tasks').select('id, title, details, assignee_id, due_at, status, created_by, completed_by, completed_at, created_at').eq('room_id', roomId).order('status').order('due_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }), 'Unable to load tasks.');
export const createTask = (roomId: string, title: string, details: string, assigneeId: string | null, dueAt: string | null) =>
  rpc<string>('create_room_task', { p_room_id: roomId, p_title: title, p_details: details, p_assignee_id: assigneeId, p_due_at: dueAt }, 'Unable to add the task.');
export const updateTask = (taskId: string, title: string, details: string, assigneeId: string | null, dueAt: string | null) =>
  rpc<null>('update_room_task', { p_task_id: taskId, p_title: title, p_details: details, p_assignee_id: assigneeId, p_due_at: dueAt }, 'Unable to update the task.');
export const setTaskDone = (taskId: string, done: boolean) => rpc<null>('set_room_task_done', { p_task_id: taskId, p_done: done }, 'Unable to update the task.');
export const deleteTask = (taskId: string) => rpc<null>('delete_room_task', { p_task_id: taskId }, 'Unable to delete the task.');

// --- Room events --------------------------------------------------------------
export type RoomEventRow = { id: string; title: string; details: string; starts_at: string; ends_at: string | null; created_by: string; cancelled_at: string | null };
export const listEvents = (roomId: string) =>
  select<RoomEventRow[]>(createClient().from('room_events').select('id, title, details, starts_at, ends_at, created_by, cancelled_at').eq('room_id', roomId).gt('starts_at', new Date(Date.now() - 12 * 3_600_000).toISOString()).order('starts_at').limit(100), 'Unable to load events.');
export const createEvent = (roomId: string, title: string, details: string, startsAt: string, endsAt: string | null) =>
  rpc<string>('create_room_event', { p_room_id: roomId, p_title: title, p_details: details, p_starts_at: startsAt, p_ends_at: endsAt }, 'Unable to schedule the event.');
export const cancelEvent = (eventId: string) => rpc<null>('cancel_room_event', { p_event_id: eventId }, 'Unable to cancel the event.');

// --- Study resources ----------------------------------------------------------
export type StudyResource = {
  id: string; kind: 'youtube' | 'media' | 'link'; title: string; url: string | null; media_id: string | null; added_by: string; created_at: string;
};
export type ResourceProgress = { resource_id: string; position_seconds: number; duration_seconds: number | null; updated_at: string };
export type ResourceNote = { id: string; resource_id: string; user_id: string; at_seconds: number; body: string; scope: 'room' | 'personal'; created_at: string };
export const listResources = (roomId: string) =>
  select<StudyResource[]>(createClient().from('room_study_resources').select('id, kind, title, url, media_id, added_by, created_at').eq('room_id', roomId).order('created_at', { ascending: false }), 'Unable to load study resources.');
export const listProgress = (roomId: string) =>
  select<ResourceProgress[]>(createClient().from('room_resource_progress').select('resource_id, position_seconds, duration_seconds, updated_at').eq('room_id', roomId), 'Unable to load your progress.');
export const listResourceNotes = (resourceId: string) =>
  select<ResourceNote[]>(createClient().from('room_resource_notes').select('id, resource_id, user_id, at_seconds, body, scope, created_at').eq('resource_id', resourceId).order('at_seconds'), 'Unable to load timestamped notes.');
export const addResource = (roomId: string, kind: StudyResource['kind'], title: string, url: string | null, mediaId: string | null) =>
  rpc<string>('add_study_resource', { p_room_id: roomId, p_kind: kind, p_title: title, p_url: url, p_media_id: mediaId }, 'Unable to add the resource.');
export const deleteResource = (id: string) => rpc<null>('delete_study_resource', { p_resource_id: id }, 'Unable to remove the resource.');
export const saveProgress = (resourceId: string, position: number, duration: number | null) =>
  rpc<null>('save_resource_progress', { p_resource_id: resourceId, p_position: Math.max(0, Math.min(86_400, position)), p_duration: duration && duration > 0 ? Math.min(86_400, duration) : null }, 'Unable to save your progress.');
export const addResourceNote = (resourceId: string, atSeconds: number, body: string, scope: ResourceNote['scope']) =>
  rpc<string>('add_resource_note', { p_resource_id: resourceId, p_at_seconds: Math.max(0, atSeconds), p_body: body, p_scope: scope }, 'Unable to add the note.');
export const deleteResourceNote = (id: string) => rpc<null>('delete_resource_note', { p_note_id: id }, 'Unable to delete the note.');

// --- Voice moderation ---------------------------------------------------------
export type VoiceModeration = { user_id: string; audio_muted: boolean; screen_blocked: boolean };
export const listVoiceModeration = (roomId: string) =>
  select<VoiceModeration[]>(createClient().from('room_voice_moderation').select('user_id, audio_muted, screen_blocked').eq('room_id', roomId), 'Unable to load voice moderation.');
export const setVoiceModeration = (roomId: string, userId: string, audioMuted: boolean, screenBlocked: boolean) =>
  rpc<null>('set_room_voice_moderation', { p_room_id: roomId, p_user_id: userId, p_audio_muted: audioMuted, p_screen_blocked: screenBlocked }, 'Unable to update moderation.');

// --- Recordings and transcripts -----------------------------------------------
export type Recording = {
  id: string; requested_by: string; status: 'consent' | 'recording' | 'stopped' | 'cancelled' | 'deleted';
  participants: string[]; created_at: string; started_at: string | null; stopped_at: string | null;
  storage_path: string | null; duration_seconds: number | null; retention_until: string | null;
};
export type RecordingConsent = { recording_id: string; user_id: string; decision: 'granted' | 'declined' };
export type Transcript = { recording_id: string; body: string; version: number; updated_by: string | null; updated_at: string };
export const listRecordings = (roomId: string) =>
  select<Recording[]>(createClient().from('room_recordings').select('id, requested_by, status, participants, created_at, started_at, stopped_at, storage_path, duration_seconds, retention_until').eq('room_id', roomId).neq('status', 'deleted').order('created_at', { ascending: false }).limit(20), 'Unable to load recordings.');
export const listConsents = (roomId: string) =>
  select<RecordingConsent[]>(createClient().from('room_recording_consents').select('recording_id, user_id, decision').eq('room_id', roomId), 'Unable to load consent answers.');
export const getTranscript = async (recordingId: string): Promise<DataResult<Transcript | null>> => {
  const { data, error } = await createClient().from('room_recording_transcripts').select('recording_id, body, version, updated_by, updated_at').eq('recording_id', recordingId).maybeSingle();
  if (error) return failure(error, 'Unable to load the transcript.');
  return { ok: true, data: (data as Transcript | null) ?? null };
};
export const requestRecording = (roomId: string, participants: string[]) =>
  rpc<string>('request_room_recording', { p_room_id: roomId, p_participants: participants }, 'Unable to request a recording.');
export const respondRecording = (recordingId: string, granted: boolean) =>
  rpc<string>('respond_room_recording', { p_recording_id: recordingId, p_granted: granted }, 'Unable to record your answer.');
export const finishRecording = (recordingId: string, storagePath: string, durationSeconds: number) =>
  rpc<null>('finish_room_recording', { p_recording_id: recordingId, p_storage_path: storagePath, p_duration_seconds: Math.max(0, Math.min(86_400, Math.round(durationSeconds))) }, 'Unable to save the recording.');
export const cancelRecording = (recordingId: string) => rpc<null>('cancel_room_recording', { p_recording_id: recordingId }, 'Unable to cancel the recording.');
export async function deleteRecording(recordingId: string): Promise<DataResult<null>> {
  const result = await rpc<string | null>('delete_room_recording', { p_recording_id: recordingId }, 'Unable to delete the recording.');
  if (!result.ok) return result;
  if (result.data) {
    const { error } = await createClient().storage.from('room_recordings').remove([result.data]);
    if (error) return { ok: false, error: 'The recording was deleted, but its file could not be removed. It expires with its retention period.' };
  }
  return { ok: true, data: null };
}
export async function uploadRecording(path: string, blob: Blob): Promise<DataResult<null>> {
  if (blob.size > MAX_UPLOAD_BYTES) return { ok: false, error: 'Recordings must be 500 MB or smaller.' };
  const { error } = await createClient().storage.from('room_recordings').upload(path, blob, { contentType: blob.type.split(';')[0] || 'audio/webm', upsert: false });
  if (error) return { ok: false, error: 'The recording could not be uploaded.' };
  return { ok: true, data: null };
}
export async function recordingUrl(path: string): Promise<DataResult<string>> {
  const { data, error } = await createClient().storage.from('room_recordings').createSignedUrl(path, 600);
  if (error || !data?.signedUrl) return { ok: false, error: 'This recording is not available to you.' };
  return { ok: true, data: data.signedUrl };
}
export const saveTranscript = (recordingId: string, expectedVersion: number, body: string) =>
  rpc<number>('save_room_transcript', { p_recording_id: recordingId, p_expected_version: expectedVersion, p_body: body }, 'Unable to save the transcript.');

// --- Study history (own sessions, RLS) ----------------------------------------
export type StudySession = { subject: string; duration_minutes: number; created_at: string };
export const listStudySessions = (roomId: string, userId: string) =>
  select<StudySession[]>(createClient().from('study_sessions').select('subject, duration_minutes, created_at').eq('room_id', roomId).eq('user_id', userId).order('created_at', { ascending: false }).limit(2000), 'Unable to load your study history.');

// --- Search -------------------------------------------------------------------
export type SearchHit = { kind: string; item_id: string; title: string; snippet: string | null; created_at: string };
export const searchRoom = (roomId: string, query: string) =>
  rpc<SearchHit[]>('search_room_history', { p_room_id: roomId, p_query: query, p_limit: 40 }, 'Unable to search this room.');
