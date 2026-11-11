'use client';

import { unwrapAction } from '@/lib/action-result';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { updateMyProfile } from '@/actions/profiles';
import { MINIMUM_AGE_YEARS, PROFILE_GENDERS, latestAllowedDateOfBirth, saveWithUsernameRetry, type ProfileGender, type ProfileInput } from '@/lib/profile-validation';
import { OmniIcon } from '@/components/ui/OmniIcon';

interface ProfileRecord {
  display_name: string | null;
  username: string | null;
  date_of_birth: string | null;
  gender: ProfileGender | null;
  avatar_url: string | null;
  bio: string | null;
  is_private: boolean;
}

const genderLabels: Record<ProfileGender, string> = {
  female: 'Female',
  male: 'Male',
  non_binary: 'Non-binary',
  prefer_not_to_say: 'Prefer not to say',
  other: 'Other',
};

function avatarInitials(name: string, username: string) {
  const value = name.trim() || username.trim() || 'O';
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

type SaveOutcome = { success: true; profile: unknown } | { success: false; error: string };

async function saveProfile(input: ProfileInput): Promise<SaveOutcome> {
  try {
    const result = await updateMyProfile(input).then(unwrapAction);
    return result.success ? { success: true, profile: result.profile } : { success: false, error: result.error };
  } catch (error) {
    return { success: false, error: error instanceof Error && error.message === 'That username is already in use.' ? error.message : 'We could not save your profile. Please review the fields and try again.' };
  }
}

export default function ProfileForm({
  initialProfile,
  onSaved,
  onCancel,
  setup = false,
  prefill,
}: {
  initialProfile: ProfileRecord | null;
  onSaved?: (profile: ProfileRecord) => void | Promise<void>;
  onCancel?: () => void;
  setup?: boolean;
  prefill?: { displayName: string; avatarUrl: string; username: string };
}) {
  const [displayName, setDisplayName] = useState(prefill?.displayName ?? initialProfile?.display_name ?? '');
  const [username, setUsername] = useState(prefill?.username ?? initialProfile?.username ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(initialProfile?.date_of_birth ?? '');
  const [gender, setGender] = useState<ProfileGender>(initialProfile?.gender ?? 'prefer_not_to_say');
  const [avatarUrl, setAvatarUrl] = useState(prefill?.avatarUrl ?? initialProfile?.avatar_url ?? '');
  const [bio, setBio] = useState(initialProfile?.bio ?? '');
  const [isPrivate, setIsPrivate] = useState(initialProfile?.is_private ?? true);
  const [changePhoto, setChangePhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const input: ProfileInput = {
      displayName,
      username,
      dateOfBirth,
      gender,
      avatarUrl: avatarUrl || null,
      bio: bio || null,
      isPrivate,
    };

    try {
      let saved: SaveOutcome;
      if (setup) {
        // Hidden fields (gender, bio, private) keep their defaults and are still
        // submitted: the profile-complete flag needs a gender.
        const outcome = await saveWithUsernameRetry(saveProfile, input, { suggested: prefill?.username ?? '' });
        if (outcome.input.username !== input.username) setUsername(outcome.input.username);
        saved = outcome.result;
      } else {
        saved = await updateMyProfile(input).then(unwrapAction) as SaveOutcome;
      }
      const result = saved;
      if (!result.success) {
        setErrorMessage(result.error);
        return;
      }
      setSuccessMessage(setup ? 'Your OmniLume identity is ready.' : 'Profile saved.');
      try {
        await onSaved?.(result.profile as ProfileRecord);
      } catch {
        // The profile itself is persisted at this point; a post-save step
        // failed, so keep the success state instead of claiming the save
        // failed.
      }
    } catch {
      setErrorMessage('We could not save your profile. Please review the fields and try again.');
    } finally {
      setSaving(false);
    }
  }

  const profilePhoto = (
    <div className="profile-photo-control">
      <label htmlFor="profile-avatar" className="profile-avatar-upload">
        <span className="profile-avatar-preview">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : avatarInitials(displayName, username)}
        </span>
        <span className="profile-avatar-camera"><OmniIcon name="camera" size={15} /></span>
      </label>
      {setup && !changePhoto ? (
        <button type="button" onClick={() => setChangePhoto(true)} className="omni-button omni-button-ghost">Change photo</button>
      ) : (
        <div>
          <label htmlFor="profile-avatar" className="form-label">Profile photo URL <span className="text-neutral-500">(optional)</span></label>
          <input id="profile-avatar" type="url" value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} className="omni-input" placeholder="https://..." inputMode="url" />
          <p className="form-help">Use a secure image URL or an existing application path.</p>
        </div>
      )}
    </div>
  );

  const basicFields = (
    <div className="profile-form-grid profile-form-grid-basic">
      {setup && <div className="profile-form-span">{profilePhoto}</div>}
      <div>
        <label htmlFor="profile-display-name" className="form-label">Name</label>
        <input id="profile-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="omni-input" maxLength={120} autoComplete="name" required />
      </div>
      <div>
        <label htmlFor="profile-username" className="form-label">Username</label>
        <input id="profile-username" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} className="omni-input" minLength={3} maxLength={30} autoComplete="username" spellCheck={false} placeholder="yourname" required />
        <p className="form-help">Lowercase letters, numbers, underscores and dots.</p>
      </div>
      <div>
        <label htmlFor="profile-dob" className="form-label">Date of birth</label>
        <input id="profile-dob" type="date" value={dateOfBirth} max={latestAllowedDateOfBirth()} onChange={(event) => setDateOfBirth(event.target.value)} className="omni-input" aria-describedby="profile-dob-help" required />
        <p id="profile-dob-help" className="form-help">You must be at least {MINIMUM_AGE_YEARS} years old to use OmniLume.</p>
      </div>
      {!setup && <div>
        <label htmlFor="profile-gender" className="form-label">Gender</label>
        <select id="profile-gender" value={gender} onChange={(event) => setGender(event.target.value as ProfileGender)} className="omni-select" required>
          {PROFILE_GENDERS.map((option) => <option key={option} value={option}>{genderLabels[option]}</option>)}
        </select>
      </div>}
      {!setup && <div className="profile-form-span">{profilePhoto}</div>}
    </div>
  );

  const preferencesFields = (
    <div className="profile-form-grid">
      <div className="profile-form-span">
        <label htmlFor="profile-bio" className="form-label">Bio <span className="text-neutral-500">(optional)</span></label>
        <textarea id="profile-bio" value={bio} onChange={(event) => setBio(event.target.value)} className="omni-textarea" rows={4} maxLength={500} placeholder="What are you making space for?" />
        <p className="form-help text-right">{bio.length}/500</p>
      </div>
      <label className="privacy-choice profile-form-span">
        <input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />
        <span><strong>{isPrivate ? 'Private profile' : 'Public profile'}</strong><small>{isPrivate ? 'Only approved followers and friends can see restricted profile content.' : 'Anyone signed in can discover your public profile and public posts.'}</small></span>
        <OmniIcon name={isPrivate ? 'lock' : 'users'} size={17} />
      </label>
    </div>
  );

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className={`profile-editor ${setup ? 'profile-setup-editor glass-card-ambient' : 'glass-panel'}`}>
      <div className="profile-editor-heading">
        <div>
          <p className="section-kicker">{setup ? 'Your details' : 'Profile details'}</p>
          <h2>{setup ? "Let's get to know you." : 'Edit your profile'}</h2>
          <p className="section-copy">{setup ? 'This helps others find and connect with you.' : 'Your name, username and privacy choices are validated securely before they are saved.'}</p>
        </div>
        {!setup && onCancel && <button type="button" onClick={onCancel} className="icon-button" aria-label="Close profile editor"><OmniIcon name="close" size={17} /></button>}
      </div>

      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {successMessage && <p className="form-success" role="status">{successMessage}</p>}

      {basicFields}
      {!setup && preferencesFields}

      <div className="profile-form-actions">
        {!setup && onCancel && <button type="button" onClick={onCancel} className="omni-button omni-button-ghost">Cancel</button>}
        <button type="submit" disabled={saving} className="omni-button omni-button-primary">{saving ? 'Saving...' : setup ? 'Enter OmniLume' : 'Save profile'} <OmniIcon name="arrow" size={15} /></button>
      </div>
    </form>
  );
}
