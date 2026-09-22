#!/usr/bin/env python3
"""Parse SGT's closest-to-pin (CTP) leaderboard HTML fragment into JSON.

SGT doesn't expose CTP as a clean API — this scrapes the same HTML
fragment their own site's CTP tab renders (fetched by
fetch-scorecards.yml). If SGT changes that markup, this will start
producing empty `rounds: []` output rather than crashing the fetch job;
that's the accepted tradeoff for not having an official endpoint.

Usage: parse_ctp.py <path-to-fetched-html>  ->  JSON on stdout
"""
import re
import sys
import json

def parse(html):
    round_pattern = re.compile(
        r"<h3[^>]*>ROUND\s+(\d+)</h3>(.*?)(?=<h3[^>]*>ROUND\s+\d+</h3>|$)", re.S)
    hole_pattern = re.compile(
        r"<h5[^>]*>HOLE\s+(\d+)</h5>\s*<p[^>]*>AVG\s*-\s*([\d.]+)\s*FT</p>(.*?)"
        r"(?=<h5[^>]*>HOLE\s+\d+</h5>|$)", re.S)
    # SGT's own markup mislabels the profile href for every leader after the
    # first on a hole (all point at the first player's profile) — so we
    # don't trust `profile` for anything; the display name is reliable.
    # Flag codes aren't always a plain 2-letter country (UK constituent
    # countries render as compound codes like "fi-gb-nir", "fi-gb-sct") —
    # confirmed 2026-09, a player with a Northern Ireland flag was silently
    # dropped entirely because `fi-[a-z]+` doesn't match past the hyphen,
    # so the whole leader match failed. Allow hyphens in the code.
    player_pattern = re.compile(
        r"player-flag\s+fib\s+(fi-[a-z-]+)\s+fis.*?"
        r"<a href='/profile/[^']+'[^>]*>([^<]+)</a>\s*"
        r"<div[^>]*>([\d.]+)\s*ft</div>",
        re.S)

    rounds = []
    for rmatch in round_pattern.finditer(html):
        round_num = int(rmatch.group(1))
        holes = []
        for hmatch in hole_pattern.finditer(rmatch.group(2)):
            leaders = [
                {"player": name.strip(), "flag": flag, "distance_ft": float(dist)}
                for flag, name, dist in player_pattern.findall(hmatch.group(3))
            ]
            holes.append({
                "hole": int(hmatch.group(1)),
                "avg_ft": float(hmatch.group(2)),
                "leaders": leaders,
            })
        rounds.append({"round": round_num, "holes": holes})

    return {"rounds": rounds}


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        html = f.read()
    print(json.dumps(parse(html)))
