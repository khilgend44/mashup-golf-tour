#!/usr/bin/env python3
"""Parse SGT's own tournament leaderboard HTML fragment for stream links.

Some players post their YouTube link directly on SGT's tournament page
(via its "Add Streams" modal) instead of MashUp's own submission form, so
MashUp's site never learns about it. This scrapes the same internal AJAX
fragment SGT's own leaderboard renders (fetched by fetch-scorecards.yml,
reusing the session cookie already grabbed for the CTP fetch) to find
those links. If SGT changes that markup, this will start producing an
empty `[]` rather than crashing the fetch job — same accepted tradeoff
as parse_ctp.py.

Usage: parse_streams.py <path-to-fetched-html>  ->  JSON array on stdout
  [{"player": "jibbsy", "round": 1, "url": "https://youtube.com/..."}, ...]
"""
import re
import sys
import json


def parse(html):
    pattern = re.compile(
        r"stream-link'\s+href='([^']+)'>\s*"
        r"<div[^>]*>\s*"
        r"<div>ROUND\s+(\d+)</div>\s*"
        r"<div[^>]*>([^<]+)</div>",
        re.S)

    streams = []
    for url, round_num, name in pattern.findall(html):
        streams.append({
            "player": name.strip().lower(),
            "round": int(round_num),
            "url": url.strip(),
        })
    return streams


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        html = f.read()
    print(json.dumps(parse(html)))
