import * as fs from 'fs';
import * as path from 'path';
import { requireNetworkConsent, resetNetworkConsent } from '../security/network.consent';
import { resetSovereignMode, setSovereignAllowlist, setSovereignMode } from '../security/sovereign';
import { resetSessionEgress, summarize } from '../security/egress.ledger';

/**
 * A guard nothing calls proves nothing.
 *
 * The classifier is unit-tested next door; what this file protects is the property that every seam
 * capable of reaching the network actually routes through it. That property is not visible from
 * any single unit test — it is a statement about the whole codebase — so the enumeration is
 * asserted directly against the source. A new egress surface added without a guard fails here,
 * which is the only moment anyone would notice before an audit does.
 */
const ROOT = path.resolve(__dirname, '..');

/** Every file that can originate an outbound request, and what it must route through. */
const EGRESS_SURFACES = [
  'core/llm.adapter.ts',                    // every model request
  'security/network.consent.ts',            // WebFetchTool + WebSearchTool, via consent
];

describe('egress surfaces are guarded', () => {
  for (const rel of EGRESS_SURFACES) {
    test(`${rel} routes through the egress guard`, () => {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // Accepts both spellings of the import: `./egress.guard` from inside security/, and
      // `../security/egress.guard` from anywhere else.
      expect(source).toMatch(/from '(\.\.?\/)+(security\/)?egress\.guard'/);
      expect(source).toMatch(/assertEgressAllowed|checkEgress/);
    });
  }

  test('the web tools still reach the network only through consent', () => {
    // Guarding `network.consent.ts` only covers the web tools while they keep calling it. If a tool
    // ever fetches directly, its guard disappears silently — so the call site is pinned too.
    for (const tool of ['tools/implementations/webfetch.tool.ts', 'tools/implementations/websearch.tool.ts']) {
      const source = fs.readFileSync(path.join(ROOT, tool), 'utf8');
      expect([tool, /requireNetworkConsent\(/.test(source)]).toEqual([tool, true]);
    }
  });
});

describe('sovereign mode reaches the consent path', () => {
  beforeEach(() => {
    resetNetworkConsent();
    resetSessionEgress();
    resetSovereignMode();
    setSovereignAllowlist([]);
    process.env.BIMAX_EGRESS_LEDGER = path.join(
      fs.mkdtempSync(path.join(require('os').tmpdir(), 'egress-boundary-')), 'egress.ledger',
    );
  });

  afterEach(() => {
    delete process.env.BIMAX_EGRESS_LEDGER;
    resetSovereignMode();
  });

  const governor = (): any => ({ approveTaskExecution: jest.fn().mockResolvedValue(undefined) });

  test('an external fetch is refused WITHOUT asking the user', async () => {
    setSovereignMode(true);
    const g = governor();
    const refusal = await requireNetworkConsent(g, {
      target: 'https://docs.python.org/3/',
      tool: 'WebFetchTool',
      purpose: 'read docs',
    });

    expect(refusal).toMatch(/sovereign/i);
    // Asking would be worse than not asking: the deployment cannot honour an "allow" answer, and a
    // prompt the user can't meaningfully act on teaches them to click through prompts.
    expect(g.approveTaskExecution).not.toHaveBeenCalled();
    expect(summarize()).toMatchObject({ external: 1, refused: 1 });
  });

  test('with the mode off the user is still asked, and the attempt is still recorded', async () => {
    setSovereignMode(false);
    const g = governor();
    const refusal = await requireNetworkConsent(g, {
      target: 'https://docs.python.org/3/',
      tool: 'WebFetchTool',
      purpose: 'read docs',
    });

    expect(refusal).toBeNull();
    expect(g.approveTaskExecution).toHaveBeenCalledTimes(1);
    expect(summarize()).toMatchObject({ attempts: 1, external: 1, refused: 0 });
  });

  test('a local endpoint is not refused by the mode', async () => {
    setSovereignMode(true);
    const g = governor();
    const refusal = await requireNetworkConsent(g, {
      target: 'http://localhost:11434/v1/chat/completions',
      tool: 'WebFetchTool',
      purpose: 'local model',
    });
    expect(refusal).toBeNull();
  });
});
