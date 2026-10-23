import { classifyStreamError, normalizeProviderErrorResponse } from '../core/llm.adapter';

/**
 * The agent loop relies on this classification to decide whether a streaming error is
 * fatal, fixable by compaction, or worth a fresh re-ask. Getting the buckets right is
 * what keeps a transient provider hiccup from killing the whole task.
 */
describe('classifyStreamError', () => {
  it('marks context overflow as recoverable via compaction', () => {
    expect(classifyStreamError(new Error('This model maximum context length is 8192 tokens')))
      .toMatchObject({ recoverable: true, kind: 'context' });
    expect(classifyStreamError({ code: 'context_length_exceeded', message: 'too long' }))
      .toMatchObject({ recoverable: true, kind: 'context' });
    expect(classifyStreamError({ status: 413, message: 'payload too large' }))
      .toMatchObject({ recoverable: true, kind: 'context' });
  });

  it('marks a single bad model emission as transient', () => {
    for (const msg of [
      '400 Unterminated string starting at: line 1 column 112',
      '400 This model only supports single tool-calls at once!',
      "the timeout parameter value '300000' is out of range",
    ]) {
      expect(classifyStreamError({ status: 400, message: msg }))
        .toMatchObject({ recoverable: true, kind: 'transient' });
    }
  });

  it('marks stalled streams and server errors as transient', () => {
    expect(classifyStreamError(new Error('Stream read timeout: no data from the API for 60s')))
      .toMatchObject({ status: 408, recoverable: true, kind: 'transient' });
    // The model-naming timeout message must still classify as a recoverable stall.
    expect(classifyStreamError(new Error("LLM stream timeout: model 'minimax-m3' sent no first token for 180s (provider NIM cold/slow — not a tool error)")))
      .toMatchObject({ status: 408, recoverable: true, kind: 'transient' });
    expect(classifyStreamError({ status: 503, message: 'service unavailable' }))
      .toMatchObject({ recoverable: true, kind: 'transient' });
  });

  it('retries empty NVIDIA edge 410s but keeps descriptive 410s fatal', () => {
    expect(classifyStreamError({ status: 410, message: '410 status code (no body)' }))
      .toEqual({ status: 410, recoverable: true, kind: 'transient' });
    expect(classifyStreamError({ status: 410, message: 'model endpoint has been retired' }))
      .toEqual({ status: 410, recoverable: false });
  });

  it('marks a 429 rate limit as transient and surfaces Retry-After for backoff', () => {
    // No header → recoverable transient, no explicit wait (loop falls back to exponential backoff).
    expect(classifyStreamError({ status: 429, message: 'rate limit exceeded' }))
      .toMatchObject({ status: 429, recoverable: true, kind: 'transient', retryAfterSecs: undefined });
    // Provider sent Retry-After → it's parsed and carried through so the loop can honor it.
    expect(classifyStreamError({ status: 429, message: 'slow down', headers: { 'retry-after': '12' } }))
      .toMatchObject({ recoverable: true, kind: 'transient', retryAfterSecs: 12 });
  });

  it('treats genuine client errors as fatal', () => {
    expect(classifyStreamError({ status: 401, message: 'invalid api key' }))
      .toMatchObject({ recoverable: false });
    expect(classifyStreamError({ status: 400, message: 'invalid request: unknown field' }))
      .toMatchObject({ recoverable: false });
  });
});

describe('normalizeProviderErrorResponse', () => {
  it('preserves NVIDIA RFC 7807 details that the OpenAI SDK otherwise reports as no body', async () => {
    const response = new Response(JSON.stringify({
      type: 'about:blank',
      title: 'Gone',
      status: 410,
      detail: "The model 'stepfun-ai/step-3.7-flash' has reached its end of life.",
    }), { status: 410, headers: { 'content-type': 'application/problem+json' } });

    const normalized = await normalizeProviderErrorResponse(response);

    expect(normalized.status).toBe(410);
    expect(await normalized.json()).toEqual({ error: {
      message: "The model 'stepfun-ai/step-3.7-flash' has reached its end of life.",
      type: 'gone',
      code: 'model_gone',
    } });
  });

  it('does not rewrite successful responses', async () => {
    const response = new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await normalizeProviderErrorResponse(response)).toBe(response);
  });
});
