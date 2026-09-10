#!/usr/bin/env bash
# Provision one ComfyUI instance per detected NVIDIA GPU, managed by systemd.
#
# This installs software OUTSIDE the Compose stack, on the GPU host. ComfyUI runs
# arbitrary Python and cannot be sandboxed by the gateway, so it is deliberately
# not part of the application image; see README "GPU workers".
#
# Idempotent: re-running updates the checkout, refreshes units and leaves existing
# instances in place. It never downloads models and never opens firewall ports.
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-$HOME/ComfyUI}"
BASE_PORT="${BASE_PORT:-8188}"
GPUS=""
ADVERTISE_HOST=""
CUDA_TAG=""
BIND_ADDR="0.0.0.0"
MANIFEST=""
USE_SYSTEMD=1
DRY_RUN=0
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: scripts/setup-comfyui.sh [options]

  --dir PATH         ComfyUI checkout (default: $HOME/ComfyUI)
  --base-port N      Port for the first GPU, incrementing per GPU (default: 8188)
  --gpus LIST        Comma-separated GPU indices (default: every detected GPU)
  --host ADDR        Address the gateway will reach workers on (default: autodetected)
  --bind ADDR        Address ComfyUI listens on (default: 0.0.0.0)
  --cuda TAG         PyTorch wheel tag, e.g. cu128 (default: chosen from driver version)
  --manifest PATH    Where to write the worker manifest (default: deploy/comfyui/workers.json)
  --no-systemd       Install and configure only; do not create or start services
  --dry-run          Print what would happen, change nothing
  -h, --help         This message

Registers nothing by itself. Run `pnpm db:workers` (or the documented
`docker compose run` form) afterwards to load the manifest into the database.
USAGE
}

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) COMFY_DIR="$2"; shift 2 ;;
    --base-port) BASE_PORT="$2"; shift 2 ;;
    --gpus) GPUS="$2"; shift 2 ;;
    --host) ADVERTISE_HOST="$2"; shift 2 ;;
    --bind) BIND_ADDR="$2"; shift 2 ;;
    --cuda) CUDA_TAG="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --no-systemd) USE_SYSTEMD=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

MANIFEST="${MANIFEST:-$REPO_ROOT/deploy/comfyui/workers.json}"

# --- detect GPUs ------------------------------------------------------------
command -v nvidia-smi >/dev/null || die "nvidia-smi not found. Install the NVIDIA driver first."
mapfile -t GPU_ROWS < <(nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits)
[ "${#GPU_ROWS[@]}" -gt 0 ] || die "no GPUs reported by nvidia-smi"

if [ -n "$GPUS" ]; then
  wanted=",${GPUS// /},"
  filtered=()
  for row in "${GPU_ROWS[@]}"; do
    idx="${row%%,*}"
    [[ "$wanted" == *",${idx// /},"* ]] && filtered+=("$row")
  done
  [ "${#filtered[@]}" -gt 0 ] || die "none of the requested GPU indices exist: $GPUS"
  GPU_ROWS=("${filtered[@]}")
fi

DRIVER="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | tr -d ' ')"
log "Driver $DRIVER, provisioning ${#GPU_ROWS[@]} GPU(s):"
for row in "${GPU_ROWS[@]}"; do printf '    %s\n' "$row"; done

# Map a marketing name onto the architecture field the scheduler reports.
architecture_of() {
  case "$1" in
    *H200* | *H100*) echo "Hopper" ;;
    *B200* | *5090* | *5080*) echo "Blackwell" ;;
    *L40* | *L4* | *4090* | *4080* | *Ada*) echo "Ada Lovelace" ;;
    *A100* | *A6000* | *A5000* | *A4000* | *3090* | *3080*) echo "Ampere" ;;
    *V100*) echo "Volta" ;;
    *T4* | *2080* | *TITAN\ RTX*) echo "Turing" ;;
    *) echo "" ;;
  esac
}

# Driver floors for each CUDA runtime, newest first. Minor-version compatibility
# means a newer driver runs older wheels, so the first match is the best match.
if [ -z "$CUDA_TAG" ]; then
  major="${DRIVER%%.*}"
  if [ "$major" -ge 570 ]; then CUDA_TAG="cu128"
  elif [ "$major" -ge 550 ]; then CUDA_TAG="cu126"
  elif [ "$major" -ge 525 ]; then CUDA_TAG="cu124"
  else CUDA_TAG="cu121"; fi
  log "Selected PyTorch wheels: $CUDA_TAG (driver $DRIVER)"
