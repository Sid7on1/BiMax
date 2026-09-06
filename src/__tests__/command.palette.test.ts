// Import the full command set the app loads at startup, so this test reflects what the `/`
// autocomplete + Ctrl+G palette actually offer.
import '../cli/commands';
import { globalCommandRegistry, isHiddenCommand } from '../cli/commands/registry';

// The Ctrl+K command palette derives its options from the live registry — the single source of
// truth — so it can never drift from the commands that actually exist (the bug the old hardcoded
// FullScreen list had). These tests lock that contract.
describe('CommandRegistry.getPaletteOptions — curated palette', () => {
  const opts = globalCommandRegistry.getPaletteOptions();

  it('returns the CURATED (non-hidden) command set, deduped by identity', () => {
    const all = globalCommandRegistry.getAllCommands();
    const visible = all.filter(c => !isHiddenCommand(c));
    // Palette is the curated surface: exactly the non-hidden commands, and strictly fewer than all.
    expect(opts.length).toBe(visible.length);
    expect(opts.length).toBeLessThan(all.length);
    // No duplicate command values.
    const values = opts.map(o => o.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('demotes hidden commands from the palette but keeps them registered/runnable', () => {
    const values = opts.map(o => o.value);
    // Representative hidden commands (mind layer / model internals) are off the browsable surface…
    expect(values).not.toContain('/self');
    expect(values).not.toContain('/tier');
    // …but still exist in the registry, so typing them in full still works.
    const allNames = globalCommandRegistry.getAllCommands().map(c => c.name);
    expect(allNames).toEqual(expect.arrayContaining(['/self', '/tier']));
  });

  it('every row is a runnable slash command with a description and category', () => {
    expect(opts.length).toBeGreaterThan(5);
    for (const o of opts) {
      expect(o.value.startsWith('/')).toBe(true);
      expect(o.label).toBe(o.value);
      expect(typeof o.desc).toBe('string');
      expect(o.desc.length).toBeGreaterThan(0);
      expect(typeof o.category).toBe('string');
      expect(o.category.length).toBeGreaterThan(0);
    }
  });

  it('includes the new TUI-upgrade commands so they are discoverable', () => {
    const values = opts.map(o => o.value);
    // Regression: these existed but were missing from the old hardcoded `/` autocomplete list.
    expect(values).toEqual(expect.arrayContaining(['/plugins', '/security', '/diagnostics']));
  });

  it('stays curated to ~25 primary verbs (Gate 5) — discoverability, not sprawl', () => {
    // The whole point of PALETTE_HIDDEN: the browsable surface is a small set of primary verbs,
    // with the rest reachable when typed / via the Ctrl+X HUD. Guard against re-sprawl.
    // (+1 in 2026-07: /setup — the guided provider→key→model wizard belongs on the surface.)
    // (+1 in 2026-07: /computer — the browser/desktop computer-use capability hub is a primary verb.)
    // (+1 in 2026-07: /tasks — background task workspaces (cancel/pause/retry) are a primary verb.)
    // (+1 in 2026-09: /sovereign — air-gap mode is the product's headline claim and the surface an
    //  operator checks before doing confidential work, so it is a primary verb. /route ships beside
    //  it but is a routing DIAGNOSTIC, so it is demoted with the other routing internals.)
    expect(opts.length).toBeLessThanOrEqual(30);
    const values = opts.map(o => o.value);
    // Demoted clusters must NOT be on the browsable surface (they live in the HUD / a primary verb).
    for (const hidden of ['/self', '/tier', '/undo', '/checkpoint', '/edit', '/write', '/resume', '/output', '/index-ai']) {
      expect(values).not.toContain(hidden);
    }
    // …but the unified verbs that absorbed them ARE visible.
    expect(values).toEqual(expect.arrayContaining(['/rewind', '/model', '/index', '/sessions']));
  });

  it('includes representative commands and is sorted by category then name', () => {
    const values = opts.map(o => o.value);
    expect(values).toEqual(expect.arrayContaining(['/help', '/config', '/model']));
    // Sorted: category asc, then label asc within a category.
    for (let i = 1; i < opts.length; i++) {
      const prev = opts[i - 1], cur = opts[i];
      const order = prev.category.localeCompare(cur.category) || prev.label.localeCompare(cur.label);
      expect(order).toBeLessThanOrEqual(0);
    }
  });
});
