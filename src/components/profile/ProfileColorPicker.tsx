'use client';

import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import { setMyProfileColor } from '@/actions/profiles';
import { useAppTheme } from '@/hooks/useAppTheme';
import { unwrapAction } from '@/lib/action-result';
import { PROFILE_COLORS, PROFILE_COLOR_LABELS, PROFILE_COLOR_PALETTE, paletteColor, type ProfileColor } from '@/lib/app-theme';

/** The owner's profile colour. Saves on pick; the page follows at once and goes back if the save fails. */
export default function ProfileColorPicker({ value, onChange }: { value: ProfileColor; onChange: (color: ProfileColor) => void }) {
  const theme = useAppTheme();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(color: ProfileColor) {
    if (color === value || saving) return;
    const previous = value;
    setSaving(true);
    setError(null);
    onChange(color);
    try {
      await setMyProfileColor(color).then(unwrapAction);
    } catch {
      onChange(previous);
      setError('Your colour could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className="profile-color-picker" aria-busy={saving}>
      <legend className="profile-color-legend">Profile colour</legend>
      <div className="profile-color-swatches">
        {PROFILE_COLORS.map((color) => (
          <label key={color} className="profile-color-swatch" title={PROFILE_COLOR_LABELS[color]} style={{ '--swatch': paletteColor('b9a8ff', PROFILE_COLOR_PALETTE[color]) } as CSSProperties}>
            <input type="radio" name="profile-color" value={color} checked={value === color} onChange={() => void choose(color)} aria-label={PROFILE_COLOR_LABELS[color]} />
          </label>
        ))}
      </div>
      <p className="profile-color-note">
        {theme === 'sections' ? 'Your profile shows in this colour.' : <>People who use <Link href="/settings">Section colours</Link> see your profile in this colour.</>}
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </fieldset>
  );
}
