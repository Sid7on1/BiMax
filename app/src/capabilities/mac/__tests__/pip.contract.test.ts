import { loadMacCapabilityConfig } from '../config';

describe('live target preview boundary', () => {
  const prior = process.env.BIMAX_COMPUTER_PIP;
  const priorNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (prior === undefined) delete process.env.BIMAX_COMPUTER_PIP;
    else process.env.BIMAX_COMPUTER_PIP = prior;
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
  });

  it('streams the exact target window by default now that the app-owned Live Target is packaged', async () => {
    delete process.env.BIMAX_COMPUTER_PIP;
    process.env.NODE_ENV = 'production';
    await expect(loadMacCapabilityConfig()).resolves.toMatchObject({ computerPip: true });
  });

  it('does not launch native preview windows from the unit-test harness', async () => {
    delete process.env.BIMAX_COMPUTER_PIP;
    process.env.NODE_ENV = 'test';
    await expect(loadMacCapabilityConfig()).resolves.toMatchObject({ computerPip: false });
  });

  it('can only be disabled by Electron-owned provider configuration, not a tool argument', async () => {
    process.env.BIMAX_COMPUTER_PIP = '0';
    await expect(loadMacCapabilityConfig()).resolves.toMatchObject({ computerPip: false });
  });
});
