'use server';

import { createClient } from '@/utils/supabase/server';

export type StudyHistoryEntry = {
  subject: string;
  totalMinutes: number;
  lastStudied: string;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unable to update study history.';
}

export async function logStudySession(roomId: string, subject: string, durationMinutes: number) {
  try {
    const cleanSubject = subject.trim();
    const roundedMinutes = Math.max(1, Math.round(durationMinutes));
    if (!roomId || !cleanSubject) throw new Error('A subject is required.');
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error('Study time must be greater than zero.');

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error('Unauthorized');

    const { error } = await supabase.from('study_sessions').insert({
      user_id: user.id,
      room_id: roomId,
      subject: cleanSubject,
      duration_minutes: roundedMinutes,
    });

    if (error) throw new Error(error.message);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getStudyHistory(roomId: string) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: 'Unauthorized' };

    const { data, error } = await supabase
      .from('study_sessions')
      .select('subject, duration_minutes, created_at')
      .eq('user_id', user.id)
      .eq('room_id', roomId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const historyMap = new Map<string, { totalMinutes: number; lastStudied: string }>();
    for (const row of data ?? []) {
      const existing = historyMap.get(row.subject);
      if (existing) {
        historyMap.set(row.subject, {
          totalMinutes: existing.totalMinutes + row.duration_minutes,
          lastStudied: new Date(Math.max(
            new Date(existing.lastStudied).getTime(),
            new Date(row.created_at).getTime(),
          )).toISOString(),
        });
      } else {
        historyMap.set(row.subject, {
          totalMinutes: row.duration_minutes,
          lastStudied: row.created_at,
        });
      }
    }

    const history = Array.from(historyMap.entries())
      .map(([subject, stats]) => ({ subject, ...stats }))
      .sort((a, b) => new Date(b.lastStudied).getTime() - new Date(a.lastStudied).getTime());

    return { success: true, history };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function deleteStudySubject(roomId: string, subject: string) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: 'Unauthorized' };

    const { error } = await supabase
      .from('study_sessions')
      .delete()
      .eq('user_id', user.id)
      .eq('room_id', roomId)
      .eq('subject', subject);

    if (error) throw error;
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}
