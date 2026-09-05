'use client';

import type { FormEvent } from 'react';
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

function avatarInitials(name: string, username: string) {
  const value = name.trim() || username.trim() || 'O';
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function SetupSteps({ activeStep }: { activeStep: number }) {
  const steps = ['Basic info', 'Preferences', 'Complete'];
  return (
    <ol className="profile-setup-steps" aria-label="Profile setup progress">
      {steps.map((label, index) => {
        const step = index + 1;
        const state = step < activeStep ? 'is-complete' : step === activeStep ? 'is-current' : '';
        return <li key={label} className={state} aria-current={step === activeStep ? 'step' : undefined}><span>{step < activeStep ? '✓' : step}</span><small>{label}</small></li>;
      })}
    </ol>
  );
}

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
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function advanceSetup() {
    setErrorMessage(null);
    if (step === 1 && (!displayName.trim() || !username.trim() || !dateOfBirth)) {
      setErrorMessage('Add your name, username and date of birth before continuing.');
      return;
    }
    setStep((current) => Math.min(3, current + 1));
  }

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
      const result = await updateMyProfile(input);
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
      <div>
        <label htmlFor="profile-avatar" className="form-label">Profile photo URL <span className="text-neutral-500">(optional)</span></label>
        <input id="profile-avatar" type="url" value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} className="omni-input" placeholder="https://..." inputMode="url" />
        <p className="form-help">Use a secure image URL or an existing application path.</p>
      </div>
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
        <input id="profile-dob" type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} className="omni-input" required />
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
      {setup && <div className="profile-form-span">
        <label htmlFor="profile-gender" className="form-label">Gender</label>
        <select id="profile-gender" value={gender} onChange={(event) => setGender(event.target.value as ProfileGender)} className="omni-select" required>
          {PROFILE_GENDERS.map((option) => <option key={option} value={option}>{genderLabels[option]}</option>)}
        </select>
      </div>}
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
      {setup && <SetupSteps activeStep={step} />}
      <div className="profile-editor-heading">
        <div>
          <p className="section-kicker">{setup ? `Step ${step} of 3` : 'Profile details'}</p>
          <h2>{setup ? (step === 1 ? "Let's get to know you." : step === 2 ? 'Choose your preferences.' : 'Ready to join OmniLume?') : 'Edit your profile'}</h2>
          <p className="section-copy">{setup ? (step === 1 ? 'This helps others find and connect with you.' : step === 2 ? 'Control the details people can discover.' : 'Review your details. They are validated securely when you save.') : 'Your name, username and privacy choices are validated securely before they are saved.'}</p>
        </div>
        {!setup && onCancel && <button type="button" onClick={onCancel} className="icon-button" aria-label="Close profile editor"><OmniIcon name="close" size={17} /></button>}
      </div>

      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {successMessage && <p className="form-success" role="status">{successMessage}</p>}

      {!setup && <>
        {basicFields}
        {preferencesFields}
      </>}

      {setup && step === 1 && basicFields}
      {setup && step === 2 && preferencesFields}
      {setup && step === 3 && <div className="profile-setup-review"><div className="profile-avatar-preview">{avatarUrl ? <img src={avatarUrl} alt="" /> : avatarInitials(displayName, username)}</div><div><strong>{displayName || 'Your name'}</strong><p>{username ? `@${username}` : 'Choose a username'}</p><p>{isPrivate ? 'Private profile' : 'Public profile'}</p></div></div>}

      <div className="profile-form-actions">
        {!setup && onCancel && <button type="button" onClick={onCancel} className="omni-button omni-button-ghost">Cancel</button>}
        {setup && step > 1 && <button type="button" onClick={() => setStep((current) => current - 1)} disabled={saving} className="omni-button omni-button-ghost">Back</button>}
        {setup && step < 3 ? <button type="button" onClick={advanceSetup} className="omni-button omni-button-primary">Continue <OmniIcon name="arrow" size={15} /></button> : <button type="submit" disabled={saving} className="omni-button omni-button-primary">{saving ? 'Saving...' : setup ? 'Continue to OmniLume' : 'Save profile'} <OmniIcon name="arrow" size={15} /></button>}
      </div>
    </form>
  );
}