fi

# --- advertise address ------------------------------------------------------
if [ -z "$ADVERTISE_HOST" ]; then
  # Skip Docker bridges: the gateway container must reach the host, not itself.
  for addr in $(hostname -I 2>/dev/null || true); do
    case "$addr" in
      172.1[6-9].* | 172.2[0-9].0.1 | 172.3[0-1].* | 127.*) continue ;;
    esac
    ADVERTISE_HOST="$addr"
    break
  done
  [ -n "$ADVERTISE_HOST" ] || die "could not autodetect an address; pass --host"
  log "Workers will be advertised at $ADVERTISE_HOST"
fi
case "$ADVERTISE_HOST" in
  127.* | localhost)
    die "--host $ADVERTISE_HOST is unreachable from the gateway container. Use a host address."
    ;;
esac

# --- uv ---------------------------------------------------------------------
if ! command -v uv >/dev/null; then
  log "Installing uv"
  run sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v uv >/dev/null || [ "$DRY_RUN" = 1 ] || die "uv still not on PATH; open a new shell and re-run"

# --- ComfyUI checkout -------------------------------------------------------
if [ -d "$COMFY_DIR/.git" ]; then
  log "Updating existing checkout at $COMFY_DIR"
  run git -C "$COMFY_DIR" pull --ff-only
else
  log "Cloning ComfyUI into $COMFY_DIR"
  run git clone https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR"
fi

# Models and a torch venv on NFS/SMB are slow to load and make systemd mount
# namespacing unreliable. Warn loudly rather than silently producing a slow rig.
probe="$COMFY_DIR"
while [ ! -e "$probe" ] && [ "$probe" != "/" ]; do probe="$(dirname "$probe")"; done
FSTYPE="$(stat -f -c %T "$probe" 2>/dev/null || echo unknown)"
case "$FSTYPE" in
  nfs* | smb* | cifs* | fuse.sshfs | 9p)
    warn "$COMFY_DIR is on a $FSTYPE filesystem."
    warn "Model loading will be slow and systemd sandboxing may fail. Prefer local disk:"
    warn "  scripts/setup-comfyui.sh --dir /opt/comfyui"
    ;;
esac

log "Creating virtualenv and installing PyTorch ($CUDA_TAG)"
run uv venv --python 3.12 "$COMFY_DIR/.venv"
PY="$COMFY_DIR/.venv/bin/python"
# Torch first from the CUDA index, so the generic requirements pin cannot pull a
# CPU-only build over the top of it.
run uv pip install --python "$PY" torch torchvision torchaudio \
  --index-url "https://download.pytorch.org/whl/$CUDA_TAG"
run uv pip install --python "$PY" -r "$COMFY_DIR/requirements.txt"

# --- per-GPU instances ------------------------------------------------------
UNIT=/etc/systemd/system/comfyui@.service
ENV_DIR=/etc/comfyui
SERVICE_USER="$(id -un)"

