import { app, BrowserWindow, ipcMain, clipboard } from 'electron';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createIdentity } from 'desktop-responder';
import { PairingManager, formatVerificationCode } from '@bimax/core/session/session';
import { buildTransportConfirmation } from '@bimax/core/session/lifecycle';
import { parseAdvertisement } from '@bimax/core/crypto/pairing';
import { generateX25519Keypair, generateEd25519Keypair, ed25519Sign } from '@bimax/core/crypto/keys';
import { RelayClient } from 'mobile-phone-client';
import {
  MobileConnection as SourceMobileConnection,
  registerMobileConnection as sourceRegisterMobileConnection,
} from '../../src/main/responder/mobile.connection';
import { isTrustedSender, REQUIRED_WEB_PREFERENCES } from '../../src/main/security';
const packaged = process.env.BIMAX_PHONE_APP_ASAR;
const packedRuntime = packaged
  ? require(
      path.join(
        packaged,
        'out/main/chunks',
        readdirSync(path.join(packaged, 'out/main/chunks')).find((name) => /^mobile\.connection-.*\.js$/.test(name))!,
      ),
    )
  : undefined;
const MobileConnection: typeof SourceMobileConnection = packedRuntime?.MobileConnection ?? SourceMobileConnection;
const registerMobileConnection: typeof sourceRegisterMobileConnection =
  packedRuntime?.registerMobileConnection ?? sourceRegisterMobileConnection;
