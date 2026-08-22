import { classifyAxReadiness } from '../ax.readiness';
import { decideMenuAdapter } from '../menu.intent';
import { isCompleteMenuSearchTransaction, MENU_SEARCH_TRANSACTION_STAGES } from '../menu.transaction';
import { MAC_CONTROL_SCHEMA } from '../server';

describe('packaged-provider adaptive CU journeys', () => {
  it('cold launch can move from AX warming to ready instead of latching AX-poor', () => {
    const cold = classifyAxReadiness({ targetableCount: 1, namedTargetableCount: 0, editableCount: 0 }, undefined, 0);
    const stable = classifyAxReadiness(
      { targetableCount: 1500, namedTargetableCount: 900, editableCount: 1 },
      { targetableCount: 1, namedTargetableCount: 0, sparseSamples: 1 },
      1,
    );
    expect([cold.state, stable.state]).toEqual(['warming', 'ready']);
  });

  it('stable AX serves content without paying for the menu adapter', () => {
    expect(decideMenuAdapter({ query: 'Search', axReady: true, nativeQueryMatched: true }))
      .toMatchObject({ consultMenus: false, visionEligible: false });
  });

  it('search-result selection is one six-stage verified transaction', () => {
    expect(MENU_SEARCH_TRANSACTION_STAGES).toEqual([
      'open_search', 'type', 'reobserve', 'ground_result', 'select', 'verify',
    ]);
    expect(isCompleteMenuSearchTransaction(MENU_SEARCH_TRANSACTION_STAGES.map(stage => ({ stage, ok: true }))))
      .toBe(true);
    expect(MAC_CONTROL_SCHEMA.properties).not.toHaveProperty('deliveryMode');
  });

  it('forced AX-opaque content takes the visual path even though app menus exist', () => {
    expect(decideMenuAdapter({ query: 'Requested visual result', axReady: false, nativeQueryMatched: false }))
      .toMatchObject({ kind: 'content', consultMenus: false, visionEligible: true });
  });
});
