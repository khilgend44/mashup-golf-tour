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
  ctp_video_link.py stream <default_fragment_html>             -> "<streamId> <videoId>", or nothing
  ctp_video_link.py offset <stream_fragment_html> <hole>        -> time offset in seconds, or nothing
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


def cmd_stream(default_fragment_html_path):
    html = read(default_fragment_html_path)
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


if __name__ == "__main__":
    step = sys.argv[1]
    if step == "slug":
        cmd_slug(sys.argv[2], sys.argv[3])
    elif step == "pid":
        cmd_pid(sys.argv[2])
    elif step == "stream":
        cmd_stream(sys.argv[2])
    elif step == "offset":
        cmd_offset(sys.argv[2], sys.argv[3])
    elif step == "reps":
        cmd_reps(sys.argv[2])
    elif step == "videoid":
        cmd_videoid(sys.argv[2])
    else:
        sys.exit(f"Unknown step: {step}")