# ProtectHome=read-only would make a checkout under /home unwritable, and it is a
# no-op for the sandbox when the checkout is the thing being protected from.
case "$COMFY_DIR" in
  /home/* | /root/*) PROTECT_HOME="# ProtectHome omitted: checkout lives under $COMFY_DIR" ;;
  *) PROTECT_HOME="ProtectHome=read-only" ;;
esac

if [ "$USE_SYSTEMD" = 1 ]; then
  log "Installing systemd template unit $UNIT"
  unit_body=$(
    cat <<UNITEOF
[Unit]
Description=ComfyUI worker %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$COMFY_DIR
EnvironmentFile=$ENV_DIR/%i.env
ExecStart=$PY main.py --listen \${COMFY_BIND} --port \${COMFY_PORT} \\
  --output-directory \${COMFY_OUTPUT} --temp-directory \${COMFY_TEMP}
Restart=on-failure
RestartSec=5
# ComfyUI executes arbitrary Python from custom nodes. These limits reduce blast
# radius; they are not a sandbox.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
$PROTECT_HOME
ReadWritePaths=$COMFY_DIR

[Install]
WantedBy=multi-user.target
UNITEOF
  )
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] would write %s\n' "$UNIT"
  else
    printf '%s\n' "$unit_body" | sudo tee "$UNIT" >/dev/null
    sudo mkdir -p "$ENV_DIR"
  fi
fi

workers_json="[]"
port="$BASE_PORT"
for row in "${GPU_ROWS[@]}"; do
  IFS=',' read -r idx name vram <<<"$row"
  idx="$(echo "$idx" | xargs)"
  name="$(echo "$name" | xargs)"
  vram="$(echo "$vram" | xargs)"
  arch="$(architecture_of "$name")"
  inst="gpu$idx"
  out="$COMFY_DIR/instances/$inst/output"
  tmp="$COMFY_DIR/instances/$inst/temp"

  log "GPU $idx ($name, ${vram}MiB) -> port $port"
  run mkdir -p "$out" "$tmp"

  if [ "$USE_SYSTEMD" = 1 ]; then
    env_body="CUDA_VISIBLE_DEVICES=$idx
COMFY_PORT=$port
COMFY_BIND=$BIND_ADDR
COMFY_OUTPUT=$out
COMFY_TEMP=$tmp"
    if [ "$DRY_RUN" = 1 ]; then
      printf '  [dry-run] would write %s/%s.env and start comfyui@%s\n' "$ENV_DIR" "$inst" "$inst"
    else
      printf '%s\n' "$env_body" | sudo tee "$ENV_DIR/$inst.env" >/dev/null
    fi
  fi

  workers_json="$(
    COMFY_ROW_JSON="$workers_json" \
      W_NAME="$(hostname -s) $name #$idx" \
      W_URL="http://$ADVERTISE_HOST:$port" \
      W_GPU="$name" W_VRAM="$vram" W_ARCH="$arch" \
      python3 - <<'PY'
import json, os
rows = json.loads(os.environ["COMFY_ROW_JSON"])
rows.append({
    "name": os.environ["W_NAME"],
    "baseUrl": os.environ["W_URL"],
    "gpuName": os.environ["W_GPU"],
    "vramMb": int(os.environ["W_VRAM"]),
    "architecture": os.environ["W_ARCH"],
    "maxConcurrentJobs": 1,
    "enabled": True,
    "tags": [],
})
print(json.dumps(rows))
PY
  )"
  port=$((port + 1))
done

if [ "$USE_SYSTEMD" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  sudo systemctl daemon-reload
  for row in "${GPU_ROWS[@]}"; do
    inst="gpu$(echo "${row%%,*}" | xargs)"
    log "Starting comfyui@$inst"
    sudo systemctl enable --now "comfyui@$inst"
  done
fi

# --- manifest ---------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  log "Manifest that would be written to $MANIFEST:"
  printf '%s\n' "$workers_json"
  exit 0
fi
mkdir -p "$(dirname "$MANIFEST")"
printf '%s\n' "$workers_json" | python3 -m json.tool >"$MANIFEST"
log "Wrote $MANIFEST"

# --- wait for health --------------------------------------------------------
if [ "$USE_SYSTEMD" = 1 ]; then
  log "Waiting for instances to answer /system_stats (first start compiles kernels; up to 120s)"
  port="$BASE_PORT"
  failed=0
  for _row in "${GPU_ROWS[@]}"; do
    for _ in $(seq 1 60); do
      if curl -fsS -m 2 "http://127.0.0.1:$port/system_stats" >/dev/null 2>&1; then
        log "  port $port ready"
        break
      fi
      sleep 2
    done
    curl -fsS -m 2 "http://127.0.0.1:$port/system_stats" >/dev/null 2>&1 || {
      warn "port $port did not come up; check: journalctl -u comfyui@gpu* -n 50"
      failed=1
    }
    port=$((port + 1))
  done
fi

cat <<NEXT

$(log "Next steps")
  1. Register the workers in the database:
       docker compose run --rm -v "$MANIFEST":/tmp/workers.json:ro migrate workers /tmp/workers.json
  2. Install at least one checkpoint under $COMFY_DIR/models/checkpoints/
     (nothing is downloaded for you: models are large and license-encumbered).
  3. Restrict the worker ports. ComfyUI has no authentication and reads/writes
     the filesystem, so only the gateway host should reach $BASE_PORT+:
       sudo iptables -I INPUT -p tcp --dport $BASE_PORT:$((port - 1)) ! -s <gateway-host> -j DROP
NEXT
[ "${failed:-0}" = 0 ]
