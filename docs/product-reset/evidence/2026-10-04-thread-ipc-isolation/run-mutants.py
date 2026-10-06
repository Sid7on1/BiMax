"""Local IPC regression proof. Mutations are restored in finally; never run beside another editor."""
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PRELOAD = ROOT / "app/src/preload/index.ts"
HOOK = ROOT / "app/src/renderer/src/useEngine.ts"
REDUCER = ROOT / "app/src/renderer/src/engine.state.ts"
COMPOSER = ROOT / "app/src/renderer/src/components/Composer.tsx"
COMMAND = ["npx", "jest", "--runInBand", "--coverage=false", "--silent=false",
           "app/src/__tests__/engine.thread.isolation.test.ts"]
originals = {p: p.read_text() for p in (PRELOAD, HOOK, REDUCER, COMPOSER)}
mutants = [
    ("preload-drops-owner", PRELOAD,
     "=> cb(msg, threadId);", "=> cb(msg);"),
    ("renderer-admits-foreign-replies", HOOK,
     "if (threadId !== store.getState().threadId) return;", "if (false) return;"),
    ("reducer-admits-foreign-restore", REDUCER,
     "&& 'threadId' in action && action.threadId !== state.threadId) return state;",
     "&& false) return state;"),
    ("switch-keeps-buffered-text", HOOK,
     "const offThread = window.bimax.threads.onSelected((value) => {\n      batcher.retire();",
     "const offThread = window.bimax.threads.onSelected((value) => {\n      // mutant keeps pending A"),
    ("attachment-admits-foreign-reply", HOOK,
     "if (threadId !== requestedThreadId || store.getState().threadId !== requestedThreadId) return;",
     "if (false) return;"),
    ("preload-drops-lifecycle-owner", PRELOAD,
     "=> cb(state, detail, threadId);", "=> cb(state, detail);"),
    ("composer-admits-foreign-restore", COMPOSER,
     "if (sourceThreadId !== threadId) return;", "if (false) return;"),
]


def run(name):
    result = subprocess.run(COMMAND, cwd=ROOT, capture_output=True, text=True)
    (HERE / f"{name}.log").write_text(result.stdout + result.stderr)
    return {"name": name, "exit_code": result.returncode, "log": f"{name}.log"}


results = []
try:
    baseline = run("baseline")
    assert baseline["exit_code"] == 0, baseline
    results.append(baseline)
    for name, target, old, new in mutants:
        assert old in originals[target], name
        target.write_text(originals[target].replace(old, new, 1))
        try:
            result = run(name)
            results.append(result)
            assert result["exit_code"] != 0, f"Survived: {name}"
            # A compilation failure is not a behavioural rejection.
            log = (HERE / result["log"]).read_text()
            assert "Tests:" in log and "failed" in log, result
        finally:
            target.write_text(originals[target])
finally:
    for target, source in originals.items():
        target.write_text(source)
    (HERE / "mutants.json").write_text(json.dumps({
        "command": COMMAND, "results": results,
        "source_sha256": {str(p.relative_to(ROOT)): hashlib.sha256(s.encode()).hexdigest()
                          for p, s in originals.items()},
    }, indent=2) + "\n")
print(json.dumps(results))
