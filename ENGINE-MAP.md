# Bimax Real Engine Map (Desktop Responder Integration)

This document maps the internal architecture of Bimax (`~/Bimax`, `/Users/vishsiddharth/Bimax`) to the requirements of `DESKTOP-RESPONDER-CONTRACT.md` §14 (`EnginePort`).

---

## 1. Tool Execution Pipeline & Pre-Execution Interception Point

### Tool Lifecycle
- **Decision to Execution**:
  1. The LLM tool round scheduler in `/Users/vishsiddharth/Bimax/src/core/agent.tool.round.ts` (`executeToolBatch` / `runToolCall`) decides tool execution.
  2. At line 229 of `agent.tool.round.ts`, `tool.execute(argsObj, toolContext)` is called.
  3. The tool instance is created by `buildTool(def, governor)` in `/Users/vishsiddharth/Bimax/src/tools/tool.factory.ts`.

### Pre-Execution Interception Point
In `/Users/vishsiddharth/Bimax/src/tools/tool.factory.ts`:
- **Line 63-68**:
  ```ts
  if (!def.approvalHandledInternally) {
    const tApprove = Date.now();
    await governor.approveTaskExecution(taskType, payload);
    recordGuard('governor:approve', Date.now() - tApprove);
    context?.signal?.throwIfAborted();
  }
  ```
- **Line 83-93**:
  ```ts
  const pre = await runPreHooks(def.name, args, context);
  if (pre && pre.block) {
    const text = `${def.name} was blocked before running: ${pre.reason}`;
    return text;
  }
  ```
- **Interactive Prompter & Protocol Bridging**:
  1. In `/Users/vishsiddharth/Bimax/src/governor/governor.ts`, `Governor.approveTaskExecution` evaluates safety constraints. When an interactive decision is needed (e.g. destructive commands/writes), it calls:
     ```ts
     const answer = await GlobalPrompter.ask(question, options, { body });
     ```
  2. `GlobalPrompter.ask` in `/Users/vishsiddharth/Bimax/src/engine/prompter.ts` emits:
     ```ts
     engineEvents.emit('veto_prompt', question, options, resolve, false, false, extra?.body);
     ```
  3. `ProtocolHost` in `/Users/vishsiddharth/Bimax/src/protocol/host.ts` (line 102) translates `veto_prompt` into a protocol frame:
     ```ts
     { t: 'request', id, kind: 'prompt', question, options, body }
     ```
  4. Across the MessageChannel port, this reaches Electron Main:
     - In `/Users/vishsiddharth/Bimax/app/src/main/thread.manager.ts`, `ThreadManager.receive` intercepts `{ t: 'request' }` in `holdApproval(id, r, request)`.
     - `ThreadManager` assigns a token, saves it to `r.pending.set(request.id, approval)`, sets thread status to `'needs-you'`, and calls:
       ```ts
       this.deps.approval(approval);
       ```
     - In `/Users/vishsiddharth/Bimax/app/src/main/index.ts`, `threads = new ThreadManager({ approval: (value: ThreadApproval) => ... })`.

### The Approval Hook Hook-Point (§2)
- In the Electron main process, `ThreadManager.deps.approval` is the exact pre-execution interception point.
- The approval suspension mechanism (`approval-hook.ts`) hooks this point:
  - Intercepts incoming `ThreadApproval` before any user action.
  - Translates the request to a `ToolApprovalRequest` (`approvalId`, `sessionId`, `tool`, `summary`, `detail`, `requestedAt`, `expiresAt`) and emits via `onApprovalRequest`.
  - When `resolveApproval(approvalId, verdict)` is received:
    - **Approved**: Resumes the suspended tool call with original args by dispatching:
      ```ts
      ThreadManager.send(threadId, { t: 'reply', id: requestId, value: 'Allow', approvalToken: token })
      ```
    - **Denied / Timed out / Killed**: Dispatches `{ t: 'reply', value: 'Deny' }` or cancels turn via `cancelTurn`. `Governor.approveTaskExecution` throws `GovernorVetoError`, the tool implementation is **never executed**, and the engine receives a denial outcome and continues its turn.

---

## 2. Session Model

All sessions/threads are managed by `ThreadManager` in `/Users/vishsiddharth/Bimax/app/src/main/thread.manager.ts`.

- **List Sessions**:
  - Function: `threads.list(): ThreadSummary[]`
  - Returns array of `ThreadSummary` ({ `id`, `root`, `title`, `status`, `updatedAt`, `origin`, `model`, `voice` }).
  - Maps to protocol `AgentSessionInfo[]`:
    - `sessionId`: `summary.id`
    - `title`: `summary.title`
    - `status`: Mapped from `summary.status` (`working` -> `working`, `needs-you` -> `waiting_approval`, `idle`/`stopped` -> `idle`)
    - `startedAt`: `summary.updatedAt`
- **Read Session Status**:
  - Function: `threads.summary(id: string): ThreadSummary` or `threads.get(id: string): SavedThread`.
- **Send Instruction / Message**:
  - Function: `threads.submit(id: string, text: string, display?: string, echo?: boolean): void`
  - If no session exists or `sessionId` is omitted, `threads.create(defaultRoot, text, 'project')` creates a fresh thread and immediately submits the instruction.
