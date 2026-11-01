"""Grade retained native end states, then prove rejection with receipt mutations.

These are local fixture runs, not model-tier or full M02/X01 qualification.
The independent persisted save counter is authoritative for duplicate effects.
"""
from pathlib import Path
import copy
import json
import re

ROOT = Path(__file__).resolve().parent
BUILD = "c9d269bce3f4e2e6fbea19139dd81a681752ce366fe3423f196c9f1e04f847dd"


def grade(q):
    assert q["installedSha256"] in {BUILD, json.loads((ROOT / "install-v2.json").read_text())["appAsarSha256"]}, "installed build"
    assert q["status"] == "idle", "unfinished model task"
    assert q["calls"] and all(c["toolName"] in ("BimaxCuTool", "AskUserTool") for c in q["calls"]), "foreign tool"
    workflows = [c for c in q["calls"] if c["toolName"] == "BimaxCuTool" and json.loads(c["input"]).get("operation") == "workflow"]
    assert len(workflows) == 1, "missing/repeated workflow"
    call = workflows[0]
    plan, result = json.loads(call["input"]), json.loads(call["output"])
    assert call["status"] == "success" and result["ok"] is True and result["verified"] is True, "unverified receipt"
    assert len(plan["steps"]) == 2 and [s["action"] for s in plan["steps"]] == ["SET_VALUE", "CLICK"], "ordered plan"
    assert [s["control"] for s in plan["steps"]] == ["Verification message", "Save verification"], "wrong controls"
    mode = result["mode"]
    tokens = {"teach": "bimax-cu-modes-20261011", "guide": "bimax-guide-repeat-20261011", "do": "bimax-do-reuse-20261011"}
    token = tokens[mode]
    assert plan["steps"][0]["value"] == token and q["before"]["text"] != token, "literal plan"
    assert q["after"] == {"text": token, "saves": q["before"]["saves"] + 1}, "persistent exact state/one save"
    assert result["completedCount"] == 2 and len(result["completed"]) == 2, "partial result"
    assert [s["index"] for s in result["completed"]] == [0, 1] and all(s["verified"] is True for s in result["completed"]), "unverified step"
    assert [s["action"] for s in result["completed"]] == ["SET_VALUE", "CLICK"], "completed order"
    if mode == "guide":
        assert result["attempted"] == [] and all(s["input"] is False for s in result["completed"]), "Guide dispatched input"
    else:
        assert len(result["attempted"]) == 2 and [s["action"] for s in result["attempted"]] == ["SET_VALUE", "CLICK"], "replayed input"
        assert all(s["inputStatus"] == "done" for s in result["attempted"]) and all(s["input"] is True for s in result["completed"]), "input receipt"
    if mode == "teach":
        assert plan["steps"][1]["expect"]["value"] == "Saved", "recovery trigger missing"
        assert result["verification"] == "user-corrected-expectation", "assistance hidden"
    else:
        assert plan["steps"][1]["expect"] == {"role": "StaticText", "value": "Saved: " + token}, "literal postcondition"
        assert result["verification"] == "exact", "incorrect verification classification"
    final = result["final"]
    target = (10526, 697) if mode == "teach" else (3359, 136)
    assert (plan["pid"], plan["window_id"]) == target == (final["pid"], final["window_id"]), "foreign native target"
    assert final["application"] == "Arc Fixture" and final["window"] == "Arc Driver Verification", "wrong app/window"
    match = re.fullmatch(r"[0-9a-f-]{36}:s(\d+)", final["snapshot"])
    assert match and int(match[1]) >= 3, "missing/stale independent observation"
    for c in q["calls"]:
        if c["toolName"] == "BimaxCuTool" and json.loads(c["input"]).get("operation") == "observe":
            initial = json.loads(c["output"])
            assert initial["snapshot"] != final["snapshot"], "reused original snapshot"
    elements = final["elements"]
    assert sum(e.get("role") == "TextField" and e.get("name") == "Verification message" and e.get("value") == token for e in elements) == 1, "field readback"
    assert sum(e.get("role") == "StaticText" and e.get("value") == "Saved: " + token for e in elements) == 1, "status readback"
    if mode in ("guide", "do"):
        independent = q["independentAX"]
        assert independent["app"] == "org.arc.proof.fixture" and independent["window"] == final["window"], "independent target"
        assert independent["field"] == token and independent["status"] == "Saved: " + token, "independent AX mismatch"
    return mode


def output_mutation(q, change):
    c = next(c for c in q["calls"] if json.loads(c["input"]).get("operation") == "workflow")
    o = json.loads(c["output"])
    change(o)
    c["output"] = json.dumps(o)


def run():
    receipts = [json.loads((ROOT / name).read_text()) for name in ("live-teach.json", "live-guide.json", "live-do.json")]
    grades, faults = [], []
    mutations = {
        "unchanged_state": lambda q: q.update(after=copy.deepcopy(q["before"])),
        "duplicate_save": lambda q: q["after"].update(saves=q["before"]["saves"] + 2),
        "wrong_persisted_text": lambda q: q["after"].update(text="wrong"),
        "unfinished_task": lambda q: q.update(status="working"),
        "missing_workflow": lambda q: q.update(calls=[]),
        "foreign_tool": lambda q: q["calls"].append({"toolName": "BashTool"}),
        "foreign_window": lambda q: output_mutation(q, lambda o: o["final"].update(window_id=999)),
        "stale_snapshot": lambda q: output_mutation(q, lambda o: o["final"].update(snapshot=o["final"]["snapshot"].split(":")[0] + ":s1")),
        "missing_observation": lambda q: output_mutation(q, lambda o: o["final"].update(elements=[])),
        "wrong_status": lambda q: output_mutation(q, lambda o: [e.update(value="Not saved") for e in o["final"]["elements"] if e.get("role") == "StaticText"]),
    }
    for baseline in receipts:
        mode = grade(baseline)
        grades.append({"mode": mode, "threadId": baseline["threadId"], "pass": True, "persistedSaves": [baseline["before"]["saves"], baseline["after"]["saves"]]})
        cases = dict(mutations)
        if mode == "teach":
            cases["hidden_human_correction"] = lambda q: output_mutation(q, lambda o: o.update(verification="exact"))
        if mode == "guide":
            cases["Guide_native_input"] = lambda q: output_mutation(q, lambda o: o["completed"][0].update(input=True))
            cases["independent_AX_mismatch"] = lambda q: q["independentAX"].update(field="wrong")
        for name, mutate in cases.items():
            q = copy.deepcopy(baseline)
            mutate(q)
            try:
                grade(q)
            except AssertionError as err:
                faults.append({"mode": mode, "fault": name, "assertionCaught": True, "reason": str(err)})
            else:
                raise AssertionError(f"Grader accepted {mode}/{name}")
    report = {"scope": "Three owned-fixture local model runs, one per mode; Teach explicitly assisted. Not repeated model-tier, full M02/X01, performance or distribution qualification.", "grades": grades, "graderFaults": faults, "faultsCaught": len(faults)}
    (ROOT / "live-grades.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passedModes": [g["mode"] for g in grades], "graderFaultsCaught": len(faults)}))


if __name__ == "__main__":
    run()
