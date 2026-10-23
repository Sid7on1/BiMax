import fs from 'fs';
import path from 'path';
import { applyMotionPreference, savedMotionPreference } from '../renderer/src/motion.preference';
import { prefersReducedMotion } from '../renderer/src/components/ui/motion';

/**
 * Fix list item 17: Settings → General → "Reduce motion" wrote `reducedMotion` and nothing read it.
 * It now stamps `data-reduce-motion` on <html>; styles.css gives that attribute a twin of every rule the
 * macOS setting gets, and `prefersReducedMotion()` reads it for the morphs.
 */

const css = fs.readFileSync(path.resolve(__dirname, '../renderer/src/styles.css'), 'utf8');

/** Every selector inside a `@media (prefers-reduced-motion: reduce)` block, comments stripped. */
function mediaSelectors(): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)', at);
    if (start < 0) break;
    let i = css.indexOf('{', start);
    let depth = 0;
    const open = i;
    for (; ; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    const body = css.slice(open + 1, i).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, sel] of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const one of sel.split(',')) if (one.trim()) out.push(one.trim());
    }
    at = i;
  }
  return out;
}

test('every reduced-motion rule has a twin under the setting', () => {
  const selectors = mediaSelectors();
  expect(selectors.length).toBeGreaterThan(15);
  for (const selector of selectors) {
    const twin = selector === ':root' ? ':root[data-reduce-motion]' : `:root[data-reduce-motion] ${selector}`;
    // The whole selector, not a prefix of a longer one: `.thinking-verb` is not `.thinking-verbX`.
    const escaped = twin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect([selector, new RegExp(`${escaped}\\s*[,{]`).test(css)]).toEqual([selector, true]);
  }
});

test('the twin tokens match the media tokens value for value', () => {
  const media = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?:root \{([^}]*)\}/)![1];
  const twin = css.match(/:root\[data-reduce-motion\] \{([^}]*)\}/)![1];
  const decls = (block: string): string[] => block.split(';').map((d) => d.replace(/\s+/g, ' ').trim()).filter(Boolean).sort();
  expect(decls(twin)).toEqual(decls(media));
});

describe('the setting reaches the page', () => {
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
  });
  afterAll(() => { delete (globalThis as any).localStorage; delete (globalThis as any).window; delete (globalThis as any).document; });

  test('apply stamps the attribute and remembers it for the next window', () => {
    const attrs = new Set<string>();
    const root = { toggleAttribute: (name: string, on: boolean) => { if (on) attrs.add(name); else attrs.delete(name); } } as unknown as HTMLElement;
    applyMotionPreference(true, root);
    expect(attrs.has('data-reduce-motion')).toBe(true);
    expect(savedMotionPreference()).toBe(true);
    applyMotionPreference(false, root);
    expect(attrs.has('data-reduce-motion')).toBe(false);
    expect(savedMotionPreference()).toBe(false);
  });

  test('the morphs treat the setting like the system preference', () => {
    let stamped = false;
    (globalThis as any).window = { matchMedia: () => ({ matches: false }) };
    (globalThis as any).document = { documentElement: { hasAttribute: (name: string) => stamped && name === 'data-reduce-motion' } };
    expect(prefersReducedMotion()).toBe(false);
    stamped = true;
    expect(prefersReducedMotion()).toBe(true);
  });

  test('a refused storage still applies the attribute and reads as off', () => {
    (globalThis as any).localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const attrs = new Set<string>();
    const root = { toggleAttribute: (name: string, on: boolean) => { if (on) attrs.add(name); else attrs.delete(name); } } as unknown as HTMLElement;
    applyMotionPreference(true, root);
    expect(attrs.has('data-reduce-motion')).toBe(true);
    expect(savedMotionPreference()).toBe(false);
  });
});

test('the Settings window and the app both apply it', () => {
  const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  expect(read('renderer/src/components/SettingsDialog.tsx')).toContain("if (key === 'reducedMotion') applyMotionPreference(Boolean(value));");
  expect(read('renderer/src/main.tsx')).toContain("document.documentElement.toggleAttribute('data-reduce-motion', savedMotionPreference());");
});