- **Abort / Kill Session**:
  - Function: `threads.stop(id: string, { keepInputs: false, reason }): void`
  - What it does:
    1. Sets `r.summary.outcome = 'interrupted'`.
    2. Clears pending approvals (`r.pending.clear()`) and drops host cards.
    3. Calls `this.drain(r, engine)` which executes `engine.dispose()`.
    4. In `/Users/vishsiddharth/Bimax/app/src/main/supervisor/supervisor.ts`, `EngineSupervisor.dispose()` calls `child.endStdin()` and `child.kill('SIGTERM')`.
    5. In `/Users/vishsiddharth/Bimax/app/src/main/engine.ts`, `child.kill('SIGTERM')` escalates to `worker.terminate()`, which terminates the V8 worker thread directly. In-flight tool work is genuinely aborted.
  - Mid-turn interrupt (without terminating engine worker):
    - `threads.send(id, { t: 'interrupt' })` cancels the turn (`cancelTurn(r)`) and forwards `{ t: 'interrupt' }` to the engine worker, which triggers `session.interrupt()`.

---

## 3. Chat Entry Point

- **Submission**:
  - Function: `threads.submit(sessionId, text, text)` in `/Users/vishsiddharth/Bimax/app/src/main/thread.manager.ts`.
- **Streaming Response Tokens**:
  - The engine worker emits streamed tokens via:
    ```ts
    engineEvents.emit('stream_token', token);
    ```
    (located in `/Users/vishsiddharth/Bimax/src/protocol/headless.session.ts`, line 192).
  - `ProtocolHost` (`/Users/vishsiddharth/Bimax/src/protocol/host.ts`) forwards this event over the port as `{ t: 'event', name: 'stream_token', args: [token] }`.
  - In `/Users/vishsiddharth/Bimax/app/src/main/index.ts`, `ThreadManager` receives the message via `deps.message(id, msg)`.
  - The adapter hooks this callback to invoke `onToken(token)` for the active chat turn.
- **Completion**:
  - When the turn finishes, the engine emits `{ t: 'event', name: 'spinner_state', args: ['idle'] }`.
  - `ThreadManager.settleIfIdle` catches this and triggers `deps.finished(id, tookMs)`.
  - The adapter resolves the `chat(...)` promise with `{ sessionId }`.
  - Tool approvals may arrive mid-turn (`approval_request`); the turn suspends until `resolveApproval`, then continues streaming.

---

## 4. Status Events

- **ThreadManager Emitter Seam**:
  - File: `/Users/vishsiddharth/Bimax/app/src/main/thread.manager.ts`
  - Injected dependencies in `ThreadManager`:
    - `changed(): void` — fired on any thread state/queue change.
    - `approval(value: ThreadApproval): void` — fired when an approval is required (`needs-you`).
    - `finished(id: string, tookMs?: number): void` — fired when a turn completes (`working` -> `idle`).
    - `selected(selection: ThreadSelection): void` — fired when active thread selection changes.
- **EngineSupervisor Status**:
  - File: `/Users/vishsiddharth/Bimax/app/src/main/supervisor/supervisor.ts`
  - `onStatus(status: SupervisorStatus): void`
    - Phases: `'booting' | 'ready' | 'degraded' | 'restarting' | 'stopped' | 'failed'`.
    - Updates thread lifecycle via `threads.lifecycle(threadId, status.phase, status.message)`.

---

## 5. File Ingestion

- **Entry Point**:
  - File: `/Users/vishsiddharth/Bimax/src/protocol/headless.handlers.ts` (lines 45–73).
- **Mechanism**:
  - Handled over the `query` request/response protocol channel with the reserved control prefix:
    ```ts
    const INGEST = '\u0000composer:ingest:';
    ```
  - When received:
    ```ts
    const file = text.slice(INGEST.length);
    const corpus = getComposerCorpus();
    const report = await corpus.ingest([file], 'session');
    ```
  - Used in the renderer via `useEngine.ts` (line 182):
    ```ts
    window.bimax.send({ t: 'query', id, text: `\u0000composer:ingest:${filePath}` });
    ```
- **Desktop Responder Attachment**:
  - In `EnginePort.attachFile({ fileId, name, mime, sizeBytes })`, the verified file resides in `<dataDir>/inbox/<fileId>`.
  - The adapter passes the absolute file path to the engine via `\u0000composer:ingest:<filePath>` or associates the `fileId` with the active session context.

---

## 6. Main-Process APIs & IPC Conventions

- **Electron safeStorage**:
  - Confirmed available in Electron Main:
    ```ts
    import { safeStorage } from 'electron';
    ```
  - Verified active usage in `/Users/vishsiddharth/Bimax/app/src/main/provider.credentials.ts` and `/Users/vishsiddharth/Bimax/app/src/main/index.ts`.
  - Methods:
    - `safeStorage.isEncryptionAvailable(): boolean`
    - `safeStorage.encryptString(plainText: string): Buffer`
    - `safeStorage.decryptString(encryptedBuffer: Buffer): string`
  - Used by `identity-secure.ts` to encrypt deviceId, X25519 static keypair, and Ed25519 hello keypair at rest. No plaintext key files are ever written to disk.
- **IPC Conventions**:
  - In `/Users/vishsiddharth/Bimax/app/src/main/index.ts`:
    - `secureHandle(channel, fallback, handler)`: wraps `ipcMain.handle` with origin validation (`isTrustedSender`, `auxiliaryChannelAllowed`) and error handling.
    - `secureOn(channel, handler)`: wraps `ipcMain.on` with origin validation.
    - `broadcast(channel, ...args)`: sends events to renderer webContents (`win.webContents.send`, `quickWindow.webContents.send`).
  - `pairing-ui.ts` will expose pairing IPC channels (`responder:pairing-advertisement`, `responder:confirm-pairing`, `responder:revoke-pairing`) following these exact conventions.
