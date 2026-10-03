#!/usr/bin/env python3
"""Count captured viewer frames without importing the Pulsar server or SDK.

Usage: python3 read_frames.py before.json after.json
Prints JSON; exits nonzero if the recorded before/after behavior differs.
This is a project-authored second implementation, not independent-party review.
"""
import hashlib
import json
import pathlib
import sys

PATHS = ("no-audio-expected", "browser-provider", "no-provider", "pending-audio-control")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect(filename, repaired):
    path = pathlib.Path(filename)
    raw = path.read_bytes()
    capture = json.loads(raw)
    require(capture["synthetic"] and not capture["productionConnection"]
            and not capture["externalParticipant"], "Expected synthetic local capture")
    require([c["name"] for c in capture["cases"]] == list(PATHS), "Missing or reordered paths")
    counts = []
    for case in capture["cases"]:
        label = case["name"]
        command = case["inputs"]["hostCommand"]
        require(command["type"] == "stream_text", f"{label}: missing host input")
        text = command["payload"]["text"]
        require(text == case["hostText"], f"{label}: input text differs")
        pending = label == "pending-audio-control"
        before = case["beforeEnd"]
        after = case["afterEnd"]
        # afterEnd is a cumulative capture, not a second set of deliveries.
        require(after["viewerFrames"][:len(before["viewerFrames"])] == before["viewerFrames"],
                f"{label}: frames were modified between snapshots")
        contexts = [f["payload"]["recentMessages"] for f in before["viewerFrames"]
                    if f["type"] == "viewer_context" and f["payload"].get("yourTurn")]
        require(len(contexts) == 1, f"{label}: expected one reaction-context frame")
        require(sum(f["type"] == "viewer_context" for f in after["viewerFrames"]) == 1,
                f"{label}: extra context frame")
        context = contexts[0]
        matches = [m for m in context if m.get("role") == "host" and m.get("text") == text]
        expected = 1 if repaired or pending else 2
        require(len(matches) == expected, f"{label}: expected {expected} host copies, got {len(matches)}")
        audience = case["inputs"]["audienceCommand"]["payload"]["text"]
        audience_positions = [i for i, m in enumerate(context) if m.get("role") == "viewer" and m.get("text") == audience]
        host_positions = [i for i, m in enumerate(context) if m in matches]
        require(len(audience_positions) == 1 and audience_positions[0] < min(host_positions),
                f"{label}: preceding audience message lost or reordered")
        row = {"path": label, "hostCopiesInOneReactionContext": len(matches),
               "hostContextIds": [m.get("id") for m in matches]}
        for phase, snapshot in (("beforeEnd", before), ("afterEnd", after)):
            updates = [m for f in snapshot["viewerFrames"] if f["type"] == "live_update"
                       for m in f["messages"] if m.get("role") == "host" and m.get("text") == text]
            stored = [m for m in snapshot["sqliteRows"] if m["role"] == "host" and m["text"] == text]
            count = 0 if pending and phase == "beforeEnd" else 1
            require(len(updates) == len(stored) == count, f"{label}/{phase}: delivery/storage count mismatch")
            require([m["id"] for m in updates] == [m["id"] for m in stored],
                    f"{label}/{phase}: delivered IDs differ from stored IDs")
            row[phase] = {"hostLiveUpdateCount": len(updates), "hostSQLiteRowCount": len(stored),
                          "liveUpdateIds": [m["id"] for m in updates], "sqliteIds": [m["id"] for m in stored]}
        expected_ids = ([None] if pending else
                        row["beforeEnd"]["sqliteIds"] + ([] if repaired else [None]))
        require(row["hostContextIds"] == expected_ids, f"{label}: unexpected context IDs")
        counts.append(row)
    return {"file": path.name, "sha256": hashlib.sha256(raw).hexdigest(),
            "sourceCommit": capture["sourceCommit"], "cases": counts}


def main():
    require(len(sys.argv) == 3, "Usage: python3 read_frames.py before.json after.json")
    result = {"syntheticLocalOnly": True, "thirdPartyReview": False,
              "reader": "Separate project-authored Python implementation; imports no server or SDK code",
              "before": inspect(sys.argv[1], repaired=False),
              "after": inspect(sys.argv[2], repaired=True), "expectationsSatisfied": True}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
