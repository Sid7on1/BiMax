import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
const forbidden = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  forbidden.addSubnet(address, bits, 'ipv4');
for (const [address, bits] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const)
  forbidden.addSubnet(address, bits, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
export function publicIp(ip: string): boolean {
  const family = isIP(ip);
  return family === 4
    ? !forbidden.check(ip, 'ipv4')
    : family === 6 && globalV6.check(ip, 'ipv6') && !forbidden.check(ip, 'ipv6');
}
export function publicUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 8192) throw Error('Invalid URL');
  const url = new URL(raw),
    host = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('Only credential-free HTTP(S) is allowed');
  if (
    !host ||
    host === 'localhost' ||
    ['.localhost', '.local', '.internal', '.lan', '.home.arpa'].some((s) => host.endsWith(s))
  )
    throw Error('Internal hostname refused');
  if (isIP(host) && !publicIp(host)) throw Error('Non-public IP refused');
  return url;
}
async function request(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        ...{ autoSelectFamily: false },
        maxHeaderSize: 16384,
        headers: {
          'User-Agent': 'BiMax-Agent/1.0 (+https://bimax.ai)',
          Accept: 'text/html,application/json,text/plain',
          'Accept-Encoding': 'identity',
        },
        lookup: (hostname, _options, callback) => {
          void lookup(hostname, { all: true, verbatim: true })
            .then((records) => {
              signal.throwIfAborted();
              if (!records.length || records.some((r) => !publicIp(r.address)))
                throw Error('DNS resolved a non-public address');
              const selected = records[0];
              callback(null, selected.address, selected.family);
            })
            .catch((error) => callback(error as NodeJS.ErrnoException, '', 0));
        },
      },
      resolve,
    );
    req.once('error', reject);
    req.end();
  });
}
/** Reads at most maxBytes raw bytes. Compressed responses refuse, so decoding cannot expand them. */
export async function boundedBody(res: IncomingMessage, maxBytes: number): Promise<string> {
  try {
    const encoding = res.headers['content-encoding'];
    if (encoding && encoding.toLowerCase() !== 'identity') throw Error('Compressed response refused');
    const declared = res.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maxBytes)))
      throw Error('Response exceeds byte budget');
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const raw of res) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > maxBytes) throw Error('Response exceeds byte budget');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    res.destroy();
  }
}
export async function fetchPublicText(raw: string, authorize: (url: URL) => Promise<void>, caller?: AbortSignal) {
  const deadline = AbortSignal.timeout(30000),
    signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
  let url = publicUrl(raw);
  for (let hop = 0; hop <= 5; hop++) {
    signal.throwIfAborted();
    await authorize(url);
    signal.throwIfAborted();
    const res = await request(url, signal);
    if ([301, 302, 303, 307, 308].includes(res.statusCode || 0)) {
      const location = res.headers.location;
      res.destroy();
      if (!location || hop === 5) throw Error('Invalid or excessive redirects');
      const next = publicUrl(new URL(location, url).href);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw Error('HTTPS downgrade refused');
      url = next;
      continue;
    }
    const body = await boundedBody(res, 1024 * 1024);
    signal.throwIfAborted();
    return {
      status: res.statusCode || 0,
      statusText: res.statusMessage || '',
      contentType: String(res.headers['content-type'] || ''),
      body,
    };
  }
  throw Error('Too many redirects');
}
