import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // ts-jest workers grow their heap over a long run (each test file adds transformed-module state);
  // past physical memory they OOM-crash and jest restarts them in a loop — the full suite "hangs"
  // for an hour instead of finishing. Recycling any worker whose idle heap passes this limit keeps
  // the run bounded. Seen 2026-07-02 as an OOM in static.analyzer.test.ts under --coverage.
  workerIdleMemoryLimit: '1GB',
  // The limit above bounds each worker; this bounds how many exist. Jest defaults to cpus-1, so an
  // 8-core / 8 GB machine runs 7 workers that are each *allowed* a 1 GB idle heap — more than the
  // box has. Measured 2026-08-02 mid-run: 4.5 GB of swap in use and 1.65M pageouts, with unrelated
  // suites (subagent.manager, sandbox.floor, bimax.computer.runtime) failing on 5 s timeouts in the
  // full parallel run while every one of them passed in isolation. The failures moved between runs,
  // which is contention, not a defect.
  //
  // A fraction rather than a fixed count, so a larger CI box still uses its cores.
  maxWorkers: '50%',
  // `app/src` was NOT here, so all 14 suites in app/src/__tests__ — the Desktop pure-logic tests,
  // including desktop.bundle.resolution.test.ts, the one that checks the PACKAGED bundle — never
  // ran. There is no jest config under app/ and app/package.json has no test script either, so
  // nothing anywhere executed them. They were green the way an unread file is green.
  roots: ['<rootDir>/src', '<rootDir>/app/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  // Redirects the global config + secrets dir to a temp path so a test can never write to the
  // developer's real ~/.breakglass. See jest.setup.ts — this is not hygiene, it is a fix for a
  // measured incident where the suite blanked the user's configured model.
  setupFiles: ['<rootDir>/jest.setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/archive/'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/'
  ]
};

export default config;
