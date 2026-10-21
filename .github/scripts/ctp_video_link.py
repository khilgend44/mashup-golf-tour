#!/usr/bin/env python3
"""Parse each step of resolving a timestamped YouTube link for a CTP shot,
for players who linked their stream through SGT's own "Add Streams" modal
(not MashUp's own submission form). Pure parsing, no networking — curl does
every fetch in fetch-scorecards.yml, same split as parse_ctp.py/parse_streams.py;
this just has more steps because the data it needs isn't in one fragment.

SGT exposes two different per-hole time fields on a stream-linked
scorecard's replay fragment: a per-shot `data-time-offset` (confirmed
unreliable — it drifts by a different amount on every stream, 31s on one,
56s on another, because it's set whenever SGT's own system detects the
broadcast as live, not from the shot's real clock time) and a per-hole
"Play hole N" `data-time-offset` (the one SGT's own UI uses for the "jump
to this hole" link under its embedded player — confirmed accurate to
within a second against two real streams). This only ever reads the
per-hole one (the `offset` subcommand).

A player's /scorecard/{tid}/{X} URL slug, X (found in the tournament
leaderboard's own scorecard links — the `slug` subcommand), is NOT the id
SGT's AJAX API expects as `pid` for that same scorecard — that's a
separate internal id only exposed via the scorecard page's own `data-pid`
attribute (the `pid` subcommand). `data-is-team` is passed straight
through unparsed into the next URL, exactly like SGT's own JS does
($("#scorecard-container").attr("data-is-team")) — never hardcode what
value it holds, just relay it.

Usage, one step at a time (each step's curl happens in bash between
calls, since each URL depends on the previous step's output):
  ctp_video_link.py slug   <leaderboard_html> <player>        -> scorecard URL slug, or nothing
  ctp_video_link.py pid    <scorecard_page_html>               -> "<pid> <is_team>", or nothing
  ctp_video_link.py stream <default_fragment_html> <player>    -> "<streamId> <videoId>", or nothing
                                                                    (see cmd_stream for why <player>
                                                                    is required, not optional)
  ctp_video_link.py offset <stream_fragment_html> <hole>        -> hole-level time offset in seconds
                                                                    — really just shot 1's own offset,
                                                                    correct for a tee shot (CTP),
                                                                    wrong for any later shot
  ctp_video_link.py shotoffset <stream_fragment_html> <hole> <shotNum> <expectedValue>
                                                                 -> that specific shot's own offset, but
                                                                    ONLY if its own on-screen value
                                                                    (remaining-ft, or putt length)
                                                                    matches <expectedValue> — see
                                                                    cmd_shotoffset for why this check
                                                                    isn't optional. Use for Approach/
                                                                    Putt of the Week, never shot 1.
  ctp_video_link.py reps   <leaderboard_html>                   -> one "<player> <slug>" per line,
                                                                    one per distinct scorecard entry
  ctp_video_link.py videoid <youtube_url>                        -> bare video id, or nothing
                                                                    (SGT's own links and MashUp's
                                                                    submitted ones use different URL
                                                                    shapes for the same video —
                                                                    youtube.com/live/ID vs
                                                                    watch?v=ID — so comparing ids is
                                                                    what actually catches a match)
Prints nothing (exit 0) when a step can't resolve — the common case for
the many players who haven't linked a stream via SGT's own system, not
an error.
"""
import re
import sys


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def cmd_slug(leaderboard_html_path, player):
    html = read(leaderboard_html_path)
    player_l = player.strip().lower()
    for row_m in re.finditer(r"<tr[^>]*data-player-name='([^']*)'.*?</tr>", html, re.S):
        names = row_m.group(1).strip().lower().split()
        if player_l in names:
            slug_m = re.search(r"/scorecard/\d+/(\d+)", row_m.group(0))
            if slug_m:
                print(slug_m.group(1))
            return


