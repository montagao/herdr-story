// Office themes.
//
// Every carpet here is a real tile cut out of one of the game's own room sheets — the classic
// brown office, the wood-floored one, the green room, the tatami room and so on. What is ours is
// the palette wrapped around each: wall, tower and sky. The game ships each room as one hand-drawn
// picture with its building already painted in, and ours has to be built at whatever size the
// agent count needs, so those colours are chosen to sit with the carpet rather than lifted.
//
// The active theme is remembered per browser and can be forced with ?theme=<id>.

export interface Theme {
  id: string;
  name: string;
  /** Texture key; loaded from ui/carpet_<id>.png. */
  carpet: string;
  wallLight: number;   // the wall facing us
  wallDark: number;    // the wall turned away
  wallTrim: number;    // the cap along the top of both
  wallWindow: number;
  /** The tower the office stands on. Both are real brick cut from the game's own building,
   *  recoloured per theme; ui/facade_<id>_r.png is the lit face, _l the shaded one. */
  facade: string;
  sky: number;
  /** The city silhouette is one cyan daytime image, and Phaser's canvas renderer ignores tint, so
   *  it is faded into the sky colour instead: 1 for a bright day, low for dusk and night. */
  cityAlpha: number;
  /** Floor label under each desk cluster. */
  label: string;
}

export const THEMES: Theme[] = [
  { id: 'classic', name: 'Classic', carpet: 'carpet_classic', facade: 'facade_classic',
    wallLight: 0xe8e2d4, wallDark: 0xd9d2c2, wallTrim: 0xf6f6f2, wallWindow: 0x9fd8f2,
    sky: 0x62f5ff, cityAlpha: 1, label: '#f1e4c8' },

  { id: 'woodshop', name: 'Workshop', carpet: 'carpet_woodshop', facade: 'facade_woodshop',
    wallLight: 0xf2e6cf, wallDark: 0xe2d2b4, wallTrim: 0xfff8ea, wallWindow: 0x9fd8f2,
    sky: 0x7fdcff, cityAlpha: 0.9, label: '#fff0d4' },

  { id: 'greenroom', name: 'Green Room', carpet: 'carpet_greenroom', facade: 'facade_greenroom',
    wallLight: 0xe4e8d6, wallDark: 0xd0d6bd, wallTrim: 0xf6f8ee, wallWindow: 0xa8dcc8,
    sky: 0x8fe6d8, cityAlpha: 0.85, label: '#eaf3d8' },

  { id: 'tatami', name: 'Tatami', carpet: 'carpet_tatami', facade: 'facade_tatami',
    wallLight: 0xf0e4cc, wallDark: 0xdccdae, wallTrim: 0xfdf6e6, wallWindow: 0xe8d9a8,
    sky: 0xffcf9a, cityAlpha: 0.45, label: '#fdf0d6' },

  { id: 'midnight', name: 'Midnight', carpet: 'carpet_midnight', facade: 'facade_midnight',
    wallLight: 0x2c3550, wallDark: 0x212942, wallTrim: 0x4a577a, wallWindow: 0xffd76a,
    sky: 0x141a30, cityAlpha: 0.14, label: '#aab6d8' },

  { id: 'ice', name: 'Ice', carpet: 'carpet_ice', facade: 'facade_ice',
    wallLight: 0xeef6fb, wallDark: 0xd9e8f2, wallTrim: 0xffffff, wallWindow: 0xbfe6f5,
    sky: 0xbfeeff, cityAlpha: 0.85, label: '#e8f4fb' },

  { id: 'concrete', name: 'Concrete', carpet: 'carpet_concrete', facade: 'facade_concrete',
    wallLight: 0xd9d9d2, wallDark: 0xc2c2ba, wallTrim: 0xeeeee8, wallWindow: 0xa8bcc4,
    sky: 0xa8c0c8, cityAlpha: 0.5, label: '#e6e6de' },

  { id: 'slate', name: 'Slate', carpet: 'carpet_slate', facade: 'facade_slate',
    wallLight: 0x4a4a52, wallDark: 0x3a3a42, wallTrim: 0x6b6b76, wallWindow: 0xffb45c,
    sky: 0xff9d6b, cityAlpha: 0.3, label: '#cfc8d4' },

  { id: 'loft', name: 'Loft', carpet: 'carpet_loft', facade: 'facade_loft',
    wallLight: 0xf4efe4, wallDark: 0xe4ddce, wallTrim: 0xfffcf4, wallWindow: 0xbfe6f5,
    sky: 0x9fe4ff, cityAlpha: 0.9, label: '#f6efe0' },
];

const KEY = 'herdr-story:theme';

export function themeById(id: string | null | undefined) {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** ?theme= wins for the length of the visit; otherwise whatever was picked last. */
export function activeTheme(): Theme {
  const q = new URLSearchParams(location.search).get('theme');
  if (q) return themeById(q);
  try { return themeById(localStorage.getItem(KEY)); } catch { return THEMES[0]; }
}

export function saveTheme(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
}
