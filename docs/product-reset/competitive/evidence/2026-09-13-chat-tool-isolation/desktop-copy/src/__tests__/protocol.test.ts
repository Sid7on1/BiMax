import { EventEmitter } from 'events';
import { encode, LineDecoder } from '../protocol/codec';
import { ProtocolHost } from '../protocol/host';
import {
  Outbound, Inbound, sanitizeArgs, PROTOCOL_VERSION, PROTOCOL_SEMVER,
  PROTOCOL_MIN_COMPATIBLE_MAJOR, PROTOCOL_MAX_COMPATIBLE_MAJOR,
} from '../protocol/protocol';

// The protocol is the keystone of the hybrid TUI split: it lets the unchanged Node engine drive
// an out-of-process front-end. These tests pin the wire framing and the engine-side host's two
// jobs — forwarding events out, and turning the GlobalPrompter callback into a request/reply.

describe('codec — NDJSON framing', () => {
  it('round-trips a message', () => {
    const dec = new LineDecoder<Outbound>();
    const [msg] = dec.push(encode({ t: 'ready', protocol: 1 }));
    expect(msg).toEqual({ t: 'ready', protocol: 1 });
  });

  it('reassembles a message split across chunks and splits coalesced ones', () => {
    const dec = new LineDecoder<any>();
    expect(dec.push('{"t":"input",')).toEqual([]);          // partial line buffered
    const out = dec.push('"text":"hi"}\n{"t":"interrupt"}\n'); // completion + a second message
    expect(out).toEqual([{ t: 'input', text: 'hi' }, { t: 'interrupt' }]);
  });

  it('skips malformed lines via onError instead of throwing', () => {
    const bad: string[] = [];
    const dec = new LineDecoder<any>((line) => bad.push(line));
    const out = dec.push('not json\n{"t":"interrupt"}\n');
    expect(out).toEqual([{ t: 'interrupt' }]);
    expect(bad).toEqual(['not json']);
  });
});

describe('sanitizeArgs', () => {
  it('nulls out functions and marks React elements, keeping JSON-safe data', () => {
    const reactEl = { $$typeof: Symbol.for('react.element'), type: { name: 'Menu' } };
    const out = sanitizeArgs(['hello', 42, () => {}, reactEl, { ok: true }]);
    // A bare function arg is not valid JSON, so it collapses to null on the wire (not undefined).
    expect(out).toEqual(['hello', 42, null, { __ui: 'Menu' }, { ok: true }]);
  });

  it('passes primitives through unchanged (the per-token fast path)', () => {
    // null/undefined → null, booleans pass, bigint → string. No stringify→parse roundtrip.
    expect(sanitizeArgs([null, undefined, true, false, 7n])).toEqual([null, null, true, false, '7']);
    // A streamed token is a plain string — the hot case — and must survive verbatim.
    expect(sanitizeArgs(['the token'])).toEqual(['the token']);
  });
});

