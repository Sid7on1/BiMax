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
  // RETRIEVAL SUITES RUN UNDER BUN, NOT HERE — and that is a property of the RUNTIME, not the code.
  //
  // Measured 2026-09-19: plain Node's `node:sqlite` has no FTS5 ("no such module: fts5"), while bun
  // AND Electron both do — and Electron is what actually runs the shipped engine, so production is
  // unaffected. Left in this runner these 11 suites contributed ~38 permanent failures that no one
  // could act on, and a red suite nobody acts on is where real bugs hide: two genuinely broken
  // rerank fixtures sat inside this noise until the suites were run somewhere they could pass.
  //
  // `npm test` runs them through `npm run test:bun`, so nothing is skipped overall.
  // fts5.contract.test.ts fails if this list and that script ever drift apart.
  testPathIgnorePatterns: [
    '/node_modules/', '<rootDir>/archive/',
    '<rootDir>/src/__tests__/code.index.test.ts',
    '<rootDir>/src/__tests__/code.index.eval.test.ts',
    '<rootDir>/src/__tests__/code.store.ram.ledger.test.ts',
    '<rootDir>/src/__tests__/composer.contextual.test.ts',
    '<rootDir>/src/__tests__/composer.corpus.test.ts',
    '<rootDir>/src/__tests__/composer.facts.test.ts',
    '<rootDir>/src/__tests__/composer.identifiers.test.ts',
    '<rootDir>/src/__tests__/composer.retrieval.traps.test.ts',
    '<rootDir>/src/__tests__/document.read.test.ts',
    '<rootDir>/src/__tests__/memory.eval.test.ts',
    '<rootDir>/src/__tests__/memory.retrieval.test.ts',
    // Builds the REAL container to inspect all 51 tool schemas. Under jest that races the
    // environment teardown — container.ts keeps lazily require()-ing after the last test and
    // throws "require after teardown", passing 5/5 on one run and 0/5 on the next. Stable under
    // bun, which is where it runs.
    '<rootDir>/src/__tests__/tool.registry.contract.test.ts',
  ],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/'
  ]
};

export default config;
