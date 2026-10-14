#!/usr/bin/env bash
# Development loop runner — see docs/lean-core/LOOP.md.
#
# Runs one fresh, unattended `claude -p` per iteration in a separate git
# worktree (so your own checkout and editor are never touched), with a
# wall-clock cap, a log per iteration, a macOS notification after each one,
# and a stop after 3 failed iterations in a row or when .loop/STOP exists.
#
#   scripts/loop/run.sh                   # run until STOP / idle / 3 failures
#   scripts/loop/run.sh --max 3           # at most 3 iterations
#   scripts/loop/run.sh --hours 2         # wall-clock cap per iteration (default 3)
#   scripts/loop/run.sh --model sonnet    # default opus
#   scripts/loop/run.sh --dry-run         # print what would run, run nothing
#   touch .loop/STOP                      # stop after the current iteration
#
# Bash 3.2 compatible (macOS /bin/bash).
set -u

MAX=0; HOURS=3; MODEL="opus"; DRY=0; PAUSE=60
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX="$2"; shift 2 ;;
    --hours) HOURS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --pause) PAUSE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "run from inside the repo" >&2; exit 2; }
LOOP_DIR="$REPO/.loop"
WT="${LOOP_WORKTREE:-$(dirname "$REPO")/$(basename "$REPO")-loop}"
mkdir -p "$LOOP_DIR/logs" "$LOOP_DIR/bin"

# Run from a private copy: the agent switches branches, and bash reads a
# script lazily, so editing or removing this file mid-run must not matter.
if [ "${LOOP_RUNNER_COPY:-0}" != "1" ]; then
  cp "$0" "$LOOP_DIR/bin/run.sh"
  cp "$(dirname "$0")/PROMPT.md" "$LOOP_DIR/bin/PROMPT.md"
  ARGS="$( [ "$MAX" != 0 ] && echo "--max $MAX") --hours $HOURS --model $MODEL --pause $PAUSE $( [ "$DRY" = 1 ] && echo --dry-run)"
  # shellcheck disable=SC2086
  LOOP_RUNNER_COPY=1 exec bash "$LOOP_DIR/bin/run.sh" $ARGS
fi
case "$HOURS" in *[!0-9]*|'') echo "--hours takes whole hours" >&2; exit 2 ;; esac

command -v claude >/dev/null || { echo "claude CLI not found on PATH" >&2; exit 2; }
command -v pnpm >/dev/null || { echo "pnpm not found on PATH" >&2; exit 2; }

notify() {
  echo "[loop] $1"
  if command -v osascript >/dev/null; then
    osascript -e "display notification \"$(echo "$1" | sed 's/"/\\"/g')\" with title \"DESPL loop\"" >/dev/null 2>&1 || true
  fi
}

# Keep a Mac awake while the loop runs.
if command -v caffeinate >/dev/null; then caffeinate -i -w $$ & fi

# Separate worktree for the agent.
if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
  git -C "$REPO" fetch --prune origin >/dev/null 2>&1
  git -C "$REPO" worktree prune
  git -C "$REPO" worktree add --detach "$WT" origin/main || { echo "could not create worktree $WT" >&2; exit 2; }
fi
for f in .env .env.test; do
  [ -f "$REPO/$f" ] && [ ! -f "$WT/$f" ] && cp "$REPO/$f" "$WT/$f"
done

PERM_FLAGS="--permission-mode auto"
if claude --help 2>/dev/null | grep -q -- "--permission-prompts"; then
  PERM_FLAGS="$PERM_FLAGS --permission-prompts none"
else
  echo "[loop] warning: this claude has no --permission-prompts; update Claude Code so unattended runs never wait on a prompt" >&2
fi

i=0; fails=0
while :; do
  [ -f "$LOOP_DIR/STOP" ] && { notify "stopped: $LOOP_DIR/STOP exists"; break; }
  [ "$MAX" != 0 ] && [ "$i" -ge "$MAX" ] && { notify "done: $MAX iteration(s)"; break; }
  i=$((i + 1))
  STAMP="$(date +%Y%m%d-%H%M%S)"
  LOG="$LOOP_DIR/logs/$STAMP-iter$i.json"
  PROMPT="$(sed -e "s#{{WORKTREE}}#$WT#g" -e "s#{{LOOP_DIR}}#$LOOP_DIR#g" \
                -e "s#{{ITERATION}}#$i#g" -e "s#{{STARTED_AT}}#$(date '+%Y-%m-%d %H:%M %Z')#g" \
                "$LOOP_DIR/bin/PROMPT.md")"

  if [ "$DRY" = 1 ]; then
    echo "[dry-run] cd $WT && claude -p <PROMPT> --model $MODEL $PERM_FLAGS --output-format json > $LOG (cap ${HOURS}h)"
    echo "$PROMPT"; break
  fi

  notify "iteration $i started ($STAMP)"
  ( cd "$WT" && exec claude -p "$PROMPT" --model "$MODEL" $PERM_FLAGS --output-format json ) > "$LOG" 2> "$LOG.stderr" &
  CPID=$!
  # Wall-clock cap: SIGINT first (ends the turn cleanly), SIGTERM 2 minutes later.
  T0=$(date +%s); SENT_INT=0
  while kill -0 "$CPID" 2>/dev/null; do
    sleep 5
    NOW=$(date +%s)
    if [ "$SENT_INT" = 0 ] && [ $((NOW - T0)) -ge $((HOURS * 3600)) ]; then
      kill -INT "$CPID" 2>/dev/null; SENT_INT=$NOW
    elif [ "$SENT_INT" != 0 ] && [ $((NOW - SENT_INT)) -ge 120 ]; then
      kill -TERM "$CPID" 2>/dev/null
    fi
  done
  wait "$CPID"; CODE=$?

  LINE="$(node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const j=JSON.parse(s); const r=String(j.result||"");
        const m=r.match(/LOOP RESULT:.*$/m);
        console.log((j.is_error||j.subtype!=="success"?"ERROR ":"")+(m?m[0]:"NO RESULT LINE ("+(j.subtype||"?")+")"));
      } catch(e) { console.log("ERROR unreadable output"); } });' < "$LOG")"

  if [ "$CODE" != 0 ] || echo "$LINE" | grep -q "^ERROR\|NO RESULT LINE\| red "; then
    fails=$((fails + 1))
  else
    fails=0
  fi
  echo "$STAMP iter$i exit=$CODE $LINE" >> "$LOOP_DIR/history.log"
  notify "iteration $i: $LINE"

  echo "$LINE" | grep -q " IDLE \| idle " && { notify "idle: nothing ready — see the hand-off in progress.md"; break; }
  [ "$fails" -ge 3 ] && { notify "stopped after 3 failed iterations in a row — read $LOOP_DIR/logs"; break; }
  sleep "$PAUSE"
done
