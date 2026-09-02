# Code-only agentic IDE reset record

Status: Implemented boundary and locally verified, 2026-09-02.

## Owner decision

Bimax is an agentic coding IDE, comparable in product scope to Claude Code and Codex. It works on
the opened project through coding tools and reviewable IDE surfaces. It does not control unrelated
Mac applications and does not own Accessibility, Screen Recording, physical input, native focus,
or app-to-app automation.

This supersedes the former two-product rule that reserved Computer Use for Desktop. Historical CU
code and research may remain as non-shipping evidence until a separate cleanup removes it safely,
but no production or development launch path may activate it.

## Active product boundary

The engine keeps create/read/edit/multi-edit/delete, project-scoped shell, tests, git, LSP, code and
graph search, browser research, plans, outcomes, checkpoints, interrupt/resume, review, memory, MCP,
and subagents. Desktop keeps its editor, files, terminal, changes, projects/tasks, model settings,
and coding evidence.

The product disables `bimax-mac`, `mac_control`, `computer_control`, generic `computer` MCP tools,
Control Mac lane inference, Live Target, takeover, Trust Center/TCC flows, focus/takeover brokers,
native CU provider injection, permission requests, native payload packaging, and supported CU build
or benchmark scripts.

## Enforcement points

1. `src/mcp/config.ts` rejects the reserved `bimax-mac` provider from host and project config.
2. `src/mcp/client.ts` skips Computer Use tool names even under a renamed server.
3. `app/src/main/coding.runtime.paths.ts` is the only runtime resolver imported by the Desktop
   engine launcher. It strips inherited CU variables and contains no native component resolver.
4. `app/src/main/engine.ts` launches the pinned coding engine with no native capability.
5. Desktop startup does not start focus or takeover brokers. The main process registers no CU,
   permission, manual-alpha, takeover, or Trust Center IPC, and preload exposes none of those APIs.
6. Desktop packaging stages the engine only and carries no native CU payload or TCC usage text.
7. The renderer exposes one code task composer and removes Mac/permissions navigation.

## Acceptance and mutation

`src/__tests__/code.only.product.boundary.test.ts` is the executable boundary. It must fail if a
native payload, `prepare-native` release step, Mac provider registration, Control Mac composer
entry, or permissions navigation is reintroduced. It also asserts coding-tool registration so the
reset cannot accidentally produce a chat-only app.

Local verification completed: root and Desktop typechecks, Desktop production build, 62 focused
boundary/coding/provider/MCP tests, and static inspection of the compiled main/preload/renderer.
The compiled artifacts contain no CU UI, provider, permission, takeover, native-helper path, or
legacy native-route self-test.

Still required before a public release claim: packaged `.app`/DMG content inspection and a clean-Mac
launch/code-task run proving zero TCC prompts. Historical CU benchmarks neither satisfy nor block
this code-only gate.
