#!/usr/bin/env bash
# Stop idle ComfyUI workers so their VRAM returns to zero, and start them
# again when platform work is waiting.
#
# Background: a running ComfyUI process always holds ~300MiB of CUDA context,
# and after a job it keeps the full model weights until something unloads
# them. The gateway already POSTs /free the moment each platform job reaches a
# terminal state, which drops a worker back to that ~300MiB baseline. This
# script goes one step further on the GPU host: when an instance's queue stays
# empty for --idle-seconds, it frees once more and then `systemctl stop`s the
# unit, releasing even the context. Zero MiB idle.
#
# Nothing stays stopped while work waits: every poll reads the platform
# database (same host) for QUEUED jobs and starts any stopped managed unit, so
# a submission wakes a card within one poll interval plus unit start time
# (tens of seconds) and model reload on the first job. Stopped workers read as
# OFFLINE in the gateway meanwhile; that and a slow first job are the price of
# zero idle VRAM.
#
# Run this script as a systemd unit/timer, or from cron. Only units matching
# comfyui@* are ever touched; stray manual `python main.py` processes are
# never killed.
#
# Usage:
#   scripts/comfyui-idle-reaper.sh [--idle-seconds 600] [--interval 30]
#     [--env-dir /etc/comfyui] [--db ./data/lab.sqlite] [--no-wake]
#     [--free-only] [--dry-run] [--units 'gpu0,gpu2']
set -euo pipefail

IDLE_SECONDS=600
INTERVAL=30
ENV_DIR="/etc/comfyui"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="$REPO_ROOT/data/lab.sqlite"
NO_WAKE=0
FREE_ONLY=0
DRY_RUN=0
UNITS_FILTER=""
STATE_DIR="/var/tmp/comfyui-idle-reaper"

usage() {
  cat <<'USAGE'
Usage: scripts/comfyui-idle-reaper.sh [options]

  --idle-seconds N   Continuous empty-queue time before stopping a unit (default: 600)
  --interval N       Seconds between polls (default: 30)
  --env-dir PATH     Directory with <instance>.env files holding COMFY_PORT (default: /etc/comfyui)
  --db PATH          Platform SQLite database to watch for queued jobs (default: ./data/lab.sqlite)
  --no-wake          Never start stopped units, only stop idle ones
  --units LIST       Comma-separated instance names to manage (default: all installed comfyui@* units)
  --free-only        POST /free on idle but never stop the unit (keeps ~300MiB baseline, instant wake)
  --dry-run          Print what would happen, change nothing
  -h, --help         This message
USAGE
}

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --idle-seconds) IDLE_SECONDS="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --env-dir) ENV_DIR="$2"; shift 2 ;;
    --db) DB_PATH="$2"; shift 2 ;;
    --no-wake) NO_WAKE=1; shift ;;
    --units) UNITS_FILTER="$2"; shift 2 ;;
    --free-only) FREE_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; echo "error: unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v curl >/dev/null || { echo "error: curl is required" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "error: systemctl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "error: python3 is required" >&2; exit 1; }
if [ "$DRY_RUN" = 1 ]; then
  # Track idle clocks in memory only: same decisions as a live run, no residue.
  STATE_DIR="$(mktemp -d)"
  trap 'rm -rf "$STATE_DIR"' EXIT
else
  mkdir -p "$STATE_DIR"
fi

# Every installed unit this script may manage, running or stopped, so a unit
# stopped earlier (by us or an admin) can still be woken.
mapfile -t MANAGED < <(systemctl list-units --all --type=service --no-legend --no-pager 'comfyui@*' | awk '{print $1}' | sed 's/^comfyui@//; s/\.service$//')
if [ -n "$UNITS_FILTER" ]; then
  wanted=",${UNITS_FILTER// /},"
  filtered=()
  for u in "${MANAGED[@]}"; do
    [[ "$wanted" == *",$u,"* ]] && filtered+=("$u")
  done
  MANAGED=("${filtered[@]}")
