import { unnamedTypingRefusal } from '../desktop.runtime';

/**
 * An unnamed `type` was refused whenever a frame held more than one editable field, regardless of
 * which one had keyboard focus.
 *
 * Measured live 2026-08-18: Messages completed because "Search" matched a semantic query, but in
 * Spotify/Music the same field matched nothing, so the model fell back to an unqualified type and
 * was told to "name the intended field" — advice it could not follow, because no query resolved.
 * It clicked the field, typed, was refused, and repeated: 40 actions without sending a keystroke.
 */
const field = (over: Record<string, unknown> = {}) => ({
  role: 'AXTextField', editable: true, ...over,
});

describe('unnamed typing is decided by focus, not by field count', () => {
  it('allows typing when exactly one editable field holds focus', () => {
    expect(unnamedTypingRefusal([
      field({ label: 'Search', focused: true }),
      field({ label: 'Message' }),
      field({ label: 'Address' }),
    ])).toBeNull();
  });

  it('still refuses when several editable fields exist and none is focused', () => {
    const refusal = unnamedTypingRefusal([
      field({ label: 'Search' }),
      field({ label: 'Message' }),
    ]);
    expect(refusal).toContain('ambiguous');
    expect(refusal).toContain('Search');
    expect(refusal).toContain('Message');
    // The advice must include the escape hatch the old message lacked.
    expect(refusal).toMatch(/click it first so focus decides/);
  });

  it('refuses when focus is contested by two editable fields', () => {
    expect(unnamedTypingRefusal([
      field({ label: 'Search', focused: true }),
      field({ label: 'Message', focused: true }),
    ])).toContain('ambiguous');
  });

  it('allows a single editable field whether or not focus is reported', () => {
    expect(unnamedTypingRefusal([field({ label: 'Search' })])).toBeNull();
    expect(unnamedTypingRefusal([field({ label: 'Search', focused: true })])).toBeNull();
  });

  it('ignores non-editable elements when counting', () => {
    expect(unnamedTypingRefusal([
      field({ label: 'Search', focused: true }),
      { role: 'AXStaticText', label: 'Mom 2' },
      { role: 'AXButton', label: 'Compose' },
    ])).toBeNull();
  });
});
