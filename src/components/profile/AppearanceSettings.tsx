'use client';

import { saveAppTheme, useAppTheme } from '@/hooks/useAppTheme';
import { APP_THEMES, APP_THEME_LABELS, sectionAccents, themeSwatch, type AppTheme } from '@/lib/app-theme';

const SECTION_DOTS = sectionAccents();

function ThemePreview({ theme }: { theme: AppTheme }) {
  if (theme === 'sections') {
    return <span className="theme-preview is-sections" aria-hidden="true">{SECTION_DOTS.map((colour, index) => <i key={index} style={{ background: colour }} />)}</span>;
  }
  const swatch = themeSwatch(theme === 'purple' ? null : theme);
  return <span className="theme-preview" aria-hidden="true" style={{ background: swatch.base }}><i style={{ background: swatch.surface }} /><i style={{ background: swatch.accent }} /></span>;
}

/** Settings → Appearance: the app theme for this device. Changes apply at once, on every open tab. */
export default function AppearanceSettings() {
  const theme = useAppTheme();
  return (
    <div className="glass-panel settings-card">
      <p className="section-kicker">Appearance</p>
      <h2 className="section-title">Theme</h2>
      <p className="section-copy">Dark purple is the default everywhere. Pick another colour for the whole app, or give every section its own. Saved on this device.</p>
      <fieldset className="theme-picker">
        <legend className="sr-only">Theme</legend>
        {APP_THEMES.map((id) => (
          <label key={id} className="theme-option">
            <input type="radio" name="app-theme" value={id} checked={theme === id} onChange={() => saveAppTheme(id)} />
            <ThemePreview theme={id} />
            <span className="theme-option-text"><strong>{APP_THEME_LABELS[id].label}</strong><small>{APP_THEME_LABELS[id].note}</small></span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