fi
[ "${#MANAGED[@]}" -gt 0 ] || { log "no comfyui@ units installed"; exit 0; }

unit_state() {
  systemctl is-active "comfyui@$1" 2>/dev/null || true
}

queue_empty() {
  # Empty only when both running and pending lists are []. Any curl failure
  # (starting unit, transient error) counts as busy: never stop what we cannot see.
  local body
  body="$(curl -fsS -m 10 "http://127.0.0.1:$1/queue" 2>/dev/null)" || return 1
  python3 -c 'import json,sys; q=json.load(sys.stdin); sys.exit(0 if not q.get("queue_running") and not q.get("queue_pending") else 1)' <<<"$body"
}

work_waiting() {
  # Platform jobs the scheduler has admitted but no worker has taken. A
  # read-only WAL query: safe alongside the gateway's writers.
  [ "$NO_WAKE" = 1 ] && return 1
  [ -f "$DB_PATH" ] || return 1
  local n
  n="$(DB_PATH="$DB_PATH" python3 -c '
import os, sqlite3
try:
    con = sqlite3.connect("file:%s?mode=ro" % os.environ["DB_PATH"], uri=True, timeout=5)
    print(con.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('"'"'QUEUED'"'"','"'"'DISPATCHING'"'"')").fetchone()[0])
except Exception:
    print(0)
' 2>/dev/null)" || return 1
  [ "${n:-0}" -gt 0 ]
}

free_unit() {
  local port="$1"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] POST http://127.0.0.1:%s/free {"unload_models":true,"free_memory":true}\n' "$port"
    return 0
  fi
  curl -fsS -m 30 -X POST "http://127.0.0.1:$port/free" -H 'Content-Type: application/json' \
    -d '{"unload_models":true,"free_memory":true}' >/dev/null 2>&1
}

log "managing ${#MANAGED[@]} unit(s): ${MANAGED[*]} (idle threshold ${IDLE_SECONDS}s, poll every ${INTERVAL}s)"
while true; do
  if work_waiting; then
    for inst in "${MANAGED[@]}"; do
      case "$(unit_state "$inst")" in
        active|activating|reloading) continue ;;
      esac
      log "$inst: platform work waiting, starting comfyui@$inst"
      run sudo systemctl start "comfyui@$inst"
      rm -f "$STATE_DIR/$inst"
    done
  fi
  for inst in "${MANAGED[@]}"; do
    case "$(unit_state "$inst")" in
      active) ;;
      # Starting, stopping, or already stopped: never an idle-stop candidate.
      *) rm -f "$STATE_DIR/$inst"; continue ;;
    esac
    port="$(grep -E '^COMFY_PORT=' "$ENV_DIR/$inst.env" 2>/dev/null | cut -d= -f2- || true)"
    if [ -z "$port" ]; then
      log "$inst: no COMFY_PORT in $ENV_DIR/$inst.env, skipping"
      continue
    fi
    state="$STATE_DIR/$inst"
    if queue_empty "$port"; then
      idle_for=0
      if [ -f "$state" ]; then idle_for=$(( $(date +%s) - $(cat "$state") )); fi
      if [ ! -f "$state" ]; then
        date +%s >"$state"
        log "$inst (port $port): queue empty, idle clock started"
      elif [ "$idle_for" -ge "$IDLE_SECONDS" ]; then
        log "$inst (port $port): idle ${idle_for}s, freeing VRAM"
        if free_unit "$port"; then
          if [ "$FREE_ONLY" = 1 ]; then
            log "$inst: freed, staying up (--free-only)"
            date +%s >"$state"
          else
            log "$inst: stopping comfyui@$inst (a queued job will wake it)"
            run sudo systemctl stop "comfyui@$inst"
            rm -f "$state"
          fi
        else
          log "$inst: /free failed, will retry next poll"
        fi
      fi
    else
      # Busy or unreachable: not idle.
      rm -f "$state"
    fi
  done
  sleep "$INTERVAL"
done
