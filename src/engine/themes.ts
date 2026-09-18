export interface ThemeColors {
  accent: string;
  accentShimmer: string;
  text: string;
  inverseText: string;
  inactive: string;
  inactiveShimmer: string;
  subtle: string;
  background: string;
  surface: string;
  surfaceHover: string;
  border: string;
  borderFocus: string;
  error: string;
  errorBg: string;
  success: string;
  warning: string;
  warningShimmer: string;
  info: string;
  promptBorder: string;
  promptBorderShimmer: string;
  userMessageBg: string;
  assistantMessageBg: string;
  permission: string;
  permissionShimmer: string;
  selectionBg: string;
  searchHighlight: string;
  searchCurrent: string;
  bashBorder: string;
  bashBg: string;
  diffAdded: string;
  diffRemoved: string;
  diffAddedDimmed: string;
  diffRemovedDimmed: string;
  diffAddedWord: string;
  diffRemovedWord: string;
  spinnerIdle: string;
  spinnerDecompose: string;
  spinnerExecute: string;
  spinnerVeto: string;
  spinnerBlocked: string;
  progressFill: string;
  progressEmpty: string;
  agentRed: string;
  agentBlue: string;
  agentGreen: string;
  agentYellow: string;
  agentPurple: string;
  agentOrange: string;
  agentPink: string;
  agentCyan: string;
  codeBlockBg: string;
}

import bimaxTheme from './themes/bimax.json';
import draculaTheme from './themes/dracula.json';
import catppuccinTheme from './themes/catppuccin.json';
import gruvboxTheme from './themes/gruvbox.json';
import nordTheme from './themes/nord.json';

export type ThemeName = 'dark' | 'light' | 'dark-ansi' | 'light-ansi' | 'dark-daltonized' | 'light-daltonized' | 'bimax' | 'dracula' | 'catppuccin' | 'gruvbox' | 'nord';

export function resolveTheme(setting: string): ThemeName {
  if (setting === 'auto') {
    return isSystemDark() ? 'dark' : 'light';
  }
  if (['dark', 'light', 'dark-ansi', 'light-ansi', 'dark-daltonized', 'light-daltonized', 'bimax', 'dracula', 'catppuccin', 'gruvbox', 'nord'].includes(setting)) {
    return setting as ThemeName;
  }
  return 'dark'; // Default to the warm, low-chrome dark theme; all themes stay available via /theme
}

function isSystemDark(): boolean {
  if (typeof process !== 'undefined' && process.stdout?.isTTY) {
    const term = process.env.COLORFGBG;
    if (term) {
      const parts = term.split(';');
      if (parts.length === 2 && parts[1] === '0') return true;
    }
  }
  return true;
}

const dark: ThemeColors = {
  accent: 'rgb(215,119,87)',
  accentShimmer: 'rgb(245,149,117)',
  text: 'rgb(230,230,230)',
  inverseText: 'rgb(20,20,20)',
  inactive: 'rgb(120,120,120)',
  inactiveShimmer: 'rgb(160,160,160)',
  subtle: 'rgb(80,80,80)',
  background: 'rgb(20,20,20)',
  surface: 'rgb(30,30,30)',
  surfaceHover: 'rgb(40,40,40)',
  border: 'rgb(55,55,55)',
  borderFocus: 'rgb(100,100,100)',
  error: 'rgb(220,50,70)',
  errorBg: 'rgb(50,20,25)',
  success: 'rgb(80,200,80)',
  warning: 'rgb(220,180,50)',
  warningShimmer: 'rgb(200,158,80)',
  info: 'rgb(87,105,247)',
  promptBorder: 'rgb(100,100,100)',
  promptBorderShimmer: 'rgb(140,140,140)',
  userMessageBg: 'rgb(45,45,45)',
  assistantMessageBg: 'rgb(28,28,28)',
  codeBlockBg: '#1a1a2e',
  permission: 'rgb(87,105,247)',
  permissionShimmer: 'rgb(137,155,255)',
  selectionBg: 'rgb(44,50,62)',
  searchHighlight: 'rgb(60,60,40)',
  searchCurrent: 'rgb(80,80,20)',
  bashBorder: 'rgb(255,0,135)',
  bashBg: 'rgb(35,20,30)',
  diffAdded: 'rgb(105,219,124)',
  diffRemoved: 'rgb(255,168,180)',
  diffAddedDimmed: 'rgb(50,80,50)',
  diffRemovedDimmed: 'rgb(80,50,50)',
  diffAddedWord: 'rgb(47,157,68)',
  diffRemovedWord: 'rgb(209,69,75)',
  spinnerIdle: 'gray',
  spinnerDecompose: 'cyan',
  spinnerExecute: 'rgb(255,94,0)',
  spinnerVeto: 'rgb(138,43,226)',
  spinnerBlocked: 'red',
  progressFill: 'rgb(87,105,247)',
  progressEmpty: 'rgb(55,55,55)',
  agentRed: 'rgb(220,38,38)',
  agentBlue: 'rgb(37,99,235)',
  agentGreen: 'rgb(22,163,74)',
  agentYellow: 'rgb(202,138,4)',
  agentPurple: 'rgb(147,51,234)',
  agentOrange: 'rgb(234,88,12)',
  agentPink: 'rgb(219,39,119)',
  agentCyan: 'rgb(6,182,212)',
};

