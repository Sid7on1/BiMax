import {authorizeCloud,validateCloudGrant,type CloudGrant} from './cloud';
import { app, safeStorage } from 'electron';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MobileResult, MobileStatus } from '../../shared/mobile';
import type { ThreadManagerLike, RealEngineAdapter } from './adapter';
import type { SecureResponderHandle } from './pairing-ui';

type Running = NonNullable<Awaited<ReturnType<typeof import('./index').initResponderIfEnabled>>>;
interface Config {
  cloud?: CloudGrant;
  enabled: boolean;
  address: string;
  port: number;
  token: string;
}
/** Explicit opt-in survives launches; the reusable LAN bearer stays in OS-backed encryption. */
export class MobileConnection {
  private config?: Config;
  private running?: Running;
  private lan?: Awaited<ReturnType<typeof import('desktop-responder').createLanRelay>>;
  private tail: Promise<unknown> = Promise.resolve();
  private busy = false;
  private stopJob?: Promise<MobileResult>;
  private halted = false;
  private error?: string;
  constructor(
    private readonly options: {
      threads: ThreadManagerLike;
      knownWorkspaceRoots?: () => string[];
      onAdapter: (adapter: RealEngineAdapter | null) => void;
      directory?: string;
      identity?: import('desktop-responder').Identity;
      port?: number;
      storage?: typeof safeStorage;
      addresses?: () => MobileStatus['addresses'];
    },
  ) {}
  private get file(): string {
    return path.join(this.options.directory ?? app.getPath('userData'), 'mobile-connection.enc');
  }
  private get encryption(): typeof safeStorage {
    return this.options.storage ?? safeStorage;
  }
  private storage(): void {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text')
      throw new Error('OS-backed secure storage is unavailable. Unlock your Mac and try again.');
  }
  async restore(): Promise<void> {
    try {
      const data = await fs.readFile(this.file);
      this.storage();
      const value = JSON.parse(this.encryption.decryptString(data)) as Config;
      if (
        typeof value.enabled !== 'boolean' ||
        typeof value.address !== 'string' ||
        !Number.isInteger(value.port) ||
        value.port < 1 ||
        value.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(value.token)
      )
        throw new Error('Saved phone connection settings are invalid.');
      this.config = value;
      if (value.enabled) await this.enable(this.status().addresses.some(a=>a.address===value.address)?value.address:this.status().addresses[0]?.address);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = (error as Error).message;
    }
  }
  private async save(config: Config): Promise<void> {
    this.storage();
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.' + randomUUID();
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(this.encryption.encryptString(JSON.stringify(config)));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, this.file);
      this.config = config;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  status(): MobileStatus {
    const addresses =
      this.options.addresses?.() ??
      Object.entries(networkInterfaces()).flatMap(([name, list]) =>
        (list ?? [])
          .filter(
            (item) =>
              !item.internal &&
              item.family === 'IPv4' &&
              /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address),
          )
          .map((item) => ({ name, address: item.address })),
      );
    const paired = this.running?.responder.pairingManager.getTrustedPhone(),
      candidate = this.running?.responder.pairingManager.getCandidatePairing();
    return {
      enabled: !!this.running,
      busy: this.busy,
      halted: this.halted,
      relayStatus: this.running?.responder.relayClient.status ?? 'offline',
      paired: !!paired,
      phoneConnected:
        !!paired &&
        !!this.running?.responder.pairingManager.getActiveSession() &&
        (!!this.lan?.isDeviceOnline(paired.phoneDeviceId) || !!this.running?.responder.phoneConnected),
      phoneId: paired?.phoneDeviceId,
      cloudReady: !!this.config?.cloud && this.running?.responder.cloudStatus==='online',
      cloudStatus:this.running?.responder.cloudStatus??'offline',
      address: this.config?.address,
      addresses,
      error: this.error,
      ...(candidate && candidate.expiresAt > Date.now()
        ? {
            candidate: {
              phoneId: candidate.phoneDeviceId,
              code: candidate.verificationCode,
              expiresAt: candidate.expiresAt,
            },
          }
        : {}),
    };
  }
  private operation(action: () => Promise<void>): Promise<MobileResult> {
    if (this.busy)
      return Promise.resolve({ ok: false, error: 'Another phone setting is being saved. Try again shortly.' });
    this.busy = true;
    const job = this.tail.then(async () => {
      this.busy = true;
      this.error = undefined;
      try {
        await action();
        return { ok: true };
      } catch (error) {
        this.error = (error as Error).message;
        return { ok: false, error: this.error };
      } finally {
        this.busy = false;
      }
    });
    this.tail = job;
    return job;
  }
  enable(address: unknown): Promise<MobileResult> {
    return this.operation(async () => {
      if (this.halted) throw new Error('Remote access was stopped. Restart Bimax before enabling it again.');
      if (typeof address !== 'string' || !this.status().addresses.some((item) => item.address === address))
        throw new Error('Choose a current local Wi-Fi or Ethernet address.');
      if (this.running) {
        if (address === this.config?.address) return;
        throw new Error('Disable the connection before changing networks.');
      }
      this.storage();
      const { loadOrCreateIdentity, initResponderIfEnabled } = await import('./index');
      const { createLanRelay } = await import('desktop-responder');
      const identity = this.options.identity ?? (await loadOrCreateIdentity());
      if (this.halted) throw new Error('Remote access was stopped. Restart Bimax.');
      const config: Config = {
        ...this.config,
        enabled: true,
        address,
        port: this.config?.port ?? this.options.port ?? 8787,
        token: this.config?.token ?? randomBytes(32).toString('hex'),
      };
      const lan = await createLanRelay({
        host: address,
        port: config.port,
        token: config.token,
        desktopDeviceId: identity.deviceId,
      });
      this.lan = lan;
      config.port = lan.port;
      const url = `ws://${address}:${lan.port}?lanToken=${config.token}`;
      try {
        const running = await initResponderIfEnabled(this.options.threads, {
          knownWorkspaceRoots: this.options.knownWorkspaceRoots,
          enabled: true,
          identity,
          relayUrl: url,
          dataDir: path.join(this.options.directory ?? app.getPath('userData'), 'responder'),
          secureHandle: () => {},
          onCloudGrant: async grant => {
            const result=await this.operation(async()=>{
              if(this.halted||!this.running||!this.config)throw Error('Phone connection ended');
              const validated=validateCloudGrant(grant,identity);
              await this.save({...this.config,cloud:validated});
              if(this.halted||!this.running)throw Error('Phone connection ended');
              this.running.responder.connectCloud(validated.relayUrl,url=>authorizeCloud(identity,()=>this.config?.cloud,url));
            });
            if(!result.ok)throw Error('Cloud connection could not be saved');
          },
          onEmergencyStop: () => {
            void this.finishStop(true);
          },
        });
        if (this.halted) {
          await this.shutdown();
          throw new Error('Remote access was stopped. Restart Bimax.');
        }
        if (!running) throw new Error('Phone connection did not start.');
        this.running = running;
        this.options.onAdapter(running.adapter);
        await this.save(config);
        if(config.cloud){
          try{const cloud=validateCloudGrant(config.cloud,identity);running.responder.connectCloud(cloud.relayUrl,url=>authorizeCloud(identity,()=>this.config?.cloud,url));}
          catch{this.error='Reconnect your phone to restore outside-network access.';}
        }
      } catch (error) {
        await this.shutdown();
        throw error;
      }
    });
  }
  private async shutdown(): Promise<void> {
    this.options.onAdapter(null);
    try {
      const { stopResponder } = await import('./index');
      await stopResponder();
    } finally {
      this.running = undefined;
      await this.lan?.close();
      this.lan = undefined;
    }
  }
  disable(): Promise<MobileResult> {
    return this.operation(async () => {
      try {
        if (this.running && !this.halted) await this.running.responder.emergencyStop('phone_connection_disabled');
      } finally {
        await this.shutdown();
        if (this.config) await this.save({ ...this.config, enabled: false });
      }
    });
  }
  advertisement(): string | null {
    if (
      !this.running ||
      this.halted ||
      this.running.responder.pairingManager.getTrustedPhone() ||
      this.running.responder.relayClient.status !== 'online'
    )
      return null;
    return JSON.stringify(this.running.responder.pairingManager.getAdvertisement());
  }
  confirm(code: unknown, phoneId: unknown): Promise<MobileResult> {
    return this.operation(async () => {
      const responder = this.running?.responder,
        candidate = responder?.pairingManager.getCandidatePairing();
      if (
        this.halted ||
        !responder ||
        responder.pairingManager.getTrustedPhone() ||
        typeof code !== 'string' ||
        typeof phoneId !== 'string' ||
        !candidate ||
        candidate.expiresAt <= Date.now() ||
        candidate.phoneDeviceId !== phoneId ||
        candidate.verificationCode !== code
      )
        throw new Error('This pairing request expired or changed. Scan a fresh code.');
      await responder.confirmTrustedPhone(code);
    });
  }
  revoke(): Promise<MobileResult> {
    return this.operation(async () => {
      if (!this.running) throw new Error('Enable the phone connection to forget the saved phone.');
      const cloud=this.config?.cloud;
      await this.running.responder.revokeTrustedPhone();
      if(cloud){
        const {loadOrCreateIdentity}=await import('./index');const identity=this.options.identity??await loadOrCreateIdentity();
        try{await authorizeCloud(identity,()=>cloud,cloud.relayUrl,'revoke');}catch{this.error='Phone forgotten locally. Cloud registration could not be cleared while offline.';}
        if(this.config){const {cloud:_removed,...rest}=this.config;await this.save(rest);}
      }
    });
  }
  private finishStop(alreadyStopped = false): Promise<MobileResult> {
    this.halted = true;
    if (this.stopJob) return this.stopJob;
    this.stopJob = (async () => {
      try {
        if (!alreadyStopped) await this.running?.hostControls.stop();
      } finally {
        await this.tail;
        await this.shutdown();
        if (this.config) await this.save({ ...this.config, enabled: false });
      }
      return { ok: true };
    })().catch((error) => {
      this.error = (error as Error).message;
      return { ok: false, error: this.error };
    });
    return this.stopJob;
  }
  stop(): Promise<MobileResult> {
    return this.finishStop();
  }
  async close(): Promise<void> {
    await this.tail;
    await this.shutdown();
  }
}
export function registerMobileConnection(handle: SecureResponderHandle, connection: MobileConnection): void {
  handle('mobile:status', null, () => connection.status());
  handle('mobile:enable', { ok: false }, (_event, address) => connection.enable(address));
  handle('mobile:disable', { ok: false }, () => connection.disable());
  handle('mobile:advertisement', null, () => connection.advertisement());
  handle('mobile:confirm', { ok: false }, (_event, code, phoneId) => connection.confirm(code, phoneId));
  handle('mobile:revoke', { ok: false }, () => connection.revoke());
  handle('mobile:stop', { ok: false }, () => connection.stop());
}
