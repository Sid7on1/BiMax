import { PUBLIC_DESKTOP_ACTIONS } from '../desktop.runtime';
import { computerExecutionRecipe } from '../execution.recipe';

describe('computer execution recipes', () => {
  it('classifies every public action into one coordinator serialization lane', () => {
    for (const action of PUBLIC_DESKTOP_ACTIONS) {
      const recipe = computerExecutionRecipe({ action });
      expect(['concurrent-read', 'machine-exclusive']).toContain(recipe.serialization);
      expect(recipe.mutatesDesktop).toBe(recipe.serialization === 'machine-exclusive');
    }
  });

  it('keeps observation concurrent while all input and state mutation are exclusive', () => {
    for (const action of ['status', 'apps', 'windows', 'observe', 'screenshot', 'cursor', 'frontmost', 'wait', 'record_status'] as const) {
      expect(computerExecutionRecipe({ action }).serialization).toBe('concurrent-read');
    }
    for (const action of ['open', 'focus', 'click', 'type', 'key', 'drag', 'scroll', 'clipboard', 'record_start', 'record_stop', 'menu_activate', 'menu_search'] as const) {
      expect(computerExecutionRecipe({ action }).serialization).toBe('machine-exclusive');
    }
  });
});
