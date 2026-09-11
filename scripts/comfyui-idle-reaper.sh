#!/usr/bin/env bash
# Stop idle ComfyUI workers so their VRAM returns to zero.
#
# Background: a running ComfyUI process always holds ~300MiB of CUDA context,
# and after a job it keeps the full model weights until something unloads
# them. The gateway already POSTs /free the moment each platform job reaches a
# terminal state, which drops a worker back to that ~300MiB baseline. This
# script goes one step further on the GPU host: when an instance's queue stays
# empty for --idle-seconds, it frees once more and then `systemctl stop`s the
# unit, releasing even the context. Zero MiB idle.
#
# Stopped workers are safe: the gateway marks them OFFLINE and platform jobs
# simply stay QUEUED until the unit is started again:
#   sudo systemctl start 'comfyui@gpu*'
# Run this script as a systemd unit/timer, or from cron. Only units matching
# comfyui@* are ever touched; stray manual `python main.py` processes are
# reported, never killed.
#
# Usage:
#   scripts/comfyui-idle-reaper.sh [--idle-seconds 600] [--interval 30]
#     [--env-dir /etc/comfyui] [--free-only] [--dry-run] [--units 'gpu0,gpu2']
set -euo pipefail

IDLE_SECONDS=600
INTERVAL=30
ENV_DIR="/etc/comfyui"
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
  --units LIST       Comma-separated instance names to manage (default: all running comfyui@* units)
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
    --units) UNITS_FILTER="$2"; shift 2 ;;
    --free-only) FREE_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; echo "error: unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v curl >/dev/null || { echo "error: curl is required" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "error: systemctl is required" >&2; exit 1; }
[ "$DRY_RUN" = 1 ] || mkdir -p "$STATE_DIR"

# Running units this script may manage.
mapfile -t MANAGED < <(systemctl list-units --type=service --state=running 'comfyui@*' --no-legend --no-pager | awk '{print $1}' | sed 's/^comfyui@//; s/\.service$//')
if [ -n "$UNITS_FILTER" ]; then
  wanted=",${UNITS_FILTER// /},"
  filtered=()
  for u in "${MANAGED[@]}"; do
    [[ "$wanted" == *",$u,"* ]] && filtered+=("$u")
  done
  MANAGED=("${filtered[@]}")
fi
[ "${#MANAGED[@]}" -gt 0 ] || { log "no running comfyui@ units to watch"; exit 0; }

queue_empty() {
  # Empty only when both running and pending lists are []. Any curl failure
  # (starting unit, transient error) counts as busy: never stop what we cannot see.
  local body
  body="$(curl -fsS -m 10 "http://127.0.0.1:$1/queue" 2>/dev/null)" || return 1
  python3 -c 'import json,sys; q=json.load(sys.stdin); sys.exit(0 if not q.get("queue_running") and not q.get("queue_pending") else 1)' <<<"$body"
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

log "watching ${#MANAGED[@]} unit(s): ${MANAGED[*]} (idle threshold ${IDLE_SECONDS}s, poll every ${INTERVAL}s)"
while true; do
  for inst in "${MANAGED[@]}"; do
    # The unit may have been stopped since discovery (by us or an admin); drop it quietly.
    if ! systemctl is-active -q "comfyui@$inst"; then continue; fi
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
        [ "$DRY_RUN" = 1 ] || date +%s >"$state"
        log "$inst (port $port): queue empty, idle clock started"
      elif [ "$idle_for" -ge "$IDLE_SECONDS" ]; then
        log "$inst (port $port): idle ${idle_for}s, freeing VRAM"
        if free_unit "$port"; then
          if [ "$FREE_ONLY" = 1 ]; then
            log "$inst: freed, staying up (--free-only)"
            [ "$DRY_RUN" = 1 ] || date +%s >"$state"
          else
            log "$inst: stopping comfyui@$inst (jobs will queue until it is started again)"
            run sudo systemctl stop "comfyui@$inst"
            rm -f "$state"
            # Refresh the watch list: a stopped unit leaves the set.
            mapfile -t MANAGED < <(systemctl list-units --type=service --state=running 'comfyui@*' --no-legend --no-pager | awk '{print $1}' | sed 's/^comfyui@//; s/\.service$//')
          fi
        else
          log "$inst: /free failed, will retry next poll"
        fi
      fi
    else
      # Busy or unreachable: not idle. Unreachable also clears nothing else.
      [ -f "$state" ] && rm -f "$state"
    fi
  done
  sleep "$INTERVAL"
done
