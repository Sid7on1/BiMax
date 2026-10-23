import { requireNetworkConsent, resetNetworkConsent, networkConsentState } from '../security/network.consent';

/**
 * Reaching the network is the user's decision, asked once per host per session.
 *
 * Both web tools declared `isDestructive: false`, so the governor was never consulted and a turn
 * could read the internet with nothing said. Per-CALL approval would be the obvious fix and the
 * wrong one — a research turn makes dozens of fetches, and a prompt per fetch trains the user to
 * approve without reading.
 */
describe('network consent', () => {
  beforeEach(() => resetNetworkConsent());

  const approving = (): any => ({ approveTaskExecution: jest.fn().mockResolvedValue(undefined) });
  const refusing = (): any => ({ approveTaskExecution: jest.fn().mockRejectedValue(new Error('user declined')) });

  test('the first request to a host asks, and is allowed when approved', async () => {
    const g = approving();
    const refusal = await requireNetworkConsent(g, { target: 'https://docs.python.org/3/', tool: 'WebFetchTool', purpose: 'read docs' });
    expect(refusal).toBeNull();
    expect(g.approveTaskExecution).toHaveBeenCalledTimes(1);
  });

  test('a second request to the SAME host does not ask again', async () => {
    const g = approving();
    await requireNetworkConsent(g, { target: 'https://docs.python.org/3/', tool: 'WebFetchTool', purpose: 'a' });
    await requireNetworkConsent(g, { target: 'https://docs.python.org/library/socket.html', tool: 'WebFetchTool', purpose: 'b' });
    expect(g.approveTaskExecution).toHaveBeenCalledTimes(1);
  });

  test('a DIFFERENT host asks again — one grant is not a blanket grant', async () => {
    const g = approving();
    await requireNetworkConsent(g, { target: 'https://docs.python.org/3/', tool: 'WebFetchTool', purpose: 'a' });
    await requireNetworkConsent(g, { target: 'https://example.com/paper.pdf', tool: 'WebFetchTool', purpose: 'b' });
    expect(g.approveTaskExecution).toHaveBeenCalledTimes(2);
  });

  test('a refusal is returned to the model and remembered, not re-asked', async () => {
    const g = refusing();
    const first = await requireNetworkConsent(g, { target: 'https://example.com', tool: 'WebFetchTool', purpose: 'a' });
    expect(first).toMatch(/declined/i);
    const second = await requireNetworkConsent(g, { target: 'https://example.com/other', tool: 'WebFetchTool', purpose: 'b' });
    expect(second).toMatch(/declined/i);
    // Asked once. Re-asking after a refusal is how a refusal becomes a war of attrition.
    expect(g.approveTaskExecution).toHaveBeenCalledTimes(1);
  });

  test('the session state is inspectable and resets', async () => {
    const g = approving();
    await requireNetworkConsent(g, { target: 'https://a.example', tool: 'WebFetchTool', purpose: 'x' });
    expect(networkConsentState()).toEqual([{ host: 'a.example', verdict: 'granted' }]);
    resetNetworkConsent();
    expect(networkConsentState()).toEqual([]);
  });
});
