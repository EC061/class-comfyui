#!/usr/bin/env python3
"""Derive the MiniMax-H3 starter workflow from the template ComfyUI ships.

Hand-authoring an H3 graph is not worth the risk: it is a subgraph-based
workflow whose serialization format tracks the frontend, and a stale hand-copy
breaks silently in the student's editor. Instead we take the template that is
installed next to the running ComfyUI and repoint it at the weights this lab
actually downloaded.

Run on the GPU host, then commit the result:

    scripts/build-starters.py && git diff --stat
"""
import glob, json, pathlib, sys, urllib.request

COMFY_DIR = sys.argv[1] if len(sys.argv) > 1 else "/opt/comfyui"
REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "apps/gateway/src/starters"

# The lab downloaded int8 rather than the nvfp4 build the template defaults to:
# NVFP4 is Blackwell-native and these are Ampere A6000s.
REWRITE = {"qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"}

PROMPT = (
    "A paper boat drifts down a rain-filled gutter at night, city lights "
    "reflected and rippling on the water, camera low and level with the surface, "
    "following alongside.\n\n"
    "Audio: steady rain, water running over stone, distant traffic."
)


def find_template(name):
    hits = glob.glob(f"{COMFY_DIR}/.venv/lib/python*/site-packages/comfyui_workflow_templates*/templates/{name}")
    if not hits:
        sys.exit(f"error: template {name} not found under {COMFY_DIR}; is ComfyUI installed there?")
    return hits[0]


def rewrite_strings(obj):
    """Repoint every model filename in the graph, at any nesting depth."""
    if isinstance(obj, dict):
        return {k: rewrite_strings(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [rewrite_strings(v) for v in obj]
    return REWRITE.get(obj, obj) if isinstance(obj, str) else obj


def build_video():
    g = rewrite_strings(json.load(open(find_template("video_minimax_h3_t2v.json"))))

    # The subgraph instance carries the whole configuration as flat widgets, in
    # the order of the subgraph's declared inputs. Identify it by the base model
    # filename rather than by its UUID type, which changes between releases.
    hosts = [n for n in g.get("nodes", [])
             if isinstance(n.get("widgets_values"), list)
             and "minimax_h3_fl2va_pruned_int8_convrot.safetensors" in n["widgets_values"]]
    if len(hosts) != 1:
        sys.exit(f"error: expected 1 subgraph instance, found {len(hosts)}; template layout changed")
    w = hosts[0]["widgets_values"]
    if len(w) != 13:
        sys.exit(f"error: expected 13 widgets on the subgraph instance, found {len(w)}; template layout changed")

    # [prompt, width, height, seconds, seed, unet, clip, video_vae, audio_vae,
    #  turbo, lora, lora_strength, turbo_steps]
    w[0] = PROMPT
    w[1], w[2] = 864, 480   # 0.4 MP 16:9, matching the ResolutionSelector default
    w[3] = 2                # seconds -> 56 frames, on the model's 17k+5 grid
    w[9] = True             # turbo on: 8 steps instead of ~20
    w[12] = 8

    # Drop the template's own note cards. They document nvfp4 weights, cloud
    # nodes and a download layout that do not apply to this lab, and a student's
    # first workflow should not open with a wall of contradicted instructions.
    keep = [n for n in g["nodes"] if n.get("type") != "MarkdownNote"]
    removed = len(g["nodes"]) - len(keep)
    g["nodes"] = keep
    return g, removed


def node_types(g):
    """Every node type in the graph, including inside subgraph definitions."""
    out = set()
    for n in g.get("nodes", []):
        out.add(n.get("type"))
    for sg in g.get("definitions", {}).get("subgraphs", []):
        out.update(n.get("type") for n in sg.get("nodes", []))
        out.discard(None)
    # Subgraph instances are typed by UUID; those are not real node classes.
    return {t for t in out if t and "-" not in t}


def main():
    video, removed = build_video()
    (OUT / "video-minimax-h3.json").write_text(json.dumps(video, indent=2) + "\n")
    print(f"video-minimax-h3.json: {len(video['nodes'])} nodes ({removed} notes dropped)")

    image = json.loads((OUT / "image-flux.json").read_text())
    print(f"image-flux.json: {len(image['nodes'])} nodes (hand-authored, unchanged)")

    # A starter that references a node the gateway blocks, or that the worker
    # does not have, is worse than no starter: it fails at submit time with an
    # error the student cannot act on. Check both before committing.
    try:
        info = json.load(urllib.request.urlopen("http://127.0.0.1:8188/object_info", timeout=180))
    except Exception as e:
        print(f"warning: could not reach a worker to verify node types ({e})")
        return
    allow = set()
    compose = REPO / "docker-compose.yml"
    if compose.exists():
        import re
        m = re.search(r'COMFY_ALLOWED_NODES: "([^"]*)"', compose.read_text())
        if m:
            allow = set(m.group(1).split(","))
    bad = False
    for label, g in (("video", video), ("image", image)):
        for t in sorted(node_types(g)):
            missing = t not in info
            blocked = bool(allow) and t not in allow
            if missing or blocked:
                bad = True
                why = "not on worker" if missing else "not in COMFY_ALLOWED_NODES"
                print(f"  FAIL {label}: {t} ({why})")
    print("node check: FAILED" if bad else "node check: all node types present and allowlisted")


main()
