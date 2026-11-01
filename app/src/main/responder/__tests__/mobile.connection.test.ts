import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MobileConnection, registerMobileConnection } from '../mobile.connection';
let mockSaved = '';
const mockStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'test',
  encryptString: (plain: string) => {
    mockSaved = plain;
    return Buffer.from('opaque encrypted fixture');
  },
  decryptString: () => mockSaved,
};
const mockLan = { port: 18888, close: jest.fn(async () => {}), isDeviceOnline: () => true };
const mockManager = {
  getTrustedPhone: jest.fn(() => null as { phoneDeviceId: string } | null),
  getCandidatePairing: jest.fn(
    () => null as { phoneDeviceId: string; verificationCode: string; expiresAt: number } | null,
  ),
  getActiveSession: () => ({}),
  getAdvertisement: () => ({ app: 'bimax' }),
};
const mockResponder = {
  pairingManager: mockManager,
  relayClient: { status: 'online' },
  emergencyStop: jest.fn(async () => {}),
  confirmTrustedPhone: jest.fn(async () => {}),
  revokeTrustedPhone: jest.fn(async () => {
    mockManager.getTrustedPhone.mockReturnValue(null);
  }),
};
const mockRunning = { responder: mockResponder, adapter: {}, hostControls: { stop: jest.fn(async () => {}) } };
const mockInit = jest.fn(async () => mockRunning);
jest.mock('../index', () => ({
  loadOrCreateIdentity: async () => ({}),
  initResponderIfEnabled: () => mockInit(),
  stopResponder: async () => {},
}));
jest.mock('desktop-responder', () => ({ createLanRelay: () => Promise.resolve(mockLan) }));
jest.mock('electron', () => ({ app: { getPath: () => '/unused' }, safeStorage: {} }));
let directory: string, connection: MobileConnection;
const make = (storage = mockStorage) =>
  new MobileConnection({
    directory,
    threads: {} as never,
    onAdapter: () => {},
    storage: storage as never,
    identity: {} as never,
    addresses: () => [{ address: '192.168.1.20', name: 'fixture' }],
  });
beforeEach(async () => {
  jest.clearAllMocks();
  mockManager.getTrustedPhone.mockReturnValue(null);
  mockManager.getCandidatePairing.mockReturnValue(null);
  mockInit.mockImplementation(async () => mockRunning);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-phone-controller-'));
  connection = make();
});
afterEach(async () => {
  await connection.close();
  await fs.rm(directory, { recursive: true, force: true });
});
test('off by default; merely reading status or registering checked IPC opens no listener', () => {
  const handles = jest.fn();
  registerMobileConnection(handles, connection);
  expect(handles.mock.calls.map((call) => call[0])).toEqual([
    'mobile:status',
    'mobile:enable',
    'mobile:disable',
    'mobile:advertisement',
    'mobile:confirm',
    'mobile:revoke',
    'mobile:stop',
  ]);
  expect(connection.status().enabled).toBe(false);
  expect(connection.advertisement()).toBeNull();
  expect(mockInit).not.toHaveBeenCalled();
});
test('forged address and unavailable/plaintext secure storage fail before runtime startup', async () => {
  expect((await connection.enable('8.8.8.8')).ok).toBe(false);
  connection = make({ ...mockStorage, isEncryptionAvailable: () => false });
  expect((await connection.enable('192.168.1.20')).ok).toBe(false);
  connection = make({ ...mockStorage, getSelectedStorageBackend: () => 'basic_text' });
  expect((await connection.enable('192.168.1.20')).ok).toBe(false);
  expect(mockInit).not.toHaveBeenCalled();
});
test('explicit enable saves only ciphertext, duplicate enable is idempotent, disable retains configuration', async () => {
  expect(await connection.enable('192.168.1.20')).toEqual({ ok: true });
  expect(connection.status()).toMatchObject({ enabled: true, paired: false });
  expect(await fs.readFile(path.join(directory, 'mobile-connection.enc'), 'utf8')).toBe('opaque encrypted fixture');
  expect(JSON.parse(mockSaved)).toMatchObject({ enabled: true, address: '192.168.1.20' });
  await connection.enable('192.168.1.20');
  expect(mockInit).toHaveBeenCalledTimes(1);
  await connection.disable();
  expect(connection.status().enabled).toBe(false);
  expect(JSON.parse(mockSaved).enabled).toBe(false);
});
test('expired, foreign, wrong and already-paired confirmations never reach trust mutation', async () => {
  await connection.enable('192.168.1.20');
  mockManager.getCandidatePairing.mockReturnValue({
    phoneDeviceId: 'phone',
    verificationCode: '12 34',
    expiresAt: Date.now() + 10000,
  });
  expect((await connection.confirm('bad', 'phone')).ok).toBe(false);
  expect((await connection.confirm('12 34', 'foreign')).ok).toBe(false);
  mockManager.getCandidatePairing.mockReturnValue({
    phoneDeviceId: 'phone',
    verificationCode: '12 34',
    expiresAt: Date.now() - 1,
  });
  expect((await connection.confirm('12 34', 'phone')).ok).toBe(false);
  expect(mockResponder.confirmTrustedPhone).not.toHaveBeenCalled();
  mockManager.getCandidatePairing.mockReturnValue({
    phoneDeviceId: 'phone',
    verificationCode: '12 34',
    expiresAt: Date.now() + 10000,
  });
  expect((await connection.confirm('12 34', 'phone')).ok).toBe(true);
  mockManager.getTrustedPhone.mockReturnValue({ phoneDeviceId: 'phone' });
  expect((await connection.confirm('12 34', 'phone')).ok).toBe(false);
  expect(mockResponder.confirmTrustedPhone).toHaveBeenCalledTimes(1);
  expect(connection.advertisement()).toBeNull();
});
test('Stop retires an enable already awaiting runtime startup, closes LAN and cannot be re-enabled', async () => {
  let release!: (value: typeof mockRunning) => void;
  mockInit.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const enable = connection.enable('192.168.1.20');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const stop = connection.stop();
  release(mockRunning);
  expect((await enable).ok).toBe(false);
  expect(await stop).toEqual({ ok: true });
  expect(connection.status()).toMatchObject({ enabled: false, halted: true });
  expect((await connection.enable('192.168.1.20')).ok).toBe(false);
  expect(mockLan.close).toHaveBeenCalled();
});
