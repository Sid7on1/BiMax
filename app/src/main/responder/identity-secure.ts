import { app, safeStorage } from 'electron';
import * as path from 'node:path';
import { encryptedIdentityStore, loadIdentity, type Identity } from 'desktop-responder';

export interface SafeStorageProvider {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export function defaultIdentityPath(): string {
  return path.join(app.getPath('userData'), 'responder-identity.enc');
}

/** Reuses the protocol store's key-pair validation and fsynced, encrypted persistence. */
export async function loadOrCreateIdentity(
  filePath: string = defaultIdentityPath(),
  storage: SafeStorageProvider = safeStorage,
): Promise<Identity> {
  return loadIdentity(encryptedIdentityStore(filePath, {
    isEncryptionAvailable: () => storage.isEncryptionAvailable(),
    getSelectedStorageBackend: () => storage.getSelectedStorageBackend?.() ?? 'os-backed',
    encryptString: (value) => storage.encryptString(value),
    decryptString: (value) => storage.decryptString(Buffer.from(value)),
  }));
}
