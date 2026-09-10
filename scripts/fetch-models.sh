#!/usr/bin/env bash
# Download model weights into a ComfyUI installation from a JSON manifest.
#
# Models are deliberately NOT downloaded by setup-comfyui.sh: they are large,
# license-encumbered, and choosing them is a curriculum decision. This script only
# fetches what a manifest names, so what students can load stays reviewable in git.
#
# Idempotent and resumable: an existing file of the expected size is skipped, a
# partial download continues, and a manifest sha256 is verified when present.
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/opt/comfyui}"
CHECK_ONLY=0
FORCE=0
MANIFESTS=()
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: scripts/fetch-models.sh [options] <manifest.json ...>

  --dir PATH    ComfyUI installation root (default: /opt/comfyui)
  --check       HEAD every URL and report reachability/size, download nothing
  --force       Re-download even when a correctly sized file already exists
  -h, --help    This message

Manifests live in deploy/models/. Bare names resolve there, so `minimax-h3` and
`deploy/models/minimax-h3.json` are equivalent.

A Hugging Face token raises rate limits and is required for gated repos. Put it in
the git-ignored .env at the repository root, or pass it in the environment:
  HF_TOKEN=hf_...
Installing aria2c enables multi-connection downloads, several times faster than curl.

Each entry is {url, dest, file, bytes?, sha256?}. `dest` is relative to
<comfy-dir>/models/. Downloads print the computed sha256 so it can be pinned back
into the manifest.
USAGE
}

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) COMFY_DIR="$2"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *) MANIFESTS+=("$1"); shift ;;
  esac
done

[ "${#MANIFESTS[@]}" -gt 0 ] || { usage >&2; die "no manifest given"; }
[ -d "$COMFY_DIR" ] || die "$COMFY_DIR does not exist (pass --dir)"
command -v curl >/dev/null || die "curl is required"

# A token is optional for public repos but raises Hugging Face rate limits and is
# required for gated ones. .env is git-ignored, so it is a safe place to keep it.
if [ -z "${HF_TOKEN:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  HF_TOKEN="$(grep -E '^(HF_TOKEN|HUGGING_FACE_HUB_TOKEN)=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\047' || true)"
fi
AUTH=()
if [ -n "${HF_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer $HF_TOKEN")
  log "Using Hugging Face token (${#HF_TOKEN} chars)"
fi

# Resolve bare manifest names against deploy/models/.
resolved=()
for m in "${MANIFESTS[@]}"; do
  if [ -f "$m" ]; then
    resolved+=("$m")
  elif [ -f "$REPO_ROOT/deploy/models/$m.json" ]; then
    resolved+=("$REPO_ROOT/deploy/models/$m.json")
  else
    die "manifest not found: $m"
  fi
done

# Flatten every manifest to tab-separated rows so the download loop stays shell.
rows="$(
  python3 - "${resolved[@]}" <<'PY'
import json, sys
for path in sys.argv[1:]:
    entries = json.load(open(path))
    if not isinstance(entries, list):
        raise SystemExit(f"{path}: manifest must be a JSON array")
    for i, e in enumerate(entries):
        for key in ("url", "dest", "file"):
            if not isinstance(e.get(key), str) or not e[key]:
                raise SystemExit(f"{path}[{i}]: '{key}' is required")
        if "/" in e["file"] or e["file"] in (".", ".."):
            raise SystemExit(f"{path}[{i}]: 'file' must be a bare filename")
        if e["dest"].startswith("/") or ".." in e["dest"].split("/"):
            raise SystemExit(f"{path}[{i}]: 'dest' must be a relative path under models/")
        print("\t".join([e["url"], e["dest"], e["file"], str(e.get("bytes") or 0), e.get("sha256") or ""]))
PY
)"
[ -n "$rows" ] || die "manifests contained no entries"

total=0
while IFS=$'\t' read -r url dest file bytes sha; do
  total=$((total + bytes))
done <<<"$rows"
[ "$total" -gt 0 ] && log "Manifest total: $((total / 1000000000)) GB across $(wc -l <<<"$rows") file(s)"

avail="$(df -PB1 "$COMFY_DIR" | awk 'NR==2{print $4}')"
if [ "$total" -gt 0 ] && [ "$avail" -lt "$total" ]; then
  die "only $((avail / 1000000000)) GB free at $COMFY_DIR, need $((total / 1000000000)) GB"
fi

# --- check mode -------------------------------------------------------------
if [ "$CHECK_ONLY" = 1 ]; then
  failed=0
  while IFS=$'\t' read -r url dest file bytes sha; do
    code="$(curl -sIL "${AUTH[@]}" -o /dev/null -w '%{http_code}' "$url" || echo 000)"
    if [ "$code" = "200" ]; then
      printf '  \033[32mok\033[0m       %-56s %s GB -> models/%s/\n' "$file" "$((bytes / 1000000000))" "$dest"
    else
      printf '  \033[31mHTTP %s\033[0m %-56s %s\n' "$code" "$file" "$url"
      case "$code" in
        401 | 403) printf '           gated: accept the license on Hugging Face, then set HF_TOKEN in .env\n' ;;
      esac
      failed=1
    fi
  done <<<"$rows"
  [ "$failed" = 0 ] || die "one or more URLs are unreachable; nothing was downloaded"
  log "All URLs reachable."
  exit 0
fi

# --- download ---------------------------------------------------------------
while IFS=$'\t' read -r url dest file bytes sha; do
  dir="$COMFY_DIR/models/$dest"
  target="$dir/$file"
  mkdir -p "$dir"

  if [ -f "$target" ] && [ "$FORCE" = 0 ]; then
    have="$(stat -c %s "$target")"
    if [ "$bytes" -gt 0 ] && [ "$have" != "$bytes" ]; then
      warn "$file exists but is $have bytes, expected $bytes; re-downloading"
    else
      log "$file already present, skipping"
      continue
    fi
  fi

  log "Downloading $file ($((bytes / 1000000000)) GB) -> models/$dest/"
  # aria2c splits the transfer across connections, which is several times faster
  # than curl on a fat campus link. Both resume a partial file.
  if command -v aria2c >/dev/null; then
    aria2c -x 8 -s 8 -k 16M --continue=true --auto-file-renaming=false \
      --summary-interval=15 --console-log-level=warn \
      ${HF_TOKEN:+--header="Authorization: Bearer $HF_TOKEN"} \
      -d "$dir" -o "$file" "$url" || {
      warn "download failed for $file (partial file kept for resume)"
      exit 1
    }
  else
    curl -fL "${AUTH[@]}" --retry 5 --retry-delay 5 -C - -o "$target" "$url" || {
      warn "download failed for $file (partial file kept for resume)"
      exit 1
    }
  fi

  actual="$(sha256sum "$target" | cut -d' ' -f1)"
  if [ -n "$sha" ]; then
    [ "$sha" = "$actual" ] || die "$file sha256 mismatch: expected $sha, got $actual"
    log "$file verified"
  else
    warn "$file has no sha256 in the manifest; integrity NOT verified"
    printf '        computed: %s\n' "$actual"
  fi
done <<<"$rows"

log "Done. Models are shared by every instance; no restart is needed."
