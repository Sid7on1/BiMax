import { parseColor, toAnsi, getTheme } from '../engine/themes';

describe('parseColor', () => {
  it('parses rgb() and #hex (long + short)', () => {
    expect(parseColor('rgb(215,119,87)')).toEqual([215, 119, 87]);
    expect(parseColor('#1a1a2e')).toEqual([26, 26, 46]);
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
  });
  it('returns null for unparseable input', () => {
    expect(parseColor('red')).toBeNull();
    expect(parseColor('not a color')).toBeNull();
  });
});

describe('toAnsi — nearest 16-color ANSI name', () => {
  it('maps rgb/hex to the nearest standard ANSI color name', () => {
    expect(toAnsi('rgb(0,0,0)')).toBe('black');
    expect(toAnsi('rgb(255,0,0)')).toBe('redBright');
    expect(toAnsi('rgb(0,255,0)')).toBe('greenBright');
    expect(toAnsi('#ffffff')).toBe('whiteBright');
    expect(toAnsi('rgb(80,80,80)')).toBe('gray');
  });
  it('leaves an unparseable value unchanged (named colors pass through)', () => {
    expect(toAnsi('red')).toBe('red');
  });
});

describe('-ansi themes degrade to ANSI names (no truecolor leaks)', () => {
  const NAMES = new Set([
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray',
    'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
  ]);
  it('every color in dark-ansi is one of the 16 ANSI names', () => {
    const t = getTheme('dark-ansi') as unknown as Record<string, string>;
    for (const v of Object.values(t)) {
      expect(/rgb\(|^#/.test(v)).toBe(false); // no raw truecolor
      expect(NAMES.has(v)).toBe(true);
    }
  });
  it('a regular (non-ansi) theme still uses truecolor', () => {
    const t = getTheme('dark') as unknown as Record<string, string>;
    expect(Object.values(t).some(v => /rgb\(|^#/.test(v))).toBe(true);
  });
});
