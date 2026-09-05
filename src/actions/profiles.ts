'use server';

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
  const message = error instanceof Error ? error.message : '';
  if (message.includes('duplicate') || message.includes('profiles_username_lower_unique_idx')) {
    return new Error('That username is already in use.');
  }
  return new Error(fallback);
}

export async function getMyProfile() {
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, username, date_of_birth, gender, avatar_url, bio, is_private, profile_completed, profile_details_completed, created_at, updated_at')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw new Error('Unable to load your profile.');
  return data;
}

/**
 * Loads everything the own-profile surface needs in a single authenticated
 * round trip: one auth check, all queries executed in parallel on the server.
 * Same tables/RPCs and privacy behavior as the individual actions below.
 */
export async function getMyProfileBundle() {
  const { supabase, user } = await requireUser();
  const [profile, posts, followers, following, friendships, requests] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, display_name, username, date_of_birth, gender, avatar_url, bio, is_private, profile_completed, profile_details_completed, created_at, updated_at')
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
  // used by getMyFriends()/getMyFriendRequests().
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

/**
 * Same single-round-trip consolidation for viewing another member's profile.
 * Privacy stays identical: public_profiles view + RLS-gated posts query and
 * the same follower/following RPCs used by the individual actions.
 */
export async function getPublicProfileBundle(profileId: string) {
  assertUuid(profileId, 'profile ID');
  const { supabase, user } = await requireUser();
  const [profile, posts, followers, following, outgoingFollow, incomingFollow, friendship, outgoingFriendRequest, incomingFriendRequest] = await Promise.all([
    supabase
      .from('public_profiles')
      .select('id, username, display_name, avatar_url, bio, is_private, created_at, updated_at')
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

export async function updateMyProfile(input: ProfileInput) {
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
    .select('id, display_name, username, date_of_birth, gender, avatar_url, bio, is_private, profile_completed, profile_details_completed, created_at, updated_at')
    .single();

  if (error) throw safeMutationError('Unable to save your profile.', error);
  return { success: true as const, profile: data };
}

export async function getPublicProfile(profileId: string) {
  assertUuid(profileId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('public_profiles')
    .select('id, username, display_name, avatar_url, bio, is_private, created_at, updated_at')
    .eq('id', profileId)
    .maybeSingle();
  if (error) throw new Error('Unable to load this profile.');
  return data;
}

export async function getPublicProfileByUsername(username: string) {
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

export async function getProfileFollowers(profileId: string) {
  assertUuid(profileId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('get_profile_followers', { p_profile_id: profileId });
  if (error) throw new Error('Unable to load followers.');
  return data;
}

export async function getProfileFollowing(profileId: string) {
  assertUuid(profileId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('get_profile_following', { p_profile_id: profileId });
  if (error) throw new Error('Unable to load following.');
  return data;
}

export async function requestFollow(targetId: string) {
  assertUuid(targetId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('request_follow', { p_target_id: targetId });
  if (error) throw safeMutationError('Unable to follow this profile.', error);
  return data;
}

export async function respondToFollowRequest(followId: string, decision: 'accepted' | 'rejected') {
  assertUuid(followId, 'follow request ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('respond_to_follow_request', {
    p_follow_id: followId,
    p_decision: decision,
  });
  if (error) throw new Error('Unable to update this follow request.');
  return data;
}

export async function cancelFollowRequest(targetId: string) {
  assertUuid(targetId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('cancel_follow_request', { p_target_id: targetId });
  if (error) throw new Error('Unable to cancel this follow request.');
  return data;
}

export async function unfollowUser(targetId: string) {
  assertUuid(targetId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('unfollow_user', { p_target_id: targetId });
  if (error) throw new Error('Unable to unfollow this profile.');
  return data;
}

export async function removeFollower(followerId: string) {
  assertUuid(followerId, 'follower ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('remove_follower', { p_follower_id: followerId });
  if (error) throw new Error('Unable to remove this follower.');
  return data;
}

export async function requestFriend(recipientId: string) {
  assertUuid(recipientId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('request_friend', { p_recipient_id: recipientId });
  if (error) throw safeMutationError('Unable to send the friend request.', error);
  return data;
}

export async function respondToFriendRequest(requestId: string, decision: 'accepted' | 'rejected') {
  assertUuid(requestId, 'friend request ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('respond_to_friend_request', {
    p_request_id: requestId,
    p_decision: decision,
  });
  if (error) throw new Error('Unable to update this friend request.');
  return data;
}

export async function cancelFriendRequest(requestId: string) {
  assertUuid(requestId, 'friend request ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('cancel_friend_request', { p_request_id: requestId });
  if (error) throw new Error('Unable to cancel this friend request.');
  return data;
}

export async function removeFriend(otherUserId: string) {
  assertUuid(otherUserId, 'profile ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('remove_friend', { p_other_user_id: otherUserId });
  if (error) throw new Error('Unable to remove this friendship.');
  return data;
}

export async function getMyRelationshipState(otherUserId: string) {
  assertUuid(otherUserId, 'profile ID');
  const { supabase, user } = await requireUser();
  const [outgoingFollow, incomingFollow, friend, outgoingFriendRequest, incomingFriendRequest] = await Promise.all([
    supabase.from('follows').select('id, status').eq('follower_id', user.id).eq('following_id', otherUserId).maybeSingle(),
    supabase.from('follows').select('id, status').eq('follower_id', otherUserId).eq('following_id', user.id).maybeSingle(),
    supabase.from('friendships').select('user_one, user_two').or(`and(user_one.eq.${user.id},user_two.eq.${otherUserId}),and(user_one.eq.${otherUserId},user_two.eq.${user.id})`).maybeSingle(),
    supabase.from('friend_requests').select('id, status').eq('requester_id', user.id).eq('recipient_id', otherUserId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('friend_requests').select('id, status').eq('requester_id', otherUserId).eq('recipient_id', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if ([outgoingFollow, incomingFollow, friend, outgoingFriendRequest, incomingFriendRequest].some((result) => result.error)) {
    throw new Error('Unable to load relationship status.');
  }
  return {
    outgoingFollow: outgoingFollow.data,
    incomingFollow: incomingFollow.data,
    friendship: friend.data,
    outgoingFriendRequest: outgoingFriendRequest.data,
    incomingFriendRequest: incomingFriendRequest.data,
  };
}

export async function getMyFriends() {
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

export async function getMyFriendRequests() {
  const { supabase, user } = await requireUser();
  const { data: requests, error } = await supabase
    .from('friend_requests')
    .select('id, requester_id, recipient_id, status, created_at')
    .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
    .order('created_at', { ascending: false });
  if (error) throw new Error('Unable to load friend requests.');

  const otherIds = Array.from(new Set((requests ?? []).map((request) =>
    request.requester_id === user.id ? request.recipient_id : request.requester_id,
  )));
  const { data: profiles, error: profileError } = otherIds.length === 0
    ? { data: [], error: null }
    : await supabase.from('public_profiles').select('id, username, display_name, avatar_url, bio, is_private').in('id', otherIds);
  if (profileError) throw new Error('Unable to load friend requests.');

  const byId = new Map((profiles ?? []).map((profile) => [profile.id, { user_id: profile.id, ...profile }]));
  return (requests ?? []).map((request) => ({
    ...request,
    direction: request.recipient_id === user.id ? 'incoming' as const : 'outgoing' as const,
    profile: byId.get(request.requester_id === user.id ? request.recipient_id : request.requester_id) ?? null,
  }));
}

export async function getPostsForProfile(authorId: string) {
  assertUuid(authorId, 'author ID');
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('posts')
    .select('id, author_id, content, media_url, visibility, created_at, updated_at')
    .eq('author_id', authorId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error('Unable to load posts.');
  return data;
}

export async function createPost(content: string, visibility: PostVisibility = 'profile', mediaUrl?: string | null) {
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

export async function updatePost(postId: string, content: string, visibility: PostVisibility = 'profile', mediaUrl?: string | null) {
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

export async function deletePost(postId: string) {
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
