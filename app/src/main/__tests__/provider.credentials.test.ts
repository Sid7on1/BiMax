import { existsSync, readFileSync } from 'node:fs';

const isEncryptionAvailable = jest.fn(() => true);
const decryptString = jest.fn(() => 'secret');

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/bimax-provider-credentials-test') },
  safeStorage: { isEncryptionAvailable, decryptString },
}));

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

describe('provider credential startup', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does not touch Keychain when the remembered provider has no encrypted key', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    (readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      version: 1,
      activeProvider: 'nvidia',
      encrypted: {},
    }));
    let isolated!: typeof import('../provider.credentials');
    jest.isolateModules(() => { isolated = require('../provider.credentials'); });

    isolated.loadProviderCredentials();

    expect(isEncryptionAvailable).not.toHaveBeenCalled();
    expect(decryptString).not.toHaveBeenCalled();
  });

  test('offers StepFun as a Keychain-backed provider', () => {
    (existsSync as jest.Mock).mockReturnValue(false);
    let isolated!: typeof import('../provider.credentials');
    jest.isolateModules(() => { isolated = require('../provider.credentials'); });

    expect(isolated.providerCredentialStatuses()).toContainEqual({
      name: 'stepfun',
      hasKey: false,
      storage: 'none',
      active: false,
    });
  });
});
