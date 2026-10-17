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

SGT's stream link markup (confirmed live, Oct 2026) lives inside each
leaderboard row — `<tr ... data-player-name='...'>...</tr>` — as a
`stream-menu-item` link, not the older `stream-link` class this script
used to look for (that class doesn't exist in SGT's current output at
all, solo or team — this was silently matching nothing for a while).
A solo event's row covers exactly one player, so the row's own
data-player-name attribute names them and the stream link's own text is
just "ROUND N". A team event's row covers all 3 teammates at once
(data-player-name is a space-separated list), so SGT disambiguates by
appending the specific player's name after a divider span inside the
stream link itself — when that's present, it names the actual player,
not whoever else shares the row.

Usage: parse_streams.py <path-to-fetched-html>  ->  JSON array on stdout
  [{"player": "jibbsy", "round": 1, "url": "https://youtube.com/..."}, ...]
"""
import re
import sys
import json

ROW_RE = re.compile(r"<tr[^>]*data-player-name='([^']*)'.*?</tr>", re.S)
STREAM_RE = re.compile(
    r"stream-menu-item'\s+href='([^']+)'>\s*"
    r"<i[^>]*></i><span class='text-uppercase'>\s*ROUND\s+(\d+)\s*"
    r"(?:<span class='divider'></span>\s*([^<]+))?</span>",
    re.S)


def parse(html):
    streams = []
    for row_match in ROW_RE.finditer(html):
        row_player = row_match.group(1).strip().lower()
        for url, round_num, name in STREAM_RE.findall(row_match.group(0)):
            player = name.strip().lower() if name and name.strip() else row_player
            streams.append({
                "player": player,
                "round": int(round_num),
                "url": url.strip(),
            })
    return streams


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        html = f.read()
    print(json.dumps(parse(html)))