def cmd_pid(scorecard_page_html_path):
    html = read(scorecard_page_html_path)
    m = re.search(r"<div[^>]*id=[\"']scorecard-container[\"'][^>]*>", html)
    if not m:
        return
    tag = m.group(0)
    pid_m = re.search(r"data-pid=[\"'](\d+)[\"']", tag)
    team_m = re.search(r"data-is-team=[\"']([^\"']*)[\"']", tag)
    if pid_m:
        print(f"{pid_m.group(1)} {team_m.group(1) if team_m else ''}")


def cmd_stream(default_fragment_html_path, player):
    """A scorecard's linked stream(s). Two real markup shapes, confirmed
    live: a single un-named `stream-play-button` div when only one stream
    is linked to this scorecard at all (solo, or a team where only one
    teammate has linked anything) — safe to use directly, there's no
    ambiguity. But when a team has MULTIPLE teammates who each
    independently linked their OWN separate stream, SGT instead renders a
    dropdown of named buttons, one per teammate, each tagged
    `<span class='text-uppercase'>{player}</span>`. A naive first-match
    grab here silently returns whichever teammate's button happens to come
    first in the document — confirmed live as a real bug: cloverlinksgolf
    and winch99 (teammates, each with their own distinct stream) both
    resolved to winch99's video, because his button simply appeared first.
    Must match by name in the multi-stream case, and must NOT fall back to
    guessing if this specific player isn't one of the named buttons."""
    html = read(default_fragment_html_path)
    player_lower = player.strip().lower()

    named = re.findall(
        r"data-stream-id='(\d+)'\s+data-video-id='([\w-]+)'[^>]*>.*?<span class='text-uppercase'>([^<]+)</span>",
        html, re.S)
    if named:
        for stream_id, video_id, owner in named:
            if owner.strip().lower() == player_lower:
                print(f"{stream_id} {video_id}")
                return
        return  # named buttons exist, but not for this player — don't guess

    m = re.search(r"data-stream-id='(\d+)'\s+data-video-id='([\w-]+)'", html)
    if m:
        print(f"{m.group(1)} {m.group(2)}")


def cmd_reps(leaderboard_html_path):
    """One representative player per distinct scorecard entry — teammates in
    a team format share one scorecard (and so one slug), so fetching more
    than the first teammate's shots would just refetch identical bytes.
    Works for both team and solo formats unchanged, since a solo row's own
    data-player-name is just a single name."""
    html = read(leaderboard_html_path)
    seen_slugs = set()
    for row_m in re.finditer(r"<tr[^>]*data-player-name='([^']*)'.*?</tr>", html, re.S):
        names = row_m.group(1).strip().split()
        if not names:
            continue
        slug_m = re.search(r"/scorecard/\d+/(\d+)", row_m.group(0))
        if not slug_m:
            continue
        slug = slug_m.group(1)
        if slug in seen_slugs:
            continue
        seen_slugs.add(slug)
        print(f"{names[0]} {slug}")


YT_URL_PATTERN = re.compile(
    r"^https?://(www\.)?(?:youtube\.com/watch\?v=([\w-]+)|youtu\.be/([\w-]+)|youtube\.com/live/([\w-]+))")


def cmd_videoid(url):
    m = YT_URL_PATTERN.match(url.strip())
    if not m:
        return
    vid = m.group(2) or m.group(3) or m.group(4)
    if vid:
        print(vid)


def cmd_offset(stream_fragment_html_path, hole):
    html = read(stream_fragment_html_path)
    for m in re.finditer(r"<div[^>]*class='play-hole-button[^>]*>", html):
        tag = m.group(0)
        if f"data-hole='{hole}'" not in tag:
            continue
        off_m = re.search(r"data-time-offset='(\d+)'", tag)
        if off_m:
            print(off_m.group(1))
        return


def _parse_remaining_ft(detail_text):
    if detail_text is None:
        return None
    detail_text = detail_text.strip()
    if 'gimme' in detail_text.lower():
        return 0.0
    m = re.search(r"([\d.]+)\s*(ft|yds)\s*left", detail_text)
    if not m:
        return None
    value, unit = float(m.group(1)), m.group(2)
    return value * 3.0 if unit == 'yds' else value


