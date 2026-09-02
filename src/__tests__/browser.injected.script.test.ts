import * as fs from 'fs';
import * as path from 'path';

/**
 * The page-injected script must be valid JavaScript.
 *
 * It lives in a template literal, so TypeScript never looks inside it: a cast like
 * `(el as HTMLElement)` compiles fine as part of a string and then throws
 * "SyntaxError: Unexpected identifier 'as'" in the browser, killing the ENTIRE script at its first
 * occurrence. That shipped — the mutation counter never installed, so "did the page react?"
 * silently degraded to blind waiting and the anti-debugging shield never ran, with the only
 * evidence a console error inside a tool result nobody reads.
 *
 * `new Function(src)` is the check: it parses with the same grammar the browser uses.
 */
describe('the injected browser script is real JavaScript', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'browser', 'browser.runtime.ts'), 'utf8',
  );

  const extract = (name: string): string => {
    const m = source.match(new RegExp(`const ${name} = \\\`([\\s\\S]*?)\\\`;`));
    if (!m) throw new Error(`${name} not found — did it stop being a template literal?`);
    return m[1];
  };

  test('MUTATION_COUNTER_SCRIPT parses in the browser grammar', () => {
    const script = extract('MUTATION_COUNTER_SCRIPT');
    expect(script.length).toBeGreaterThan(200);
    expect(() => new Function(script)).not.toThrow();
  });

  test('it carries no TypeScript-only syntax', () => {
    const script = extract('MUTATION_COUNTER_SCRIPT');
    // The exact form that broke it, plus the neighbouring TS-isms that would break it the same way.
    expect(script).not.toMatch(/\bas\s+(HTMLElement|any|unknown|Element)\b/);
    expect(script).not.toMatch(/:\s*(HTMLElement|any)\s*[),=]/);
  });

  test('headless is a boolean, not the removed string literal', () => {
    // puppeteer 23 removed `headless: 'new'`; leaving it throws before Chromium ever starts.
    expect(source).not.toMatch(/headless:\s*'new'/);
  });
});