const light: ThemeColors = {
  accent: 'rgb(215,119,87)',
  accentShimmer: 'rgb(245,149,117)',
  text: 'rgb(20,20,20)',
  inverseText: 'rgb(230,230,230)',
  inactive: 'rgb(140,140,140)',
  inactiveShimmer: 'rgb(170,170,170)',
  subtle: 'rgb(180,180,180)',
  background: 'rgb(245,245,245)',
  surface: 'rgb(255,255,255)',
  surfaceHover: 'rgb(240,240,240)',
  border: 'rgb(220,220,220)',
  borderFocus: 'rgb(180,180,180)',
  error: 'rgb(200,40,60)',
  errorBg: 'rgb(255,230,230)',
  success: 'rgb(44,122,57)',
  warning: 'rgb(180,140,30)',
  warningShimmer: 'rgb(200,158,80)',
  info: 'rgb(87,105,247)',
  promptBorder: 'rgb(153,153,153)',
  promptBorderShimmer: 'rgb(183,183,183)',
  userMessageBg: 'rgb(240,240,240)',
  assistantMessageBg: 'rgb(250,250,250)',
  codeBlockBg: '#f0f0f0',
  permission: 'rgb(87,105,247)',
  permissionShimmer: 'rgb(137,155,255)',
  selectionBg: 'rgb(210,215,230)',
  searchHighlight: 'rgb(220,220,180)',
  searchCurrent: 'rgb(200,200,100)',
  bashBorder: 'rgb(255,0,135)',
  bashBg: 'rgb(250,235,240)',
  diffAdded: 'rgb(105,219,124)',
  diffRemoved: 'rgb(255,168,180)',
  diffAddedDimmed: 'rgb(199,225,203)',
  diffRemovedDimmed: 'rgb(253,210,216)',
  diffAddedWord: 'rgb(47,157,68)',
  diffRemovedWord: 'rgb(209,69,75)',
  spinnerIdle: 'gray',
  spinnerDecompose: 'cyan',
  spinnerExecute: 'rgb(255,94,0)',
  spinnerVeto: 'rgb(138,43,226)',
  spinnerBlocked: 'red',
  progressFill: 'rgb(87,105,247)',
  progressEmpty: 'rgb(220,220,220)',
  agentRed: 'rgb(185,28,28)',
  agentBlue: 'rgb(29,78,216)',
  agentGreen: 'rgb(21,128,61)',
  agentYellow: 'rgb(161,98,7)',
  agentPurple: 'rgb(126,34,206)',
  agentOrange: 'rgb(194,65,12)',
  agentPink: 'rgb(190,24,93)',
  agentCyan: 'rgb(14,116,144)',
};

/** Parse `rgb(r,g,b)` or `#rrggbb`/`#rgb` into [r,g,b]; null if unrecognized. Pure. */
export function parseColor(s: string): [number, number, number] | null {
  const m = s.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (m) return [+m[1], +m[2], +m[3]];
  let h = s.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (/^[0-9a-f]{6}$/i.test(h)) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return null;
}

// The 16 standard ANSI colors as chalk/Ink color NAMES + their typical xterm RGB. Mapping a theme
// to the nearest of these makes the `-ansi` themes render via the terminal's OWN palette (so they
// match the user's terminal theme and degrade cleanly on low-color terminals) instead of emitting
// hardcoded truecolor that a non-truecolor terminal would mangle.
const ANSI16: [string, [number, number, number]][] = [
  ['black', [0, 0, 0]], ['red', [205, 0, 0]], ['green', [0, 205, 0]], ['yellow', [205, 205, 0]],
  ['blue', [0, 0, 238]], ['magenta', [205, 0, 205]], ['cyan', [0, 205, 205]], ['white', [229, 229, 229]],
  ['gray', [127, 127, 127]], ['redBright', [255, 0, 0]], ['greenBright', [0, 255, 0]], ['yellowBright', [255, 255, 0]],
  ['blueBright', [92, 92, 255]], ['magentaBright', [255, 0, 255]], ['cyanBright', [0, 255, 255]], ['whiteBright', [255, 255, 255]],
];

/** Map an rgb()/hex color string to the nearest of the 16 ANSI color names. Unparseable → unchanged. */
export function toAnsi(hexOrRgb: string): string {
  const rgb = parseColor(hexOrRgb);
  if (!rgb) return hexOrRgb;
  let best = ANSI16[0][0];
  let bestDist = Infinity;
  for (const [name, [r, g, b]] of ANSI16) {
    const d = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return best;
}

function ansiTheme(base: ThemeColors): ThemeColors {
  const mapped: Record<string, string> = {};
  for (const [key, val] of Object.entries(base)) {
    mapped[key] = toAnsi(val);
  }
  return mapped as unknown as ThemeColors;
}

function daltonize(theme: ThemeColors): ThemeColors {
  const d: ThemeColors = { ...theme };
  d.accent = 'rgb(0,102,204)';
  d.accentShimmer = 'rgb(50,152,255)';
  d.permission = 'rgb(0,102,204)';
  d.permissionShimmer = 'rgb(50,152,255)';
  d.success = 'rgb(0,153,153)';
  d.info = 'rgb(0,102,204)';
  d.agentRed = 'rgb(0,102,204)';
  d.agentGreen = 'rgb(153,153,0)';
  d.agentOrange = 'rgb(102,102,0)';
  d.agentPink = 'rgb(0,153,153)';
  return d;
}

const themeMap: Record<ThemeName, ThemeColors> = {
  dark,
  light,
  'dark-ansi': ansiTheme(dark),
  'light-ansi': ansiTheme(light),
  'dark-daltonized': daltonize(dark),
  'light-daltonized': daltonize(light),
  bimax: bimaxTheme as ThemeColors,
  dracula: draculaTheme as ThemeColors,
  catppuccin: catppuccinTheme as ThemeColors,
  gruvbox: gruvboxTheme as ThemeColors,
  nord: nordTheme as ThemeColors,
};

export function getTheme(name: ThemeName): ThemeColors {
  return themeMap[name];
}
