import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThinkingIndicator } from '../renderer/src/components/ThinkingIndicator';
import { EngineStore } from '../renderer/src/engine.store';
import { Outbound } from '../renderer/src/protocol';

/**
 * A turn that is waiting on the provider says why. The engine always sent "Provider hiccup —
 * retrying in 2s" and "Rate limit — waiting 12s…", but the in-flight row showed only a rotating
 * word, so a 45-second provider stall looked exactly like a hang.
 */

test('the in-flight row shows the engine status when there is one', () => {
  const html = renderToStaticMarkup(<ThinkingIndicator thinking="" status="Rate limit — waiting 12s for a free slot on 3 keys" />);
  expect(html).toContain('Rate limit — waiting 12s for a free slot on 3 keys');
  expect(html).toContain('aria-live="polite"');
});

test('and nothing extra when there is none', () => {
  expect(renderToStaticMarkup(<ThinkingIndicator thinking="" />)).not.toContain('thinking-status');
});

test('the stream slice the transcript reads carries the status', () => {
  const store = new EngineStore();
  store.dispatch({ type: 'outbound', msg: { t: 'event', name: 'status', args: ['Provider hiccup — retrying in 2s (1/2)'] } as Outbound });
  expect(store.domains.stream.getSnapshot().status).toBe('Provider hiccup — retrying in 2s (1/2)');
});
