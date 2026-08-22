import type { Config } from 'jest';

// Runtime tests construct the real default PiP adapter unless they inject a fixture. Keep native
// windows/processes out of the unit harness; the PiP contract test deletes this value temporarily
// to assert that packaged production still defaults the feature on.
process.env.BIMAX_COMPUTER_PIP ??= '0';
// Synthetic runtime fixtures must never fall through to System Events for their fake app names.
// MenuSurface itself has dedicated injected-runner coverage; runtime tests opt out of live menus.
process.env.BIMAX_COMPUTER_USE_MENU_ADAPTER ??= '0';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // Phase 8 adds the Desktop Trust Center's evidence view model under src/shared; it is graded by
  // the same command as the Mac capability suites (`npm --prefix app run test:mac:unit`).
  roots: [
    '<rootDir>/src/capabilities/mac', '<rootDir>/src/shared', '<rootDir>/src/phase9', '<rootDir>/src/main',
    // Renderer logic that is pure and worth pinning (view models, motion geometry). Components that
    // need a DOM stay in the design-preview harness; this root is for the parts a layout engine
    // cannot make more true.
    '<rootDir>/src/renderer/src/components/ui',
    // Desktop integration tests that used to live in the CLI's suite (src/__tests__) and reach
    // across into this app via `../../app/src/...`. They never imported anything from the CLI, so
    // they were purely misfiled — and their presence meant `npm test` at the repo root silently
    // required the desktop app's source to be checked out. They are this product's tests; they run
    // with this product's runner.
    '<rootDir>/src/__tests__',
  ],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: false }],
  },
  collectCoverage: false,
  maxWorkers: 2,
};

export default config;
