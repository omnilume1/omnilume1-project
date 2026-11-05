import { createClient } from '@/utils/supabase/client';
import {
  discoverArgs, type ActivityRow, type DiscoverFilters, type OverviewRoom, type RoomPulse, type RsvpResponse, type TrustLevel,
} from '@/lib/room-management-model';
import type { DataResult } from '@/lib/collab-data';

// Action 13 data, read through RLS or the capability-checked RPCs in
// 20261108100000_action13_activity_discovery.sql. Called from the browser on
// purpose (room pages queue server actions one at a time). Errors come back as
// values; database wording is shown only for the RPCs' own user-facing codes.

const USER_FACING = new Set(['42501', '23505', '23514', 'P0429', '22023']);
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

// --- Discovery ----------------------------------------------------------------
export type DiscoveredRoom = {
  id: string;
  name: string;
  description: string | null;
  username: string | null;
  expiration_type: string | null;
  deletion_scheduled_at: string | null;
  created_at: string;
  member_count: number;
  is_private: boolean;
  viewer_role: string | null;
  last_activity_at: string | null;
  feature_flags: Record<string, boolean> | null;
  bookmarked: boolean;
};
export const discoverRooms = (filters: DiscoverFilters, offset = 0) =>
  rpc<DiscoveredRoom[]>('discover_rooms', discoverArgs(filters, offset), 'Rooms could not be loaded right now.');

// --- Activity / pulse ----------------------------------------------------------------
export const listRoomActivity = (roomId: string, before: string | null = null, limit = 40) =>
  rpc<ActivityRow[]>('list_room_activity', { p_room_id: roomId, p_before: before, p_limit: limit }, 'Room activity could not be loaded.');
export const getRoomPulse = (roomId: string) =>
  rpc<RoomPulse>('get_room_pulse', { p_room_id: roomId }, 'Room pulse is unavailable.');

// --- Bookmarks ---------------------------------------------------------------------------
export type BookmarkKind = 'room' | 'message' | 'file';
export type Bookmark = { id: string; kind: BookmarkKind; room_id: string; room_name: string; entity_id: string; label: string; note: string; created_at: string };
export const setBookmark = (roomId: string, kind: BookmarkKind, entityId: string, saved: boolean, note = '') =>
  rpc<boolean>('set_room_bookmark', { p_room_id: roomId, p_kind: kind, p_entity_id: entityId, p_saved: saved, p_note: note }, 'Unable to update your saved items.');
export const listMyBookmarks = (limit = 50) =>
  rpc<Bookmark[]>('list_my_bookmarks', { p_limit: limit }, 'Saved items could not be loaded.');
export async function listBookmarkedIds(kind: BookmarkKind, roomId?: string): Promise<DataResult<string[]>> {
  let query = createClient().from('room_bookmarks').select('entity_id').eq('kind', kind);
  if (roomId) query = query.eq('room_id', roomId);
  const { data, error } = await query.limit(200);
  if (error) return failure(error, 'Saved items could not be loaded.');
  return { ok: true, data: ((data ?? []) as Array<{ entity_id: string }>).map((row) => String(row.entity_id)) };
}

// --- Templates ---------------------------------------------------------------------------
export type TemplateConfig = {
  is_private: boolean;
  expiration_type: 'permanent' | 'recoverable' | 'irreversible';
  duration_hours?: number | null;
  default_layout: string;
  theme: string;
  rules?: string;
  welcome_message?: string;
  feature_flags: Record<string, boolean>;
};
export type RoomTemplate = { id: string; owner_id: string | null; builtin_key: string | null; name: string; description: string; config: TemplateConfig };
export async function listRoomTemplates(): Promise<DataResult<RoomTemplate[]>> {
  const { data, error } = await createClient().from('room_templates').select('id, owner_id, builtin_key, name, description, config').order('created_at');
  if (error) return failure(error, 'Templates could not be loaded.');
  return { ok: true, data: (data ?? []) as RoomTemplate[] };
}
export const saveRoomTemplate = (roomId: string, name: string, description = '') =>
  rpc<string>('save_room_template', { p_room_id: roomId, p_name: name, p_description: description }, 'Unable to save the template.');
export const deleteRoomTemplate = (templateId: string) =>
  rpc<null>('delete_room_template', { p_template_id: templateId }, 'Unable to delete the template.');
export const applyRoomTemplate = (roomId: string, templateId: string) =>
  rpc<{ applied: boolean }>('apply_room_template', { p_room_id: roomId, p_template_id: templateId }, 'Unable to apply the template.');

// --- Trust ------------------------------------------------------------------------------------
export type TrustRow = { user_id: string; level: TrustLevel; tenure_days: number; contributions: number };
export const getRoomTrustLevels = (roomId: string) =>
  rpc<TrustRow[]>('get_room_trust_levels', { p_room_id: roomId }, 'Trust levels could not be loaded.');

// --- Events / RSVP -----------------------------------------------------------------------------
export type RsvpCounts = { event_id: string; going: number; maybe: number; declined: number; my_response: RsvpResponse | null };
export const listEventRsvpCounts = (roomId: string) =>
  rpc<RsvpCounts[]>('list_event_rsvp_counts', { p_room_id: roomId }, 'Responses could not be loaded.');
export const setEventRsvp = (eventId: string, response: RsvpResponse | null) =>
  rpc<null>('set_event_rsvp', { p_event_id: eventId, p_response: response }, 'Unable to save your response.');

// --- Cross-room dashboard ----------------------------------------------------------------------------
export type UpcomingEvent = { event_id: string; room_id: string; room_name: string; title: string; starts_at: string; my_response: RsvpResponse | null };
export type OpenTask = { task_id: string; room_id: string; room_name: string; title: string; due_at: string | null };
export const listMyRoomOverview = () => rpc<OverviewRoom[]>('list_my_room_overview', {}, 'Your rooms could not be loaded.');
export const listMyUpcomingEvents = (limit = 8) => rpc<UpcomingEvent[]>('list_my_upcoming_events', { p_limit: limit }, 'Your events could not be loaded.');
export const listMyOpenTasks = (limit = 8) => rpc<OpenTask[]>('list_my_open_tasks', { p_limit: limit }, 'Your tasks could not be loaded.');
