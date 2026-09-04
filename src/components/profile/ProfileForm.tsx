'use client';

import { useState } from 'react';
import { updateMyProfile } from '@/actions/profiles';
import { PROFILE_GENDERS, type ProfileGender, type ProfileInput } from '@/lib/profile-validation';
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

export default function ProfileForm({
  initialProfile,
  onSaved,
  onCancel,
  setup = false,
}: {
  initialProfile: ProfileRecord | null;
  onSaved?: (profile: ProfileRecord) => void | Promise<void>;
  onCancel?: () => void;
  setup?: boolean;
}) {
  const [displayName, setDisplayName] = useState(initialProfile?.display_name ?? '');
  const [username, setUsername] = useState(initialProfile?.username ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(initialProfile?.date_of_birth ?? '');
  const [gender, setGender] = useState<ProfileGender>(initialProfile?.gender ?? 'prefer_not_to_say');
  const [avatarUrl, setAvatarUrl] = useState(initialProfile?.avatar_url ?? '');
  const [bio, setBio] = useState(initialProfile?.bio ?? '');
  const [isPrivate, setIsPrivate] = useState(initialProfile?.is_private ?? true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
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
      const result = await updateMyProfile(input);
      if (!result.success) {
        setErrorMessage(result.error);
        return;
      }
      setSuccessMessage(setup ? 'Your OmniLume identity is ready.' : 'Profile saved.');
      await onSaved?.(result.profile as ProfileRecord);
    } catch {
      setErrorMessage('We could not save your profile. Please review the fields and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="profile-editor glass-panel">
      <div className="profile-editor-heading">
        <div>
          <p className="section-kicker">{setup ? 'Your identity' : 'Profile details'}</p>
          <h2>{setup ? 'Make the space yours.' : 'Edit your profile'}</h2>
          <p className="section-copy">Your name, username and privacy choices are validated securely before they are saved.</p>
        </div>
        {!setup && onCancel && <button type="button" onClick={onCancel} className="icon-button" aria-label="Close profile editor"><OmniIcon name="close" size={17} /></button>}
      </div>

      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {successMessage && <p className="form-success" role="status">{successMessage}</p>}

      <div className="profile-form-grid">
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
          <input id="profile-dob" type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} className="omni-input" required />
        </div>
        <div>
          <label htmlFor="profile-gender" className="form-label">Gender</label>
          <select id="profile-gender" value={gender} onChange={(event) => setGender(event.target.value as ProfileGender)} className="omni-select" required>
            {PROFILE_GENDERS.map((option) => <option key={option} value={option}>{genderLabels[option]}</option>)}
          </select>
        </div>
        <div className="profile-form-span">
          <label htmlFor="profile-avatar" className="form-label">Profile picture URL <span className="text-neutral-500">(optional)</span></label>
          <input id="profile-avatar" type="text" value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} className="omni-input" placeholder="https://..." inputMode="url" />
          <p className="form-help">Use a secure image URL or an existing application path.</p>
        </div>
        <div className="profile-form-span">
          <label htmlFor="profile-bio" className="form-label">Bio <span className="text-neutral-500">(optional)</span></label>
          <textarea id="profile-bio" value={bio} onChange={(event) => setBio(event.target.value)} className="omni-textarea" rows={4} maxLength={500} placeholder="What are you making space for?" />
          <p className="form-help text-right">{bio.length}/500</p>
        </div>
      </div>

      <label className="privacy-choice">
        <input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />
        <span><strong>{isPrivate ? 'Private profile' : 'Public profile'}</strong><small>{isPrivate ? 'Only approved followers and friends can see restricted profile content.' : 'Anyone signed in can discover your public profile and public posts.'}</small></span>
        <OmniIcon name={isPrivate ? 'lock' : 'users'} size={17} />
      </label>

      <div className="profile-form-actions">
        {onCancel && <button type="button" onClick={onCancel} className="omni-button omni-button-ghost">Cancel</button>}
        <button type="submit" disabled={saving} className="omni-button omni-button-primary">{saving ? 'Saving...' : setup ? 'Continue to OmniLume' : 'Save profile'} <OmniIcon name="arrow" size={15} /></button>
      </div>
    </form>
  );
}
