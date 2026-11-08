'use server';

import { actionResult } from '@/lib/action-result';
import { parseProfileColor } from '@/lib/app-theme';
import {
  assertPostVisibility,
  assertUuid,
  type PostVisibility,
  type ProfileInput,
  validateProfileInput,
} from '@/lib/profile-validation';
import { createClient } from '@/utils/supabase/server';

async function requireUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Unauthorized');
  return { supabase, user };
}

function safeMutationError(fallback: string, error: unknown) {
  const message = error instanceof Error
    ? error.message
    : (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : '');
  if (message.includes('duplicate') || message.includes('profiles_username_lower_unique_idx')) {
    return new Error('That username is already in use.');
  }
  // Raised by the profiles_enforce_minimum_age trigger.
  if (message.includes('at least 13 years old')) {
    return new Error('You must be at least 13 years old to use OmniLume.');
  }
  return new Error(fallback);
}

async function getMyProfileImpl() {
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, username, date_of_birth, gender, avatar_url, bio, is_private, profile_completed, profile_details_completed, created_at, updated_at')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw new Error('Unable to load your profile.');
  return data;
}
export async function getMyProfile() {
  return actionResult(() => getMyProfileImpl());
}

/**
 * Loads everything the own-profile surface needs in a single authenticated
 * round trip: one auth check, all queries executed in parallel on the server.
 * Same tables/RPCs and privacy behavior as the individual actions below.
 */
async function getMyProfileBundleImpl() {
  const { supabase, user } = await requireUser();
  const [profile, posts, followers, following, friendships, requests] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, display_name, username, date_of_birth, gender, avatar_url, bio, is_private, profile_completed, profile_details_completed, profile_color, created_at, updated_at')
      .eq('id', user.id)
      .maybeSingle(),
    supabase
      .from('posts')
      .select('id, author_id, content, media_url, visibility, created_at, updated_at')
      .eq('author_id', user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    supabase.rpc('get_profile_followers', { p_profile_id: user.id }),
    supabase.rpc('get_profile_following', { p_profile_id: user.id }),
    supabase
      .from('friendships')
      .select('user_one, user_two, created_at')
      .or(`user_one.eq.${user.id},user_two.eq.${user.id}`)
      .order('created_at', { ascending: false }),
    supabase
      .from('friend_requests')
      .select('id, requester_id, recipient_id, status, created_at')
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
      .order('created_at', { ascending: false }),
  ]);

  const errors = [profile, posts, followers, following, friendships, requests].map((result) => result.error);
  if (errors.some(Boolean)) throw new Error('Unable to load your profile.');

  // Friends and requests resolve profile details from the same public view
  // used by getMyFriendsImpl()/getMyFriendRequestsImpl().
  const friendIds = (friendships.data ?? []).map((friendship) =>
    friendship.user_one === user.id ? friendship.user_two : friendship.user_one,
  );
  const requestOthers = Array.from(new Set((requests.data ?? []).map((request) =>
    request.requester_id === user.id ? request.recipient_id : request.requester_id,
  )));
  const detailIds = Array.from(new Set([...friendIds, ...requestOthers]));

  const { data: details, error: detailsError } = detailIds.length === 0
    ? { data: [], error: null }
    : await supabase
        .from('public_profiles')
        .select('id, username, display_name, avatar_url, bio, is_private')
        .in('id', detailIds);
  if (detailsError) throw new Error('Unable to load your profile.');

  const byId = new Map((details ?? []).map((profile) => [profile.id, profile]));
  const friends = friendIds
    .map((id) => {
      const profile = byId.get(id);
      return profile ? { user_id: profile.id, ...profile } : null;
    })
    .filter((profile): profile is NonNullable<typeof profile> => profile !== null);
  const friendRequests = (requests.data ?? []).map((request) => {
    const otherId = request.requester_id === user.id ? request.recipient_id : request.requester_id;
    const profile = byId.get(otherId) ?? null;
    return {
      ...request,
      direction: request.recipient_id === user.id ? 'incoming' as const : 'outgoing' as const,
      profile: profile ? { user_id: profile.id, ...profile } : null,
    };
  });

  return {
    profile: profile.data,
    posts: posts.data ?? [],
    followers: followers.data ?? [],
    following: following.data ?? [],
    friends,
    friendRequests,
    relationship: null,
  };
}
export async function getMyProfileBundle() {
  return actionResult(() => getMyProfileBundleImpl());
}

