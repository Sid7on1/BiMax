# X01 fixture — Bimax To-Do

Record 65 stage 5 (build → run → prove). A small AppKit to-do app with deterministic data: two completed and two
active to-dos and one settings block. A run copies this folder to a fresh place, and the task is X01's prompt:
add a "Clear Completed" button, test it, build, launch, press it, and prove only the completed to-dos went.

- `./run-tests.sh` — compiles `Sources/TodoCore.swift` with `Tests/TodoCoreTests.swift` and runs them.
- `./build.sh` — builds `build/BimaxTodo.app` (bundle id `ai.bimax.cu.x01-todo`) and prints its executable's SHA-256.
- `data/todos.json` — the to-dos the app reads and saves; the grader reads the same file.

Command Line Tools `swiftc` only; no Xcode project.
