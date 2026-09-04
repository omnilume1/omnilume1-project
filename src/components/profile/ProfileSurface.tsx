'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cancelFollowRequest,
  cancelFriendRequest,
  createPost,
  deletePost,
  getMyProfile,
  getMyFriendRequests,
  getMyFriends,
  getMyRelationshipState,
  getPostsForProfile,
  getProfileFollowers,
  getProfileFollowing,
  getPublicProfile,
  removeFriend,
  requestFollow,
  requestFriend,
  respondToFriendRequest,
  unfollowUser,
  updatePost,
} from '@/actions/profiles';
import ProfileForm from '@/components/profile/ProfileForm';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';
import type { ProfileGender, PostVisibility } from '@/lib/profile-validation';

interface ProfileRecord {
  id: string;
  display_name: string | null;
  username: string | null;
  date_of_birth?: string | null;
  gender?: ProfileGender | null;
  avatar_url: string | null;
  bio: string | null;
  is_private: boolean;
  profile_completed?: boolean;
  profile_details_completed?: boolean;
}

interface PostRecord {
  id: string;
  author_id: string;
  content: string;
  media_url: string | null;
  visibility: PostVisibility;
  created_at: string;
  updated_at: string;
}

interface PersonRecord {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

interface RelationshipState {
  outgoingFollow: { id: string; status: string } | null;
  incomingFollow: { id: string; status: string } | null;
  friendship: { user_one: string; user_two: string } | null;
  outgoingFriendRequest: { id: string; status: string } | null;
  incomingFriendRequest: { id: string; status: string } | null;
}

interface FriendRequestRecord {
  id: string;
  requester_id: string;
  recipient_id: string;
  status: string;
  created_at: string;
  direction: 'incoming' | 'outgoing';
  profile: PersonRecord | null;
}

function initials(profile: Pick<ProfileRecord, 'display_name' | 'username'>) {
  const source = profile.display_name || profile.username || 'O';
  return source.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function profileToFormRecord(profile: ProfileRecord) {
  return {
    display_name: profile.display_name,
    username: profile.username,
    date_of_birth: profile.date_of_birth ?? null,
    gender: profile.gender ?? null,
    avatar_url: profile.avatar_url,
    bio: profile.bio,
    is_private: profile.is_private,
  };
}

export default function ProfileSurface({ profileId }: { profileId?: string }) {
  const isOwn = !profileId;
  const [profile, setProfile] = useState<ProfileRecord | null>(null);
  const [posts, setPosts] = useState<PostRecord[]>([]);
  const [followers, setFollowers] = useState<PersonRecord[]>([]);
  const [following, setFollowing] = useState<PersonRecord[]>([]);
  const [relationship, setRelationship] = useState<RelationshipState | null>(null);
  const [friends, setFriends] = useState<PersonRecord[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequestRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [peopleTab, setPeopleTab] = useState<'followers' | 'following' | null>(null);
  const [postText, setPostText] = useState('');
  const [postVisibility, setPostVisibility] = useState<PostVisibility>('profile');
  const [publishing, setPublishing] = useState(false);
  const [activePostId, setActivePostId] = useState<string | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [workingRelationship, setWorkingRelationship] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const loadedProfile = (isOwn ? await getMyProfile() : await getPublicProfile(profileId!)) as ProfileRecord | null;
      if (!loadedProfile) {
        setProfile(null);
        return;
      }
      setProfile(loadedProfile);
      const [loadedPosts, loadedFollowers, loadedFollowing, loadedRelationship, loadedFriends, loadedFriendRequests] = await Promise.all([
        getPostsForProfile(loadedProfile.id),
        getProfileFollowers(loadedProfile.id),
        getProfileFollowing(loadedProfile.id),
        isOwn ? Promise.resolve(null) : getMyRelationshipState(loadedProfile.id),
        isOwn ? getMyFriends() : Promise.resolve([]),
        isOwn ? getMyFriendRequests() : Promise.resolve([]),
      ]);
      setPosts((loadedPosts ?? []) as PostRecord[]);
      setFollowers((loadedFollowers ?? []) as PersonRecord[]);
      setFollowing((loadedFollowing ?? []) as PersonRecord[]);
      setRelationship(loadedRelationship as RelationshipState | null);
      setFriends((loadedFriends ?? []) as PersonRecord[]);
      setFriendRequests((loadedFriendRequests ?? []) as FriendRequestRecord[]);
    } catch {
      setErrorMessage('Unable to load this profile right now. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [isOwn, profileId]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const canViewPeople = isOwn || !profile?.is_private || Boolean(
    relationship?.friendship ||
    relationship?.outgoingFollow?.status === 'accepted' ||
    relationship?.incomingFollow?.status === 'accepted',
  );

  const visiblePeople = useMemo(() => peopleTab === 'following' ? following : followers, [followers, following, peopleTab]);

  async function performRelationshipAction(action: () => Promise<unknown>) {
    setWorkingRelationship(true);
    setErrorMessage(null);
    try {
      await action();
      await load();
    } catch {
      setErrorMessage('That relationship change could not be completed. Please try again.');
    } finally {
      setWorkingRelationship(false);
    }
  }

  async function publishPost(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!postText.trim()) return;
    setPublishing(true);
    setErrorMessage(null);
    try {
      await createPost(postText, postVisibility);
      setPostText('');
      await load();
    } catch {
      setErrorMessage('Unable to publish this post. Please try again.');
    } finally {
      setPublishing(false);
    }
  }

  async function savePost(post: PostRecord) {
    if (!editingText.trim()) return;
    setActivePostId(post.id);
    try {
      await updatePost(post.id, editingText, post.visibility, post.media_url);
      setEditingPostId(null);
      await load();
    } catch {
      setErrorMessage('Unable to update this post.');
    } finally {
      setActivePostId(null);
    }
  }

  async function removePost(postId: string) {
    setActivePostId(postId);
    try {
      await deletePost(postId);
      await load();
    } catch {
      setErrorMessage('Unable to delete this post.');
    } finally {
      setActivePostId(null);
    }
  }

  if (loading) return <div className="omni-state-screen text-sm text-neutral-500">Loading profile...</div>;

  if (!profile) {
    return <div className="omni-internal"><InternalTopbar title="Profile unavailable" description="This profile may be private or no longer available." /><main className="omni-main-content"><div className="glass-panel empty-state"><OmniIcon name="lock" size={24} /><h2>Profile unavailable</h2><p>There is no profile you can view here.</p><Link href="/explore" className="omni-button omni-button-primary">Return to Explore</Link></div></main><FloatingDock /></div>;
  }

  return (
    <div className="omni-internal profile-page">
      <InternalTopbar eyebrow={isOwn ? 'Your identity' : 'Community profile'} title={isOwn ? 'Profile' : profile.display_name || `@${profile.username}`} description={isOwn ? 'Shape how people discover and connect with you.' : 'A closer look at this OmniLume profile.'} actions={isOwn ? <Link href="/settings" className="omni-button omni-button-ghost"><OmniIcon name="settings" size={15} /> Account settings</Link> : <Link href="/messages" className="omni-button omni-button-ghost">Messages</Link>} />
      <main className="omni-main-content profile-content">
        <section className="profile-hero glass-panel fade-up">
          <div className="profile-avatar-large">{profile.avatar_url ? <img src={profile.avatar_url} alt="" /> : initials(profile)}</div>
          <div className="profile-hero-copy">
            <div className="profile-name-row"><div><p className="section-kicker">{profile.is_private ? 'Private profile' : 'Public profile'}</p><h2>{profile.display_name || profile.username}</h2><p className="profile-handle">@{profile.username}</p></div><span className="room-chip"><OmniIcon name={profile.is_private ? 'lock' : 'users'} size={13} /> {profile.is_private ? 'Private' : 'Public'}</span></div>
            {profile.bio && <p className="profile-bio">{profile.bio}</p>}
            <div className="profile-stats"><button type="button" onClick={() => setPeopleTab('followers')}><strong>{followers.length}</strong><span>Followers</span></button><button type="button" onClick={() => setPeopleTab('following')}><strong>{following.length}</strong><span>Following</span></button><div><strong>{posts.length}</strong><span>Posts</span></div></div>
          </div>
          {isOwn ? <button type="button" onClick={() => setEditing((current) => !current)} className="omni-button omni-button-ghost profile-edit-button"><OmniIcon name="more" size={15} /> {editing ? 'Close editor' : 'Edit profile'}</button> : <div className="relationship-stack"><div className="relationship-group"><span className="relationship-label">Following</span>{relationship?.outgoingFollow?.status === 'accepted' ? <button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => unfollowUser(profile.id))} className="omni-button omni-button-ghost">Unfollow</button> : relationship?.outgoingFollow?.status === 'pending' ? <button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => cancelFollowRequest(profile.id))} className="omni-button omni-button-ghost">Request sent</button> : <button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => requestFollow(profile.id))} className="omni-button omni-button-primary">Follow</button>}</div><div className="relationship-group"><span className="relationship-label">Friendship</span>{relationship?.friendship ? <button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => removeFriend(profile.id))} className="omni-button omni-button-ghost">Friends ✓</button> : relationship?.incomingFriendRequest?.status === 'pending' ? <span className="relationship-inline"><button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => respondToFriendRequest(relationship.incomingFriendRequest!.id, 'accepted'))} className="omni-button omni-button-primary">Accept</button><button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => respondToFriendRequest(relationship.incomingFriendRequest!.id, 'rejected'))} className="omni-button omni-button-ghost">Reject</button></span> : relationship?.outgoingFriendRequest?.status === 'pending' ? <button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => cancelFriendRequest(relationship.outgoingFriendRequest!.id))} className="omni-button omni-button-ghost">Request sent</button> : <button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => requestFriend(profile.id))} className="omni-button omni-button-primary">Add friend</button>}</div></div>}
        </section>

        {editing && isOwn && <ProfileForm initialProfile={profileToFormRecord(profile)} onCancel={() => setEditing(false)} onSaved={async (saved) => { setProfile((current) => current ? { ...current, ...saved } : current); setEditing(false); await load(); }} />}

        {errorMessage && <p className="form-error profile-page-error" role="alert">{errorMessage}</p>}

        <section className="profile-body-grid">
          <div className="profile-post-column">
            {isOwn && <form onSubmit={(event) => void publishPost(event)} className="glass-panel post-composer"><div className="section-header"><div><p className="section-kicker">Share something</p><h2 className="section-title">Your posts</h2></div><span className="room-chip"><OmniIcon name="spark" size={13} /> {profile.is_private ? 'Private by default' : 'Discoverable'}</span></div><textarea value={postText} onChange={(event) => setPostText(event.target.value)} className="omni-textarea" rows={4} maxLength={5000} placeholder="What are you making space for?" /><div className="post-composer-actions"><select value={postVisibility} onChange={(event) => setPostVisibility(event.target.value as PostVisibility)} className="omni-select" aria-label="Post visibility"><option value="profile">Profile</option><option value="public">Public</option><option value="followers">Followers and friends</option></select><button type="submit" disabled={publishing || !postText.trim()} className="omni-button omni-button-primary">{publishing ? 'Publishing...' : 'Publish'} <OmniIcon name="arrow" size={14} /></button></div></form>}
            <div className="profile-section-heading"><div><p className="section-kicker">{isOwn ? 'Your voice' : 'Recent activity'}</p><h2 className="section-title">Posts</h2></div></div>
            {posts.length === 0 ? <div className="glass-panel empty-state"><OmniIcon name="message" size={22} /><h3>No posts yet</h3><p>{isOwn ? 'Share your first thought when you are ready.' : 'There are no visible posts here yet.'}</p></div> : <div className="post-list">{posts.map((post) => <article key={post.id} className="glass-card post-card"><div className="post-card-meta"><span className="post-visibility"><OmniIcon name={post.visibility === 'public' ? 'users' : 'lock'} size={12} /> {post.visibility === 'followers' ? 'Followers and friends' : post.visibility === 'public' ? 'Public' : 'Profile'}</span><time dateTime={post.created_at}>{formatDate(post.created_at)}</time>{isOwn && <button type="button" onClick={() => { setEditingPostId(editingPostId === post.id ? null : post.id); setEditingText(post.content); }} className="icon-button" aria-label="Post actions"><OmniIcon name="more" size={15} /></button>}</div>{editingPostId === post.id ? <div className="grid gap-3"><textarea value={editingText} onChange={(event) => setEditingText(event.target.value)} className="omni-textarea" rows={4} maxLength={5000} /><div className="post-inline-actions"><button type="button" onClick={() => void savePost(post)} disabled={activePostId === post.id} className="omni-button omni-button-primary">{activePostId === post.id ? 'Saving...' : 'Save'}</button><button type="button" onClick={() => setEditingPostId(null)} className="omni-button omni-button-ghost">Cancel</button><button type="button" onClick={() => void removePost(post.id)} disabled={activePostId === post.id} className="text-xs text-red-300 hover:text-red-200">Delete post</button></div></div> : <p className="post-card-content">{post.content}</p>}</article>)}</div>}
          </div>
          <aside className="profile-side-column">
            <section className="glass-panel"><div className="section-header"><div><p className="section-kicker">Connections</p><h2 className="text-lg font-semibold">Followers & following</h2></div></div>{!canViewPeople ? <div className="privacy-note"><OmniIcon name="lock" size={17} /><p>This profile keeps its connections private.</p></div> : <><div className="profile-tab-row"><button type="button" onClick={() => setPeopleTab(peopleTab === 'followers' ? null : 'followers')} className={peopleTab === 'followers' ? 'is-active' : ''}>Followers <span>{followers.length}</span></button><button type="button" onClick={() => setPeopleTab(peopleTab === 'following' ? null : 'following')} className={peopleTab === 'following' ? 'is-active' : ''}>Following <span>{following.length}</span></button></div>{peopleTab && <div className="people-list">{visiblePeople.length === 0 ? <p className="text-sm text-neutral-500">No {peopleTab} yet.</p> : visiblePeople.map((person) => <Link key={person.user_id} href={`/profile/${person.user_id}`} className="person-row"><span className="person-avatar">{person.avatar_url ? <img src={person.avatar_url} alt="" /> : (person.display_name || person.username || 'O').slice(0, 1).toUpperCase()}</span><span><strong>{person.display_name || person.username || 'OmniLume member'}</strong><small>@{person.username || 'member'}</small></span></Link>)}</div>}</>}</section>
            {isOwn && <section className="glass-panel"><div className="section-header"><div><p className="section-kicker">Mutual connections</p><h2 className="text-lg font-semibold">Friends <span className="section-count">{friends.length}</span></h2></div></div>{friends.length === 0 ? <p className="text-sm text-neutral-500">Accepted friendships will appear here. Friends remain separate from followers.</p> : <div className="people-list">{friends.map((friend) => <Link key={friend.user_id} href={`/profile/${friend.user_id}`} className="person-row"><span className="person-avatar">{friend.avatar_url ? <img src={friend.avatar_url} alt="" /> : (friend.display_name || friend.username || 'O').slice(0, 1).toUpperCase()}</span><span><strong>{friend.display_name || friend.username || 'OmniLume member'}</strong><small>@{friend.username || 'member'}</small></span><span className="friend-badge">Friends ✓</span></Link>)}</div>}</section>}
            {isOwn && <section className="glass-panel"><div className="section-header"><div><p className="section-kicker">Requests</p><h2 className="text-lg font-semibold">Friend requests</h2></div></div>{friendRequests.filter((request) => request.status === 'pending').length === 0 ? <p className="text-sm text-neutral-500">No pending friend requests.</p> : <div className="people-list">{friendRequests.filter((request) => request.status === 'pending').map((request) => <div key={request.id} className="person-row"><span className="person-avatar">{request.profile?.avatar_url ? <img src={request.profile.avatar_url} alt="" /> : (request.profile?.display_name || request.profile?.username || '?').slice(0, 1).toUpperCase()}</span><span><strong>{request.profile?.display_name || request.profile?.username || 'OmniLume member'}</strong><small>{request.direction === 'incoming' ? 'Incoming request' : 'Request sent'}</small></span>{request.direction === 'incoming' ? <span className="relationship-inline"><button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => respondToFriendRequest(request.id, 'accepted'))} className="omni-button omni-button-primary">Accept</button><button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => respondToFriendRequest(request.id, 'rejected'))} className="omni-button omni-button-ghost">Reject</button></span> : <button type="button" disabled={workingRelationship} onClick={() => void performRelationshipAction(() => cancelFriendRequest(request.id))} className="omni-button omni-button-ghost">Cancel</button>}</div>)}</div>}</section>}
            <section className="glass-panel profile-privacy-card"><p className="section-kicker">Privacy</p><h2 className="text-lg font-semibold">{profile.is_private ? 'Private by choice.' : 'Open to discovery.'}</h2><p>{isOwn ? 'You can change who sees your profile from the editor above.' : profile.is_private ? 'Follow requests and friendship are separate. Accepted relationships unlock the content this profile allows.' : 'Public profile details and public posts are available to signed-in members.'}</p></section>
          </aside>
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
