#!/usr/bin/env python3
"""Diff SGT's own stream links against what MashUp already has on file.

Only returns entries MashUp has genuinely never seen — this never
overwrites or second-guesses an existing MashUp entry, even if SGT shows
a different URL for the same player/round (a player who re-submits a
corrected link on MashUp directly is the source of truth there, not SGT).

Usage: stream_gaps.py <sgt-streams.json> <mashup-streams.json>  ->  JSON array on stdout
  sgt-streams.json:    output of parse_streams.py  — [{"player","round","url"}, ...]
  mashup-streams.json: output of GET /api/get-streams?eventId=...  — {"player": {"round": "url"}}
"""
import sys
import json

if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        sgt_streams = json.load(f)
    with open(sys.argv[2], encoding="utf-8") as f:
        mashup_streams = json.load(f)

    gaps = []
    for item in sgt_streams:
        existing = mashup_streams.get(item["player"], {}).get(str(item["round"]))
        if not existing:
            gaps.append(item)

    print(json.dumps(gaps))
