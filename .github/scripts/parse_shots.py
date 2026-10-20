#!/usr/bin/env python3
"""Parse SGT's per-player "shots" scorecard fragment into Drive of the Week,
Approach of the Week, and Putt of the Week candidates.

Each shot row reads like `{distance traveled} to {lie} · {distance left}`
(e.g. "207 yds" / "to deeprough · 297 yds left", or for a putt, "Putt 30
ft" / "3 ft left"). Confirmed by cross-checking several real examples: the
second number is the distance STILL REMAINING to the pin after that shot,
not a sideways miss — a 30 ft putt leaving "3 ft left" only makes sense as
"3 feet short of the hole", and a 29-yard chip leaving "11 ft left" the
same way. That remaining-distance value becomes the next shot's starting
distance, which is what Approach of the Week's "outside 100 yards" cutoff
is measured against.

Approach of the Week is deliberately restricted to par-4/5 holes only —
a par-3 tee shot is already covered by the CTP contest itself, so
counting it here too would just be the same shot winning twice. A
par-4/5 tee shot (the drive) is never an approach candidate either,
regardless of distance — only shot 2 onward counts, gated by the
previous shot's remaining distance exceeding 100 yards (this fragment
never states a hole's total yardage, only its par, so a tee shot's own
starting distance isn't knowable here — moot anyway since tee shots are
excluded).

One "shots" fragment can cover a whole team (teammates share one
scorecard in a team format), so this scans the whole document for however
many player sections it contains, not just one.

Putt of the Week is the longest putt that actually goes in — SGT's own
text distinguishes this clearly: a holed putt reads "Made {N} ft putt"
(lie-holecup, no detail span), distinct from a conceded "Tap-in" / "gimme"
and from a holed-out approach/chip ("Holed out" / "from {N} yds" — a
non-putt shot holed from off the green, not counted here).

Usage: parse_shots.py <shots_fragment_html_path>
  -> {"drives": [{"player","hole","par","distanceYds"}],
      "approaches": [{"player","hole","par","proximityFt"}],
      "putts": [{"player","hole","lengthFt"}]} on stdout
"""
import re
import sys
import json

PLAYER_RE = re.compile(r"<div class='h5 text-center text-lg-start text-sgt-light mb-3'>([^<]+)</div>")
SHOT_RE = re.compile(
    r"<div class='shot-number lie-(\w+)[^']*'[^>]*>\d+</div>\s*"
    r"<div class='ms-2'><span class='shot-main'>([^<]+)</span>\s*"
    r"(?:<span class='shot-detail'>([^<]*)</span>)?",
    re.S)


def parse_main(text):
    """Returns distance traveled in yards, or None for a Tap-in (no distance)."""
    text = text.strip()
    m = re.match(r"([\d.]+)\s*yds$", text)
    if m:
        return float(m.group(1))
    m = re.match(r"Putt\s+([\d.]+)\s*ft$", text)
    if m:
        return float(m.group(1)) / 3.0
    return None  # "Tap-in"


def parse_remaining_ft(detail_text):
    """Returns remaining distance to pin in feet, or 0.0 for a gimme/holed shot."""
    if detail_text is None:
        return 0.0
    detail_text = detail_text.strip()
    if 'gimme' in detail_text.lower():
        return 0.0
    m = re.search(r"([\d.]+)\s*(ft|yds)\s*left", detail_text)
    if not m:
        return 0.0
    value, unit = float(m.group(1)), m.group(2)
    return value * 3.0 if unit == 'yds' else value


MADE_PUTT_RE = re.compile(r"Made\s+([\d.]+)\s*ft putt$")


def parse(html):
    drives = []
    approaches = []
    putts = []

    player_matches = list(PLAYER_RE.finditer(html))
    for i, pm in enumerate(player_matches):
        player = pm.group(1).strip()
        section_end = player_matches[i + 1].start() if i + 1 < len(player_matches) else len(html)
        section = html[pm.end():section_end]

        hole_matches = list(re.finditer(r"<div data-hole='(\d+)'", section))
        for j, hm in enumerate(hole_matches):
            hole = int(hm.group(1))
            hole_end = hole_matches[j + 1].start() if j + 1 < len(hole_matches) else len(section)
            chunk = section[hm.start():hole_end]

            par_m = re.search(r"PAR (\d+)", chunk)
            if not par_m:
                continue
            par = int(par_m.group(1))

            prior_remaining_yds = None  # unknown starting distance for shot 1
            for shot_i, sm in enumerate(SHOT_RE.finditer(chunk)):
                lie, main_text, detail_text = sm.group(1), sm.group(2), sm.group(3)
                is_first_shot = shot_i == 0

                made_putt_m = MADE_PUTT_RE.match(main_text.strip())
                if made_putt_m:
                    putts.append({"player": player, "hole": hole, "lengthFt": float(made_putt_m.group(1))})
                    break  # holing out always ends the hole — nothing follows

                distance_yds = parse_main(main_text)
                remaining_ft = parse_remaining_ft(detail_text)

                if is_first_shot and par in (4, 5) and lie == 'fairway' and distance_yds is not None:
                    drives.append({"player": player, "hole": hole, "par": par, "distanceYds": distance_yds})

                is_eligible_approach = (
                    not is_first_shot and par in (4, 5) and
                    prior_remaining_yds is not None and prior_remaining_yds > 100
                )
                if is_eligible_approach and distance_yds is not None:
                    approaches.append({"player": player, "hole": hole, "par": par, "proximityFt": remaining_ft})

                prior_remaining_yds = remaining_ft / 3.0

    return {"drives": drives, "approaches": approaches, "putts": putts}


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        html = f.read()
    print(json.dumps(parse(html)))
