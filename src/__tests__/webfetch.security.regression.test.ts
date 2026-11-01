import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { boundedBody, fetchPublicText, publicIp, publicUrl } from '../tools/implementations/public-request';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:http', () => ({ ...jest.requireActual('node:http'), request: jest.fn() }));
jest.mock('node:https', () => ({ ...jest.requireActual('node:https'), request: jest.fn() }));

type Reply = { status?: number; headers?: Record<string, string>; chunks?: Buffer[] };
let replies: Reply[], reached: Array<{ url: string; address: string; family: number }>, streams: Readable[];
beforeEach(() => {
  replies = [];
  reached = [];
  streams = [];
  jest
    .mocked(lookup)
    .mockReset()
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  const implement = (url: URL, options: http.RequestOptions, receive: (res: http.IncomingMessage) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      let ended = false;
      const abort = () => {
        if (!ended) {
          ended = true;
          req.emit('error', options.signal?.reason || new Error('aborted'));
        }
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      options.lookup!(url.hostname, {}, (error, address, family) => {
        options.signal?.removeEventListener('abort', abort);
        if (ended) return;
        ended = true;
        if (error) {
          req.emit('error', error);
          return;
        }
        if (typeof address !== 'string' || family === undefined) throw new Error('Unexpected multi-address lookup');
        reached.push({ url: url.href, address, family });
        const reply = replies.shift() || {},
          res = Readable.from(reply.chunks || [Buffer.from('fixture')]);
        Object.assign(res, { statusCode: reply.status || 200, statusMessage: 'OK', headers: reply.headers || {} });
        streams.push(res);
        receive(res as unknown as http.IncomingMessage);
      });
    };
    return req as unknown as http.ClientRequest;
  };
  jest
    .mocked(http.request)
    .mockReset()
    .mockImplementation(implement as typeof http.request);
  jest
    .mocked(https.request)
    .mockReset()
    .mockImplementation(implement as typeof https.request);
});

test.each([
  '127.0.0.1',
  '::1',
  '::ffff:7f00:1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.0.1',
  '169.254.169.254',
  '100.64.0.1',
  'fc00::1',
  'fe80::1',
])('F05 rejects non-public literal %s', (ip) => expect(publicIp(ip)).toBe(false));
test.each([
  'http://[::ffff:127.0.0.1]/',
  'http://2130706433/',
  'http://localhost./',
  'http://name.internal/',
  'file:///etc/passwd',
  'https://user:secret@example.com/',
])('F05 refuses %s without a socket', async (url) => {
  await expect(fetchPublicText(url, async () => {})).rejects.toThrow();
  expect(http.request).not.toHaveBeenCalled();
  expect(https.request).not.toHaveBeenCalled();
});
test('F05 connects using the single validated DNS answer while retaining the original TLS host', async () => {
  expect(publicIp('8.8.8.8')).toBe(true);
  expect(publicIp('2606:4700:4700::1111')).toBe(true);
  await fetchPublicText('https://public-fixture.invalid/', async () => {});
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(reached).toEqual([{ url: 'https://public-fixture.invalid/', address: '93.184.216.34', family: 4 }]);
  expect(https.request).toHaveBeenCalledWith(
    new URL('https://public-fixture.invalid/'),
    expect.objectContaining({ agent: false, autoSelectFamily: false }),
    expect.any(Function),
  );
});
test('F05 rejects private and mixed DNS results before a connection', async () => {
  jest.mocked(lookup).mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ] as never);
  await expect(fetchPublicText('https://public-fixture.invalid/', async () => {})).rejects.toThrow('non-public');
  expect(reached).toEqual([]);
});
test('F05 redirects revalidate destination and cannot reuse public-host consent for a private target', async () => {
  replies.push({ status: 302, headers: { location: 'http://127.0.0.1/secret' } });
  const authorize = jest.fn(async () => {});
  await expect(fetchPublicText('https://public-fixture.invalid/', authorize)).rejects.toThrow('Non-public');
  expect(reached).toHaveLength(1);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(streams[0].destroyed).toBe(true);
});
test('F05 each allowed redirect has separate policy admission; loops and HTTPS downgrades stop', async () => {
  replies.push(
    { status: 302, headers: { location: 'https://other-fixture.invalid/' } },
    { chunks: [Buffer.from('result')] },
  );
  const authorized: string[] = [];
  expect(
    (
      await fetchPublicText('https://public-fixture.invalid/', async (url) => {
        authorized.push(url.host);
      })
    ).body,
  ).toBe('result');
  expect(authorized).toEqual(['public-fixture.invalid', 'other-fixture.invalid']);
  replies.push({ status: 302, headers: { location: 'http://other-fixture.invalid/' } });
  await expect(fetchPublicText('https://public-fixture.invalid/', async () => {})).rejects.toThrow('downgrade');
  replies.push(
    ...Array.from({ length: 6 }, () => ({ status: 302, headers: { location: 'https://loop-fixture.invalid/' } })),
  );
  await expect(fetchPublicText('https://loop-fixture.invalid/', async () => {})).rejects.toThrow('redirects');
});
test('F05 Stop before/during DNS prevents socket admission', async () => {
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await expect(fetchPublicText('https://public-fixture.invalid/', async () => {}, stop.signal)).rejects.toThrow(
    'stopped',
  );
  expect(reached).toEqual([]);
  const pending = new AbortController();
  let resolveDns!: (value: unknown) => void;
  jest.mocked(lookup).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveDns = resolve;
      }) as never,
  );
  const job = fetchPublicText('https://public-fixture.invalid/', async () => {}, pending.signal);
  await new Promise((resolve) => setImmediate(resolve));
  pending.abort(new Error('stopped during DNS'));
  await expect(job).rejects.toThrow('stopped during DNS');
  resolveDns([{ address: '93.184.216.34', family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  expect(reached).toEqual([]);
});
test('F06 rejects declared and chunked overflow, destroys streams, and preserves split UTF-8', async () => {
  const make = (headers: Record<string, string>, chunks: Buffer[]) =>
    Object.assign(Readable.from(chunks), { headers }) as unknown as http.IncomingMessage;
  const declared = make({ 'content-length': '2097152' }, []);
  await expect(boundedBody(declared, 1024)).rejects.toThrow('byte budget');
  expect(declared.destroyed).toBe(true);
  const chunked = make({}, [Buffer.alloc(1000), Buffer.alloc(1000)]);
  await expect(boundedBody(chunked, 1024)).rejects.toThrow('byte budget');
  expect(chunked.destroyed).toBe(true);
  const compressed = make({ 'content-encoding': 'gzip' }, [Buffer.from('compressed')]);
  await expect(boundedBody(compressed, 1024)).rejects.toThrow('Compressed');
  expect(compressed.destroyed).toBe(true);
  expect(await boundedBody(make({}, [Buffer.from([0xce]), Buffer.from([0xb1])]), 1024)).toBe('α');
});
