'use server';

import { createClient } from '@/utils/supabase/server';

export async function logStudySession(roomId: string, subject: string, durationMinutes: number) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    const { error } = await supabase.from('study_sessions').insert({
      user_id: user.id,
      room_id: roomId,
      subject: subject.trim(),
      duration_minutes: durationMinutes
    });

    if (error) throw new Error(error.message);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getStudyHistory(roomId: string) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Unauthorized" };

    const { data, error } = await supabase
      .from('study_sessions')
      .select('subject, duration_minutes, created_at')
      .eq('user_id', user.id)
      .eq('room_id', roomId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Group the data by subject
    const historyMap = new Map<string, { totalMinutes: number, lastStudied: string }>();
    data.forEach(row => {
      const existing = historyMap.get(row.subject);
      if (existing) {
        historyMap.set(row.subject, {
          totalMinutes: existing.totalMinutes + row.duration_minutes,
          lastStudied: new Date(Math.max(new Date(existing.lastStudied).getTime(), new Date(row.created_at).getTime())).toISOString()
        });
      } else {
        historyMap.set(row.subject, { totalMinutes: row.duration_minutes, lastStudied: row.created_at });
      }
    });

    const historyArray = Array.from(historyMap.entries()).map(([subject, stats]) => ({
      subject,
      totalMinutes: stats.totalMinutes,
      lastStudied: stats.lastStudied
    })).sort((a, b) => new Date(b.lastStudied).getTime() - new Date(a.lastStudied).getTime());

    return { success: true, history: historyArray };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteStudySubject(roomId: string, subject: string) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false };

    const { error } = await supabase
      .from('study_sessions')
      .delete()
      .eq('user_id', user.id)
      .eq('room_id', roomId)
      .eq('subject', subject);

    if (error) throw error;
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}