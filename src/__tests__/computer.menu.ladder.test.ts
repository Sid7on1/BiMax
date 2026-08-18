// Conformance for the perception ladder: AX window tree, then the menu bar, then vision.
//
// The numbers here are MEASURED on this machine on 2026-08-18 through the real runtime:
//
//   Spotify  1 element  (AXWindow only)                 targetable=0  named=0   -> menu_bar (27 cmds)
//   Finder   59 elements (AXRow:28 AXCell:25 AXButton:4) targetable=57 named=28  -> ax_tree
//
// Finder is the case that matters most. Judged by ACTIONABLE_AX_ROLES it has 4 controls and all of
// them are unlabeled, so an "actionable" test calls a window full of named files blind and hands it
// to the menu bar — menus hijacking a healthy tree. Judged by TARGETABLE (non-structural) it has 28
// named rows and the tree wins, which is what the ladder must do.

import {
  axTreeIsSufficient,
  chooseTier,
  describeLadder,
  refineTierWithMenus,
} from '../computer/menu.ladder';

const ax = (over: Partial<Parameters<typeof chooseTier>[0]> = {}) => ({
  targetableCount: 57,
  namedTargetableCount: 28,
  emptyTree: false,
  queryMissing: false,
  ...over,
});

describe('AX tree sufficiency', () => {
  it('accepts a Finder window, whose content is rows rather than buttons', () => {
    expect(axTreeIsSufficient(ax())).toBe(true);
  });

  it('rejects a window that publishes only structural chrome', () => {
    // Spotify: a lone AXWindow. It is an ENTRY, but it names nothing and can be clicked nowhere.
    expect(axTreeIsSufficient(ax({ targetableCount: 0, namedTargetableCount: 0 }))).toBe(false);
  });

  it('rejects a tree whose targets are all positional placeholders', () => {
    expect(axTreeIsSufficient(ax({ namedTargetableCount: 0 }))).toBe(false);
  });

  it('rejects an empty tree even if the counters disagree', () => {
    expect(axTreeIsSufficient(ax({ emptyTree: true }))).toBe(false);
  });

  it('treats an unfindable query as a miss even when the tree is rich', () => {
    expect(axTreeIsSufficient(ax({ queryMissing: true }))).toBe(false);
  });
});

describe('rung selection', () => {
  it('does not pay for a menu walk when the tree already answered', () => {
    // The walk costs ~700ms-3s against ~1s for the whole observe, so a healthy tree must never
    // trigger it.
    const decision = chooseTier(ax());
    expect(decision.tier).toBe('ax_tree');
    expect(decision.consultMenus).toBe(false);
    expect(decision.consultVision).toBe(false);
  });

  it('tries the menu bar BEFORE vision when the tree cannot serve', () => {
    const decision = chooseTier(ax({ targetableCount: 0, namedTargetableCount: 0 }));
    expect(decision.tier).toBe('menu_bar');
    expect(decision.consultMenus).toBe(true);
    expect(decision.consultVision).toBe(false);
  });

  it('names the specific cause, not just that a rung changed', () => {
    // An earlier draft replaced the cause with a generic "the window tree is unusable", which told
    // the model a rung had been chosen but not what was wrong — the one fact needed to judge
    // whether a coarse command surface can serve the intent.
    const decision = refineTierWithMenus(
      ax({ targetableCount: 0, namedTargetableCount: 0 }),
      { enabledCommandCount: 27, queryMatchCount: 0 },
    );
    expect(decision.reason).toMatch(/no targetable elements/);
    expect(decision.reason).toMatch(/27 enabled commands/);
  });
});

describe('falling through to vision', () => {
  const blind = ax({ targetableCount: 0, namedTargetableCount: 0 });

  it('falls through when the menu bar was unreadable', () => {
    const decision = refineTierWithMenus(blind, null);
    expect(decision.tier).toBe('vision');
    expect(decision.consultVision).toBe(true);
  });

  it('falls through when every menu command is disabled', () => {
    // A menu bar full of dead commands is not a usable surface, and reporting it as one would be a
    // false success.
    const decision = refineTierWithMenus(blind, { enabledCommandCount: 0, queryMatchCount: 0 });
    expect(decision.tier).toBe('vision');
  });

  it('falls through when a query matches no command, however rich the menu bar', () => {
    const decision = refineTierWithMenus(
      blind,
      { enabledCommandCount: 75, queryMatchCount: 0 },
      { hasQuery: true },
    );
    expect(decision.tier).toBe('vision');
    expect(decision.reason).toMatch(/none match/);
  });

  it('stays on the menu rung when a query does match', () => {
    const decision = refineTierWithMenus(
      blind,
      { enabledCommandCount: 75, queryMatchCount: 3 },
      { hasQuery: true },
    );
    expect(decision.tier).toBe('menu_bar');
    expect(decision.consultVision).toBe(false);
  });

  it('never consults menus twice', () => {
    for (const menus of [null, { enabledCommandCount: 0, queryMatchCount: 0 }, { enabledCommandCount: 9, queryMatchCount: 1 }]) {
      expect(refineTierWithMenus(blind, menus).consultMenus).toBe(false);
    }
  });
});

describe('what the model is told', () => {
  it('says nothing extra when the tree answered', () => {
    expect(describeLadder(chooseTier(ax()), null)).toBe('');
  });

  it('warns that the menu surface is commands, not content', () => {
    const decision = refineTierWithMenus(
      ax({ targetableCount: 0, namedTargetableCount: 0 }),
      { enabledCommandCount: 27, queryMatchCount: 0 },
    );
    const text = describeLadder(decision, { enabledCommandCount: 27, queryMatchCount: 0 });
    expect(text).toMatch(/MENU BAR/);
    expect(text).toMatch(/exact names, not guesses/);
  });
});