const prefix = packaged ? 'packaged-' : '';
const directory = mkdtempSync(path.join(tmpdir(), 'bimax-phone-settings-'));
app.setPath('userData', path.join(directory, 'profile'));
const checks: string[] = [];
const wait = async (fn: () => unknown, description: string) => {
  const until = Date.now() + 12000;
  while (!(await fn())) {
    if (Date.now() > until) throw new Error('Timed out: ' + description);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};
let window: BrowserWindow, connection: SourceMobileConnection, phone: RelayClient;
const master = randomBytes(32);
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'fixture-encryption',
  encryptString: (text: string) => {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', master, nonce);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), data]);
  },
  decryptString: (data: Buffer) => {
    const decipher = createDecipheriv('aes-256-gcm', master, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString();
  },
};
const results = { checks, physicalPhone: false, realEngineEffects: false, packagedRuntime: !!packaged };
app
  .whenReady()
  .then(async () => {
    const identity = createIdentity('desktop-settings-fixture');
    const appRoot = process.env.BIMAX_PHONE_APP_ROOT!;
    const fixture = path.join(appRoot, 'out/mobile-fixture/index.html');
    window = new BrowserWindow({
      width: 1100,
      height: 850,
      show: false,
      webPreferences: {
        ...REQUIRED_WEB_PREFERENCES,
        preload: path.join(packaged ?? appRoot, packaged ? 'out/preload/index.js' : 'out/preload/index.js'),
      },
    });
    const threads = { activeId: null, list: () => [], kill: async () => {}, stop: () => {} } as never;
    const options = {
      threads,
      onAdapter: () => {},
      directory,
      identity,
      port: 0,
      storage: storage as never,
      addresses: () => [{ address: '127.0.0.1', name: 'fixture' }],
    };
    connection = new MobileConnection(options);
    let holdEnable = true;
    let delayedEnableSettled = false;
    let releaseEnable!: () => void;
    const enableGate = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    const trusted = { webContentsId: window.webContents.id, packagedRendererUrls: [pathToFileURL(fixture).href] };
    const handle = (channel: string, fallback: unknown, fn: (event: any, ...args: any[]) => unknown) =>
      ipcMain.handle(channel, (event, ...args) =>
        isTrustedSender(
          {
            senderId: event.sender.id,
            frameUrl: event.senderFrame?.url,
            isMainFrame: event.senderFrame === event.senderFrame?.top,
          },
          trusted,
        )
          ? channel === 'mobile:enable' && holdEnable
            ? enableGate
                .then(() => fn(event, ...args))
                .finally(() => {
                  delayedEnableSettled = true;
                })
            : fn(event, ...args)
          : fallback,
      );
    registerMobileConnection(handle, connection);
    handle('clipboard:write-text', false, (_event, text) => {
      clipboard.writeText(text);
      return clipboard.readText() === text;
    });
    window.webContents.on('console-message', (event) => console.error('renderer:', event.message));
    await window.loadFile(fixture);
    const click = async (text: string) => {
      await window.webContents.executeJavaScript(
        `(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('Button missing '+${JSON.stringify(text)}+' buttons='+[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).join('|'));button.click();})()`,
      );
    };
    const text = () => window.webContents.executeJavaScript('document.body.innerText');
    await wait(async () => String(await text()).includes('Phone connection'), 'Settings navigation');
    await click('Phone connection');
    await wait(async () => String(await text()).includes('Phone connection is off.'), 'off settings');
    assert.equal(connection.status().enabled, false);
    const policyCopy=String(await text());
    assert.ok(policyCopy.includes('Ordinary chats need no Mac approval') && policyCopy.includes('Expo Go can use your device passcode'));
    assert.ok(!policyCopy.includes('approve tools on your Mac'));
    checks.push('opening settings never starts relay; current phone-authority help is rendered');
    await click('Enable phone connection');
    await wait(async () => String(await text()).includes('Stop remote access'), 'Stop during pending enable');
    assert.equal(
      await window.webContents.executeJavaScript(
        "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Stop remote access').disabled",
      ),
      false,
    );
    await click('Stop remote access');
    await wait(() => connection.status().halted, 'Stop interrupts pending enable');
    holdEnable = false;
    releaseEnable();
    await wait(() => delayedEnableSettled && !connection.status().busy, 'delayed enable retires');
    assert.equal(connection.status().enabled, false);
    checks.push('Stop stays reachable while enable IPC is pending and rejects late enable');
    await connection.close();
    connection = new MobileConnection(options);
    for (const name of ['status', 'enable', 'disable', 'advertisement', 'confirm', 'revoke', 'stop'])
      ipcMain.removeHandler('mobile:' + name);
    registerMobileConnection(handle, connection);
    await wait(async () => String(await text()).includes('Phone connection is off.'), 'new app session after Stop');
    await click('Enable phone connection');
    await wait(() => connection.status().enabled && !connection.status().busy, 'enabled configuration persisted');
    await wait(() => connection.advertisement(), 'relay admission');
    await wait(
      async () => !!(await window.webContents.executeJavaScript('document.querySelector("img.mobile-qr")?.complete')),
      'visible QR',
    );
    const advertText = await window.webContents.executeJavaScript("document.querySelector('textarea').value");
    const advert = parseAdvertisement(advertText);
    writeFileSync(
      path.join(process.env.BIMAX_PHONE_EVIDENCE || directory, prefix + 'qr.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    const qrData = await window.webContents.executeJavaScript('document.querySelector("img.mobile-qr").src');
    const qrFile = path.join(directory, 'qr.gif');
    writeFileSync(qrFile, Buffer.from(qrData.split(',')[1], 'base64'));
    assert(process.env.BIMAX_QR_DECODER, 'Independent QR decoder required');
    assert.equal(execFileSync(process.env.BIMAX_QR_DECODER, [qrFile], { encoding: 'utf8' }).trim(), advertText);
    checks.push('rendered QR decodes to actual phone advertisement');
    const params = new URL(advert.relayUrl);
    const token = params.searchParams.get('lanToken')!;
    assert.equal(readFileSync(path.join(directory, 'mobile-connection.enc')).includes(Buffer.from(token)), false);
    checks.push('LAN bearer persists encrypted');
    await window.webContents.executeJavaScript('document.querySelector("details").open=true');
    await click('Copy pairing data');
    await wait(() => clipboard.readText() === advertText, 'clipboard bridge');
    checks.push('copy uses production preload/native clipboard');
    await assert.rejects(
      new Promise((resolve, reject) => {
        const bad = new WebSocket(advert.relayUrl.replace(token, 'wrong-token'));
        bad.once('open', () => {
          bad.close();
          resolve(true);
        });
        bad.once('error', reject);
      }),
      undefined,
    );
    checks.push('wrong admission token never upgrades');
    const x = generateX25519Keypair(),
      signing = generateEd25519Keypair();
    const pairing = new PairingManager({ deviceId: 'phone-settings-fixture', staticKeypair: x, helloKeypair: signing });
    let grant: any;
    phone = new RelayClient({
      url: advert.relayUrl,
      deviceId: 'phone-settings-fixture',
      role: 'mobile',
      wsImpl: WebSocket as never,
      helloSigner: {
        pubkeyB64: Buffer.from(signing.publicKey).toString('base64'),
        sign: async (msg) => ed25519Sign(signing.privateKey, msg),
      },
      onMessage: (env) => {
        if (env.kind === 'pairing_grant') grant = env;
      },
    });
    phone.connect();
    await wait(() => phone.status === 'online', 'phone relay');
    phone.send(pairing.beginPairing(advert));
    await wait(() => grant, 'Noise grant');
    const session = pairing.handleGrant(grant),
      code = formatVerificationCode(session.handshakeHash);
    phone.send(buildTransportConfirmation(session, 'phone-settings-fixture'));
    await wait(() => connection.status().candidate, 'candidate in settings');
    assert.equal(connection.status().paired, false);
    assert.equal(connection.status().candidate?.code, code);
    assert.equal((await connection.confirm('000000', 'phone-settings-fixture')).ok, false);
    assert.equal(connection.status().paired, false);
    checks.push('unconfirmed and wrong-code peer has no trust');
    await wait(async () => String(await text()).includes(code), 'verification code rendered');
    writeFileSync(
      path.join(process.env.BIMAX_PHONE_EVIDENCE || directory, prefix + 'verify.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert.equal(
      await window.webContents.executeJavaScript(
        '(()=>{const r=document.querySelector(".mobile-verify").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()',
      ),
      true,
      'verification must be visible without searching below the QR',
    );
    await click('Codes match — connect phone');
    await wait(() => connection.status().phoneConnected, 'trusted connection');
    checks.push('actual phone handshake and Settings confirmation establish trusted session');
    assert.equal(connection.advertisement(), null);
    await wait(
      async () => !(await window.webContents.executeJavaScript('document.querySelector("img.mobile-qr")')),
      'pairing data retired',
    );
    writeFileSync(
      path.join(process.env.BIMAX_PHONE_EVIDENCE || directory, prefix + 'paired.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    await connection.close();
    connection = new MobileConnection(options);
    await connection.restore();
    assert.equal(connection.status().paired, true);
    assert.equal(connection.status().phoneConnected, false);
    checks.push('encrypted preferences and trusted phone survive controller restart');
    // Registered IPC closures intentionally retain the original object: re-register for the fresh generation.
    for (const channel of ['status', 'enable', 'disable', 'advertisement', 'confirm', 'revoke', 'stop'])
      ipcMain.removeHandler('mobile:' + channel);
    registerMobileConnection(handle, connection);
    phone.close();
    await connection.revoke();
    assert.equal(connection.status().paired, false);
    checks.push('forget clears trust and encrypted session');
    await connection.stop();
    assert.equal(connection.status().halted, true);
    assert.equal(connection.status().enabled, false);
    assert.equal((await connection.enable('127.0.0.1')).ok, false);
    checks.push('Stop closes LAN and latches off until app restart');
    pairing.destroy();
    writeFileSync(
      path.join(process.env.BIMAX_PHONE_EVIDENCE || directory, prefix + 'pairing.json'),
      JSON.stringify(results, null, 2),
    );
    console.log(JSON.stringify(results));
  })
  .then(
    async () => {
      phone?.close();
      await connection?.close();
      window?.destroy();
      app.exit(0);
    },
    async (error) => {
      console.error(error);
      phone?.close();
      await connection?.close().catch(() => {});
      window?.destroy();
      app.exit(1);
    },
  );