/**
 * Same single-round-trip consolidation for viewing another member's profile.
 * Privacy stays identical: public_profiles view + RLS-gated posts query and
 * the same follower/following RPCs used by the individual actions.
 */
async function getPublicProfileBundleImpl(profileId: string) {
  assertUuid(profileId, 'profile ID');
  const { supabase, user } = await requireUser();
  const [profile, posts, followers, following, outgoingFollow, incomingFollow, friendship, outgoingFriendRequest, incomingFriendRequest] = await Promise.all([
    supabase
      .from('public_profiles')
      .select('id, username, display_name, avatar_url, bio, is_private, profile_color, created_at, updated_at')
      .eq('id', profileId)
      .maybeSingle(),
    supabase
      .from('posts')
      .select('id, author_id, content, media_url, visibility, created_at, updated_at')
      .eq('author_id', profileId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    supabase.rpc('get_profile_followers', { p_profile_id: profileId }),
    supabase.rpc('get_profile_following', { p_profile_id: profileId }),
    supabase.from('follows').select('id, status').eq('follower_id', user.id).eq('following_id', profileId).maybeSingle(),
    supabase.from('follows').select('id, status').eq('follower_id', profileId).eq('following_id', user.id).maybeSingle(),
    supabase.from('friendships').select('user_one, user_two').or(`and(user_one.eq.${user.id},user_two.eq.${profileId}),and(user_one.eq.${profileId},user_two.eq.${user.id})`).maybeSingle(),
    supabase.from('friend_requests').select('id, status').eq('requester_id', user.id).eq('recipient_id', profileId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('friend_requests').select('id, status').eq('requester_id', profileId).eq('recipient_id', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const errors = [profile, posts, followers, following, outgoingFollow, incomingFollow, friendship, outgoingFriendRequest, incomingFriendRequest].map((result) => result.error);
  if (errors.some(Boolean)) throw new Error('Unable to load this profile.');

  return {
    profile: profile.data,
    posts: posts.data ?? [],
    followers: followers.data ?? [],
    following: following.data ?? [],
    friends: [],
    friendRequests: [],
    relationship: {
      outgoingFollow: outgoingFollow.data,
      incomingFollow: incomingFollow.data,
      friendship: friendship.data,
      outgoingFriendRequest: outgoingFriendRequest.data,
      incomingFriendRequest: incomingFriendRequest.data,
    },
  };
}
export async function getPublicProfileBundle(profileId: string) {
  return actionResult(() => getPublicProfileBundleImpl(profileId));
}

async function updateMyProfileImpl(input: ProfileInput) {
  const parsed = validateProfileInput(input);
  if (!parsed.success) return parsed;

  const { supabase, user } = await requireUser();
  // profile_completed is written atomically with the profile fields so the
  // identity gate (proxy.ts) is satisfied by the same write that persists the
  // profile — a transient failure of the separate completion action can never
  // leave a saved profile stuck behind the setup gate.
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, ...parsed.data, profile_completed: true }, { onConflict: 'id' })
    .select('id, display_name, username, date_of_birth, gender, avatar_url, bio, is_private, profile_completed, profile_details_completed, profile_color, created_at, updated_at')
    .single();

  if (error) throw safeMutationError('Unable to save your profile.', error);
  return { success: true as const, profile: data };
}
export async function updateMyProfile(input: ProfileInput) {
  return actionResult(() => updateMyProfileImpl(input));
}

// The colour a profile shows to people using the "Section colours" theme.
// The column's check constraint repeats this list; RLS limits the write to the owner's row.
async function setMyProfileColorImpl(color: string) {
  const profileColor = parseProfileColor(color);
  if (!profileColor) throw new Error('Choose one of the profile colours.');
  const { supabase, user } = await requireUser();
  const { error } = await supabase.from('profiles').update({ profile_color: profileColor }).eq('id', user.id);
  if (error) throw new Error('Unable to save your profile colour.');
  return { profileColor };
}
export async function setMyProfileColor(color: string) {
  return actionResult(() => setMyProfileColorImpl(color));
}

async function getPublicProfileByUsernameImpl(username: string) {
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.]{2,29}$/.test(normalized)) {
    throw new Error('Invalid username.');
  }
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('public_profiles')
    .select('id, username, display_name, avatar_url, bio, is_private, created_at, updated_at')
    .eq('username', normalized)
    .maybeSingle();
  if (error) throw new Error('Unable to load this profile.');
  return data;
}
export async function getPublicProfileByUsername(username: string) {
  return actionResult(() => getPublicProfileByUsernameImpl(username));
}

async function requestFollowImpl(targetId: string) {
  assertUuid(targetId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('request_follow', { p_target_id: targetId });
  if (error) throw safeMutationError('Unable to follow this profile.', error);
  return data;
}
export async function requestFollow(targetId: string) {
  return actionResult(() => requestFollowImpl(targetId));
}

async function cancelFollowRequestImpl(targetId: string) {
  assertUuid(targetId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('cancel_follow_request', { p_target_id: targetId });
  if (error) throw new Error('Unable to cancel this follow request.');
  return data;
}
export async function cancelFollowRequest(targetId: string) {
  return actionResult(() => cancelFollowRequestImpl(targetId));
}

async function unfollowUserImpl(targetId: string) {
  assertUuid(targetId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('unfollow_user', { p_target_id: targetId });
  if (error) throw new Error('Unable to unfollow this profile.');
  return data;
}
export async function unfollowUser(targetId: string) {
  return actionResult(() => unfollowUserImpl(targetId));
}

async function requestFriendImpl(recipientId: string) {
  assertUuid(recipientId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('request_friend', { p_recipient_id: recipientId });
  if (error) throw safeMutationError('Unable to send the friend request.', error);
  return data;
}
export async function requestFriend(recipientId: string) {
  return actionResult(() => requestFriendImpl(recipientId));
}

async function respondToFriendRequestImpl(requestId: string, decision: 'accepted' | 'rejected') {
  assertUuid(requestId, 'friend request ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('respond_to_friend_request', {
    p_request_id: requestId,
    p_decision: decision,
  });
  if (error) throw new Error('Unable to update this friend request.');
  return data;
}
export async function respondToFriendRequest(requestId: string, decision: 'accepted' | 'rejected') {
  return actionResult(() => respondToFriendRequestImpl(requestId, decision));
}

async function cancelFriendRequestImpl(requestId: string) {
  assertUuid(requestId, 'friend request ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('cancel_friend_request', { p_request_id: requestId });
  if (error) throw new Error('Unable to cancel this friend request.');
  return data;
}
export async function cancelFriendRequest(requestId: string) {
  return actionResult(() => cancelFriendRequestImpl(requestId));
}

async function removeFriendImpl(otherUserId: string) {
  assertUuid(otherUserId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('remove_friend', { p_other_user_id: otherUserId });
  if (error) throw new Error('Unable to remove this friendship.');
  return data;
}
export async function removeFriend(otherUserId: string) {
  return actionResult(() => removeFriendImpl(otherUserId));
}

async function getMyFriendsImpl() {
  const { supabase, user } = await requireUser();
  const { data: friendships, error } = await supabase
    .from('friendships')
    .select('user_one, user_two, created_at')
    .or(`user_one.eq.${user.id},user_two.eq.${user.id}`)
    .order('created_at', { ascending: false });
  if (error) throw new Error('Unable to load your friends.');

  const otherIds = (friendships ?? []).map((friendship) =>
    friendship.user_one === user.id ? friendship.user_two : friendship.user_one,
  );
  if (otherIds.length === 0) return [];

  const { data: profiles, error: profileError } = await supabase
    .from('public_profiles')
    .select('id, username, display_name, avatar_url, bio, is_private')
    .in('id', otherIds);
  if (profileError) throw new Error('Unable to load your friends.');

  const byId = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  return otherIds
    .map((id) => {
      const profile = byId.get(id);
      return profile ? { user_id: profile.id, ...profile } : null;
    })
    .filter((profile): profile is NonNullable<typeof profile> => profile !== null);
}
export async function getMyFriends() {
  return actionResult(() => getMyFriendsImpl());
}

async function createPostImpl(content: string, visibility: PostVisibility = 'profile', mediaUrl?: string | null) {
  const normalizedContent = content.trim();
  if (!normalizedContent || normalizedContent.length > 5000) throw new Error('Post text must be between 1 and 5000 characters.');
  assertPostVisibility(visibility);
  const normalizedMediaUrl = mediaUrl?.trim() || null;
  if (normalizedMediaUrl && (normalizedMediaUrl.length > 2048 || (!normalizedMediaUrl.startsWith('/') && !normalizedMediaUrl.startsWith('https://')))) {
    throw new Error('Invalid post media URL.');
  }

  const { supabase, user } = await requireUser();
  const { data, error } = await supabase
    .from('posts')
    .insert({ author_id: user.id, content: normalizedContent, visibility, media_url: normalizedMediaUrl })
    .select('id, author_id, content, media_url, visibility, created_at, updated_at')
    .single();
  if (error) throw new Error('Unable to publish this post.');
  return data;
}
export async function createPost(content: string, visibility: PostVisibility = 'profile', mediaUrl?: string | null) {
  return actionResult(() => createPostImpl(content, visibility, mediaUrl));
}

async function updatePostImpl(postId: string, content: string, visibility: PostVisibility = 'profile', mediaUrl?: string | null) {
  assertUuid(postId, 'post ID');
  const normalizedContent = content.trim();
  if (!normalizedContent || normalizedContent.length > 5000) throw new Error('Post text must be between 1 and 5000 characters.');
  assertPostVisibility(visibility);
  const normalizedMediaUrl = mediaUrl?.trim() || null;
  if (normalizedMediaUrl && (normalizedMediaUrl.length > 2048 || (!normalizedMediaUrl.startsWith('/') && !normalizedMediaUrl.startsWith('https://')))) {
    throw new Error('Invalid post media URL.');
  }

  const { supabase, user } = await requireUser();
  const { data, error } = await supabase
    .from('posts')
    .update({ content: normalizedContent, visibility, media_url: normalizedMediaUrl })
    .eq('id', postId)
    .eq('author_id', user.id)
    .is('deleted_at', null)
    .select('id, author_id, content, media_url, visibility, created_at, updated_at')
    .maybeSingle();
  if (error) throw new Error('Unable to update this post.');
  if (!data) throw new Error('Post not found or unavailable.');
  return data;
}
export async function updatePost(postId: string, content: string, visibility: PostVisibility = 'profile', mediaUrl?: string | null) {
  return actionResult(() => updatePostImpl(postId, content, visibility, mediaUrl));
}

async function deletePostImpl(postId: string) {
  assertUuid(postId, 'post ID');
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase
    .from('posts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', postId)
    .eq('author_id', user.id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error('Unable to delete this post.');
  if (!data) throw new Error('Post not found or unavailable.');
  return { success: true };
}
export async function deletePost(postId: string) {
  return actionResult(() => deletePostImpl(postId));
}
