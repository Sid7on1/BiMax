# 62 — Every provider, a key pool, every MCP server, and the audit's bugs

**Date: 2026-09-28. Branch `feat/sovereign-retrieval-and-layout-extraction`.** The owner asked what is broken on the way
to production, said the API experience is unreliable, then asked for: all tools to work, all MCP servers to work, a
key pool ("multiple keys in a hybrid round robin to tackle low RPM"), and every bug the audit found fixed. UI changes
the owner wants are a separate, still-open request.

## 1. The audit — measured on this Mac before any change

| Finding | Evidence |
|---|---|
| A Mac sleep killed idle engines as "stopped responding", and the restart shed capabilities | 29 of 30 `thread-crash-*.json` records are `unresponsive`, mostly `activeTurn: false`, ~30 MB heaps. The three on 2026-09-22 land on the exact second of a `DarkWake from Deep Idle` in `pmset -g log` (older ones can't be checked: pmset keeps ~7 days). Restarts ran `conservative`, then `minimal`. |
| The API "hangs" | `engine.log`: one turn on 2026-09-19 had six consecutive 45 s first-token hangs on the single NVIDIA key. A live probe today hung 60 s on a 5-token request. NVIDIA's free tier is 40 requests/min per model per account (source ledger). |
| The app was NVIDIA-only | `ModelDialog` gated the key and Use buttons on `provider.name === 'nvidia'`; every other provider showed "not verified" with no way to add a key. |
| Other providers named retired models | `provider.ts` defaults `claude-3-opus-20240229`, `gpt-4o`, `gemini-2.0-flash`, `deepseek-chat`; catalogue rows the same. |
| The default Quick model is dead on this account | NVIDIA lists `mistralai/mistral-7b-instruct-v0.3` and `google/gemma-3-4b-it` in `/models`; chat requests to both answer 404 "Not found for account". Every live small model on the account is a reasoner (10–30 s for "Say ok"). |
| Retry status was never shown | The engine emits "Provider hiccup — retrying…" as `status`; the renderer stored it and rendered it nowhere. |
| Big projects had no code search | 39,476- and 96,155-file folders hit the 12,000-file cap and indexing was skipped outright. |
| OCR test red | `document.read.test.ts` end-to-end: Vision returned 4 of 8 lines of a clean page with confidence 1.0. Red before this work. |
| Test hygiene | `paired.runner` no-change test flaky (2 of 4 full runs, record gods-land/03); four `.task-grants-test-*` folders left in the repo root. |

## 2. What changed

Each item: commit, tests, mutants (a mutant is a deliberate break that a test must catch; "invalid" mutants that did
not compile were rewritten, never counted).

1. **Sleep no longer kills engines** — `2272e13`. `EngineSupervisor.tick()` treats a tick arriving ≥5 intervals late as a
   suspended main process and re-arms the heartbeat and startup clocks. 3 tests (sleep while idle; a truly wedged engine
   after wake is still caught; sleep during startup). 4 mutants killed.
2. **Hybrid round-robin key pool** — `5a6abde`. `src/credits/key.usage.ledger.ts`: one per-key request ledger for every
   engine on the Mac (`~/.breakglass/key-usage.json`, 16-hex SHA-256 prefixes only, O_EXCL lock + atomic rename, 0600).
   `ApiKeyManager` picks in rotation among keys off cooldown and under their per-minute limit, preferring keys not used in
   the last 1.1 s, then lowest time-to-first-token × (1 + share of the minute used); a 429 or hang in one engine is shared.
   When every key is busy it waits for the earliest slot and picks again (`acquire`, bounded 120 s), and says so in the
   status line. NVIDIA defaults to 40/min; `<KEY_ENV>_RPM` / `BIMAX_KEY_RPM` override. 17 tests, 9 mutants killed (2 after
   strengthening tests).
3. **Every tool on every provider** — `5a6abde`. `src/core/tool.wire.ts`: names outside `^[a-zA-Z0-9_-]{1,64}$` are mapped
   to valid, distinct wire names and mapped back; history rewritten to match; schemas normalised (`$schema`/`$id` dropped,
   local `$ref` inlined, object root, `required` filtered, arrays get `items`, Gemini's subset); ≤128 tools per request.
   GPT-6 tool requests send `reasoning_effort: "none"` (its Chat Completions rule). Provider data on a tool call
   (`extra_content`, Gemini's thought signature) is echoed back. 21 tests incl. 5 through the real adapter; 15 mutants killed.
4. **Current models for every provider** — `5a6abde`. Defaults and curated Work rows re-read from each provider's own list
   (source ledger). A refused Quick model is retried at once on the Work model; a dead optional Quick/Vision pin is cleared
   rather than left to fail every session.
5. **The app: several keys per provider, every provider usable** — `ff19910`. Up to 32 Keychain-protected keys per
   provider, pasted one or many at a time, each removable; a per-key requests/min field; adding a key keeps a custom
   endpoint; the old one-key store still loads. 10 tests, 8 mutants killed. Screenshot of the pane taken in the design
   preview with a 3-key pool.
6. **MCP: sign-in, every config shape, changing tools, resources, roots** — `8a0fa9f`. OAuth for hosted servers
   (`src/mcp/oauth.ts`: SDK does discovery/registration/PKCE/refresh; Bimax adds 0600 per-server files, a 127.0.0.1
   listener that checks `state`, and the browser — only on `/mcp login`, never at boot). VS Code's object `servers` (used to
   load nothing), `serverUrl`, `httpUrl`, `transport`, `enabled:false`. `${VAR}`/`${VAR:-d}`/`${env:VAR}` resolved at connect
   time, never written back. `tools/list_changed` reconciled; resource servers get list/read tools; `roots/list` answers the
   workspace; launchers get 90 s to start. 13 tests incl. a full OAuth round trip against a fake authorization server;
   18 mutants killed.
7. **Big projects get code search; OCR cross-check** — `396203f`. Git projects list files with `git ls-files`
   (`.gitignore` honoured); a project still over the ceiling indexes its most recently changed files and code search says
   the coverage is partial. 4 Bun tests, 5 mutants killed. OCR: each page is also read by Vision's `fast` model; if it finds
   more lines, `accurate` is retried and the fullest read wins.
8. **Status visible** — `cea417b`. The in-flight row in the transcript and the ⌘2 bar shows the engine's status line.
9. **Test hygiene** — `30398f4` (grants test settles the usage counter before cleanup; leftovers moved to
   `~/Developer/bimax-archive/test-leftovers/`), `52bbf1d` (paired-runner verdict tested on an injected clock; 1 mutant).

## 3. What is NOT established

- **No live provider run except NVIDIA.** OpenAI, Anthropic, Google, DeepSeek and OpenRouter were not called: there are no
  keys on this Mac. Their model ids and rules come from their own documentation (source ledger), not from a Bimax run.
  The GPT-6 `reasoning_effort: "none"` rule and Gemini's thought-signature echo are **Implemented, not Measured**.
- **Anthropic runs through its OpenAI-compatibility layer**, which Anthropic describes as for testing, not production
  (no prompt caching, `strict` ignored). A native Messages adapter is **Target**.
- **Key pool not measured against live 429s.** Selection, sharing and waiting are proven with fakes and a real file across
  two store instances; throughput under a real low-RPM provider is unmeasured. NVIDIA's limit is per account, so extra keys
  add capacity only from different accounts.
- **Cross-provider failover is not built.** The pool is per provider (a model id belongs to one provider's namespace).
- **OAuth proven against a fake authorization server only**, not a real hosted MCP server.
- **The OCR partial read could not be reproduced again** after it was observed; the cross-check is a defence, not a
  demonstrated fix. The grants-folder leak also could not be reproduced; the fix follows the evidence in the files.
- **No fast plain Quick model works on this NVIDIA account.** The default stays; a refusal now costs one fast 404 and
  lands on the Work model.
- **Still blocked on the owner:** Developer ID (Gatekeeper, notarization, auto-update, App Intents registration) — record 59.

## 4. Verification that ran

App and engine `tsc --noEmit` clean. Focused suites listed in each commit. The full Jest and `test:bun` runs are in §5.
Gates checked: `08_ACCEPTANCE_GATES.md` "Gates for every product change" (mutants, no loosened tests — three assertions were
updated to deliberate behaviour changes and say so in their commits), Desktop coding gate (engine hang/restart handling).

## 5. Full-suite results (after all commits above)

| Runner | Result | Baseline (record 61 / gods-land stage 8) |
|---|---|---|
| Jest, 372 suites | 3,455 passed, **0 failed**, 19 skipped (FTS5-only cases under Node, by design) | 3,388–3,215 passed, 0–1 failed (the flaky paired-runner case) |
| `npm run test:bun` | 131 passed, **0 failed** (the OCR end-to-end case, red before this work, passes) | 125 passed |
| `npm run test:context` | 63 passed, 0 failed | 63 |

Lint: the files this work added or changed carry no new ESLint errors; the errors ESLint reports in `app/src/main/index.ts`,
`supervisor.ts`, `ThinkingIndicator.tsx` and `ThreadSurfaces.tsx` are on lines this work did not touch.

## 6. Live run on NVIDIA (2026-09-28, 01:19–01:31 local)

The built engine bundle (`app/engine/index.js`), forked as a utilityProcess the way the app forks it, the real
`~/.breakglass` key and config (`openai/gpt-oss-20b` in Work and Quick), one request that needs a file-reading tool.

- **Worked, live:** the shared ledger was created at `~/.breakglass/key-usage.json` (mode 0600, one 16-hex id, no key
  text) and pruned starts older than a minute; the pool announced "1 key(s)… 40 requests/min each"; a 120 s first-token
  stall benched the key, `acquire` waited 1 s and re-picked ("Rate limit — waiting 1s for a free API slot"); the loop
  emitted "Provider hiccup — retrying in 1s (1/2)" and "(2/2)"; after that it failed over and said so; the turn ended with
  an honest error instead of a spinner.
- **Found and fixed (`fix(loop)` after this record):** the failover said "switched to fallback moonshotai/kimi-k3" but both
  later retries still went to `gpt-oss-20b` — the turn was Quick-routed and the fallback only replaced the Work model.
- **Not established:** a successful live tool call. NVIDIA answered nothing for ~12 minutes; a direct 16-token request to
  `gpt-oss-20b` and to `kimi-k3` got no response headers within 40 s. An earlier harness attempt that looked like a stall
  was a harness bug (messages sent without the trailing newline the engine reads by line), not a provider or product fault.
- The run used the engine's default 120–180 s first-token budget; the app sets 45 s (`coding.runtime.paths.ts`), so the
  same stall costs ~2¼ minutes per model in the app instead of ~6.

## 7. Installed

Built with `app/scripts/build-local-mac.sh` from `ccc2f7e` (all four package gates PASS, `codesign --verify --deep
--strict` ok, bundled engine byte-identical to the tested bundle) and installed to `/Applications/Bimax.app`; a window
appeared ~6 s after launch. The previous app was moved, not deleted, to
`~/Developer/bimax-archive/apps/Bimax.app.before-r62-20260928`. Not yet used for a real turn inside the installed app.

## 8. Follow-up, 2026-09-29: a held request is raced, not waited out

**The owner's report:** the installed app "is not responding, even if it does it takes 1 min to reply to hi", and a
"Code index: degraded…" line sits at the top of every folder for good.

**Measured.** The session file shows a question interrupted after 48 s with no answer, then "hi" answered after 46 s.
Five NVIDIA keys probed directly, all five fired together: four held their response headers past 60 s, one answered at
14.7 s. Minutes later the same five answered together in ~0.4 s (headers) / 1–2 s (reply); one at a time, 1.9–2.6 s.
A 28,587-token prompt still got headers in ~1.1 s. So the stall is per request, and it sits in the header phase. The
app sets `BGW_FIRST_CHUNK_TIMEOUT_MS=45000`, which (being explicit) also switched off the tighter multi-key budget —
a held request cost the full 45 s before any retry. The real engine bundle, forked like the app forks it, answered
"hi" in 5.3 s on one key and 3.5 s on five once NVIDIA granted the request.

**Built.**
- `src/core/hedged.request.ts` (`84e70e3`): after 8 s with no headers (`BGW_HEDGE_AFTER_MS`, 0 = off) one backup copy
  goes out on a different free key with the same provider, endpoint and model; the first answer wins and the other is
  cancelled. The first request is never abandoned, so a heavy model that legitimately queues still works. Never for a
  loopback endpoint (a local server loading a model holds headers too). The outraced key is taught as slow
  (`reportKeyLatency`), not benched. `ApiKeyManager.getNextKey({ exclude })` keeps the backup off the held key.
  11 tests, one through the real adapter (a held key and a fast key); 6 mutants killed.
- Transcript (`29a5abd`): capability notices are the banner's. The engine reports the code index `degraded` while it
  syncs and `ready` when done — the same millisecond on a small folder — but the chat kept the warning and dropped the
  recovery as chatter, so the line never left. 3 tests; 1 mutant killed (2 of 3 tests fail on it).

**Not established.** The hedge has not yet fired live — NVIDIA granted every request during verification, so its
benefit on a real stall is Implemented, not Measured. A pool only adds capacity if the keys are on different NVIDIA
accounts (unknown for these five). The four new keys were not added to the app's Keychain store by this work; the
owner adds them in Settings → Models. `gpt-oss-20b` answered one of three live questions with bare tool-argument JSON
(the known weak-model behaviour); two repeat runs of the same questions were clean.

**Verification that ran.** Engine and app `tsc --noEmit` clean; 19 suites / 188 tests around requests, keys, streaming,
memory, the transcript and the ⌘2 bar pass. Live: the rebuilt bundle, three runs of "hi" / a tool question / "thanks"
on five keys. The fixes were first built on a side branch (`feat/hindsight-memory`, commits `9615dd7` and `2f8628f`)
and the app installed on 2026-09-29 came from that branch (four package gates PASS, `codesign --verify --deep --strict`
ok; previous app at `~/Developer/bimax-archive/apps/Bimax.app.before-hedge-20260929`). That branch was retired the same
day: only these two fixes were carried onto the main work branch (`84e70e3`, `29a5abd`); the rest of it is kept as a
git bundle in `~/Developer/bimax-archive/hindsight-branch-20260929/`. Until the app is rebuilt from the work branch,
the installed app also carries that branch's optional long-term-memory client (off unless `HINDSIGHT_BASE_URL` is set).