describe('ProtocolHost', () => {
  let emitter: EventEmitter;
  let sent: Outbound[];
  let host: ProtocolHost;
  let inputs: string[];

  beforeEach(() => {
    emitter = new EventEmitter();
    sent = [];
    inputs = [];
    host = new ProtocolHost((m) => sent.push(m), { onInput: (t) => inputs.push(t) });
    host.attach(emitter);
  });
  afterEach(() => host.detach());

  it('emits a handshake on attach', () => {
    expect(sent[0]).toMatchObject({
      t: 'hello', protocolVersion: PROTOCOL_SEMVER, protocolMajor: PROTOCOL_VERSION,
      minCompatibleMajor: PROTOCOL_MIN_COMPATIBLE_MAJOR,
      maxCompatibleMajor: PROTOCOL_MAX_COMPATIBLE_MAJOR,
      engine: { version: expect.any(String), buildCommit: expect.any(String) },
    });
    expect(sent[1]).toEqual({ t: 'ready', protocol: PROTOCOL_VERSION });
  });

  it('forwards a cliEvents emit as an event message with sanitized args', () => {
    emitter.emit('status', 'Indexing…');
    expect(sent).toContainEqual({ t: 'event', name: 'status', args: ['Indexing…'] });
  });

  it('translates a veto_prompt into a request and resolves it on the matching reply', () => {
    let answer: string | undefined;
    // GlobalPrompter emits veto_prompt(question, options, resolve).
    emitter.emit('veto_prompt', 'Run rm -rf?', ['Yes', 'No'], (a: string) => { answer = a; });

    const req = sent.find(m => m.t === 'request') as any;
    expect(req).toMatchObject({ t: 'request', kind: 'prompt', question: 'Run rm -rf?', options: ['Yes', 'No'] });
    expect(host.pendingCount()).toBe(1);

    host.ingest({ t: 'reply', id: req.id, value: 'No' } as Inbound);
    expect(answer).toBe('No');
    expect(host.pendingCount()).toBe(0);
  });

  it('announces approval lifecycle exactly once for review observers', () => {
    const pending: any[] = [];
    const resolved: any[] = [];
    emitter.on('request_pending', (event) => pending.push(event));
    emitter.on('request_resolved', (event) => resolved.push(event));
    emitter.emit('diff_prompt', 'Edit foo.ts', 'diff body', () => {});
    const req = sent.find(m => m.t === 'request') as any;

    expect(pending).toEqual([{ id: req.id, kind: 'diff', question: 'Edit foo.ts', isAsk: false }]);
    host.ingest({ t: 'reply', id: req.id, value: 'Reject' } as Inbound);
    host.ingest({ t: 'reply', id: req.id, value: 'Approve' } as Inbound); // stale duplicate
    expect(resolved).toEqual([{ id: req.id, value: 'Reject' }]);
  });

  it('never re-announces free-form input values that may contain secrets', () => {
    const resolved: any[] = [];
    emitter.on('request_resolved', (event) => resolved.push(event));
    emitter.emit('input_prompt', 'Paste the value:', () => {}, { masked: true });
    const req = sent.find(m => m.t === 'request') as any;
    host.ingest({ t: 'reply', id: req.id, value: 'super-secret' } as Inbound);
    expect(resolved).toEqual([]);
  });

  it('translates a diff_prompt into a diff request carrying the diff body', () => {
    let approved: string | undefined;
    emitter.emit('diff_prompt', 'Edit foo.ts', '@@ -1 +1 @@\n-old\n+new', (a: string) => { approved = a; });

    const req = sent.find(m => m.t === 'request') as any;
    expect(req).toMatchObject({ t: 'request', kind: 'diff', question: 'Edit foo.ts', options: ['Approve', 'Reject'] });
    expect(req.body).toContain('+new');

    host.ingest({ t: 'reply', id: req.id, value: 'Approve' } as Inbound);
    expect(approved).toBe('Approve');
  });

  it('translates an input_prompt into a free-form input request', () => {
    let got: string | undefined;
    emitter.emit('input_prompt', 'Enter API key:', (a: string) => { got = a; });
    const req = sent.find(m => m.t === 'request') as any;
    expect(req).toMatchObject({ t: 'request', kind: 'input', question: 'Enter API key:', options: [], masked: false });
    host.ingest({ t: 'reply', id: req.id, value: 'sk-123' } as Inbound);
    expect(got).toBe('sk-123');
  });

  it('carries the masked flag so secret prompts are masked by contract, not by wording', () => {
    emitter.emit('input_prompt', 'Paste the value:', () => {}, { masked: true });
    const req = sent.find(m => m.t === 'request') as any;
    expect(req).toMatchObject({ t: 'request', kind: 'input', question: 'Paste the value:', masked: true });
  });

  it('routes inbound input to the handler and ignores stale replies', () => {
    host.ingest({ t: 'input', text: 'refactor the parser' });
    expect(inputs).toEqual(['refactor the parser']);
    expect(() => host.ingest({ t: 'reply', id: 999, value: 'x' } as Inbound)).not.toThrow();
  });

  it('answers a ping with a pong echoing the id (the TUI heartbeat)', () => {
    host.ingest({ t: 'ping', id: 7 } as Inbound);
    expect(sent).toContainEqual({ t: 'pong', id: 7 });
  });

  it('routes validated shell controls as one atomic handler call', () => {
    const controls: any[] = [];
    const controlHost = new ProtocolHost(() => {}, { onControls: (value) => { controls.push(value); } });
    controlHost.ingest({ t: 'controls', mode: 'code', tier: 'heavy', autonomy: 'ask' });
    controlHost.ingest({ t: 'controls', mode: 'invalid' as any, tier: 'lite' });
    expect(controls).toEqual([
      { mode: 'code', tier: 'heavy', autonomy: 'ask' },
      { mode: undefined, tier: 'lite', autonomy: undefined },
    ]);
  });

  it('does not leak listeners after detach', () => {
    expect(emitter.listenerCount('status')).toBe(1);
    host.detach();
    expect(emitter.listenerCount('status')).toBe(0);
  });
});


describe('pending approvals at a task boundary', () => {
  it.each([{ t: 'interrupt' }, { t: 'input', text: '/clear force' }])('cancels requests for %j and ignores late approval', (message) => {
    const emitter = new EventEmitter();
    const resolve = jest.fn();
    const resolved = jest.fn();
    const interrupt = jest.fn();
    const wire: Outbound[] = [];
    const host = new ProtocolHost(msg => wire.push(msg), { onInterrupt: interrupt });
    host.attach(emitter);
    emitter.on('request_resolved', resolved);
    try {
      emitter.emit('veto_prompt', 'Write file?', ['Approve', 'Reject'], resolve);
      const request = wire.find(msg => msg.t === 'request') as any;
      host.ingest(message as Inbound);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith('');
      expect(host.pendingCount()).toBe(0);
      expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ interrupted: true }));
      host.ingest({ t: 'reply', id: request.id, value: 'Approve' });
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally { host.detach(); }
  });
});
