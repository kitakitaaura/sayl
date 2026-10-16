/** Per-browser preferences, kept in localStorage. */
import { browser } from '$app/environment';

export type Theme = 'auto' | 'dark' | 'light';

export interface Prefs {
  theme: Theme;
  reduceMotion: boolean;
  seedDefault: boolean;
  ratio: number;
  autoClear: boolean;
  sequentialDefault: boolean;
  showHashes: boolean;
  /** remembers the "select files" chip */
  selectFiles: boolean;
  /** browser engine: also connect straight to other browsers (WebRTC); they see this browser's IP */
  webrtc: boolean;
}

/** Read by the inline script in app.html too, so keep the key and shape stable. */
export const SETTINGS_KEY = 'sayl.settings';
export const RATIO_CHOICES = [0.5, 1, 2] as const;

const DEFAULTS: Prefs = {
  theme: 'dark',
  reduceMotion: false,
  seedDefault: false,
  ratio: 1,
  autoClear: false,
  sequentialDefault: false,
  showHashes: false,
  selectFiles: true,
  webrtc: false,
};

function load(): Prefs {
  if (!browser) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Record<keyof Prefs, unknown>>;
    const bool = (k: keyof Prefs) => (typeof raw[k] === 'boolean' ? (raw[k] as boolean) : (DEFAULTS[k] as boolean));
    return {
      theme: raw.theme === 'auto' || raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : DEFAULTS.theme,
      reduceMotion: bool('reduceMotion'),
      seedDefault: bool('seedDefault'),
      ratio: RATIO_CHOICES.includes(raw.ratio as never) ? (raw.ratio as number) : DEFAULTS.ratio,
      autoClear: bool('autoClear'),
      sequentialDefault: bool('sequentialDefault'),
      showHashes: bool('showHashes'),
      selectFiles: bool('selectFiles'),
      webrtc: bool('webrtc'),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

class Settings {
  prefs = $state<Prefs>(load());

  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    this.prefs[key] = value;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.prefs));
    } catch {
      // private mode or storage blocked: the setting still applies for this visit
    }
    this.apply();
  }

  /** Applies theme and motion to <html>. */
  apply(): void {
    if (!browser) return;
    const root = document.documentElement;
    if (this.prefs.theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = this.prefs.theme;
    root.classList.toggle('rm', this.prefs.reduceMotion);
  }
}

export const settings = new Settings();