def cmd_shotoffset(stream_fragment_html_path, hole, shot_num, expected_value):
    """A specific shot's own data-time-offset, by hole + shot number (1-based,
    positional within the hole — mirrors parse_shots.py's own enumeration,
    not the shot's displayed number text). Needed because the hole-level
    `offset` (above) is really just shot 1's own offset under a different
    name — exactly right for a CTP tee shot, provably wrong (confirmed
    live, ~45-120s early) for any later shot, which Approach/Putt of the
    Week always are.

    Only returns a timestamp if this shot's own on-screen value (remaining
    distance to pin, or the putt length for a holed putt) matches the
    value already recorded for this candidate — confirmed live as
    necessary, not optional: the per-shot breakdown embedded in a team's
    stream replay view has been observed to reflect one specific
    teammate's own numbers regardless of which of several linked streams
    you actually query (SteveMac/adamw19, and again cloverlinksgolf/
    winch99 — cloverlinksgolf's own individually-linked stream embedded
    winch99's shot sequence for a shared hole, not his own). The hole-
    level offset has held up regardless of whose numbers are shown
    (teammates' tee shots cluster in time), but there's no equivalent
    guarantee for a later shot — so this requires the shot's own value to
    actually match before trusting its timestamp, and returns nothing
    rather than a silently-wrong guess when it doesn't.

    Returns the MIDPOINT of the shot's own data-time-offset/data-time-end
    window, not the raw offset — confirmed live, twice, that the raw
    offset alone lands early: a verified-correct approach shot's window
    was 1276-1360s, and the real moment (per direct report, ~22:00) was
    1320s, 2 seconds from the midpoint (1318s) and 44s after the raw
    offset. Plausible mechanism: the window appears to start at setup/
    walk-up rather than contact and end after the result displays, so
    contact itself sits nearer the middle than either edge — unlike a
    hole's first shot (CTP), where the raw offset alone has held up on
    its own, so that case (the `offset` subcommand above) is untouched."""
    html = read(stream_fragment_html_path)
    shot_num = int(shot_num)
    try:
        expected = float(expected_value)
    except ValueError:
        return

    pattern = re.compile(
        r"<div[^>]*data-hole='%s'\s+data-time-offset='(\d+)'\s+data-time-end='(\d+)'[^>]*class='shot-row[^>]*>\s*"
        r"<div class='shot-number[^>]*>\d+</div>\s*"
        r"<div class='ms-2'><span class='shot-main'>([^<]+)</span>\s*"
        r"(?:<span class='shot-detail'>([^<]*)</span>)?" % re.escape(str(hole)),
        re.S)

    count = 0
    for m in pattern.finditer(html):
        count += 1
        if count != shot_num:
            continue
        offset, end, main_text, detail_text = m.group(1), m.group(2), m.group(3), m.group(4)
        made_putt_m = re.match(r"Made\s+([\d.]+)\s*ft putt$", main_text.strip())
        actual = float(made_putt_m.group(1)) if made_putt_m else _parse_remaining_ft(detail_text)
        if actual is not None and abs(actual - expected) < 0.5:
            print((int(offset) + int(end)) // 2)
        return


if __name__ == "__main__":
    step = sys.argv[1]
    if step == "slug":
        cmd_slug(sys.argv[2], sys.argv[3])
    elif step == "pid":
        cmd_pid(sys.argv[2])
    elif step == "stream":
        cmd_stream(sys.argv[2], sys.argv[3])
    elif step == "offset":
        cmd_offset(sys.argv[2], sys.argv[3])
    elif step == "shotoffset":
        cmd_shotoffset(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
    elif step == "reps":
        cmd_reps(sys.argv[2])
    elif step == "videoid":
        cmd_videoid(sys.argv[2])
    else:
        sys.exit(f"Unknown step: {step}")
