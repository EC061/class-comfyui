#!/usr/bin/env python3
"""Verify the seeded starter workflows against a live worker and the allowlist.

The starters are curated graphs (Flux image, Wan 2.1 1.3B video, MiniMax-H3
video) whose node types and model filenames must exist on the worker and be
allowlisted in COMFY_ALLOWED_NODES. A starter that references a blocked or
absent node fails at submit time with an error a student cannot act on, so run
this on the GPU host after a ComfyUI upgrade or a starter edit, before committing:

    scripts/build-starters.py            # defaults to http://127.0.0.1:8188
    scripts/build-starters.py http://127.0.0.1:8189
"""
import json
import pathlib
import re
import sys
import urllib.request

WORKER = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8188"
REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "apps/gateway/src/starters"
STARTERS = ["image-flux.json", "video-wan-t2v-1.3b.json", "video-minimax-h3.json"]


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
    graphs = {}
    for name in STARTERS:
        g = json.loads((OUT / name).read_text())
        nodes = g.get("nodes", [])
        print(f"{name}: {len(nodes)} nodes")
        if not nodes:
            sys.exit(f"error: {name} is empty; seeding would skip it")
        graphs[name] = g

    try:
        info = json.load(urllib.request.urlopen(f"{WORKER}/object_info", timeout=180))
    except Exception as e:
        print(f"warning: could not reach a worker to verify node types ({e})")
        return

    allow = set()
    compose = REPO / "docker-compose.yml"
    if compose.exists():
        m = re.search(r'COMFY_ALLOWED_NODES: "([^"]*)"', compose.read_text())
        if m:
            allow = set(m.group(1).split(","))
    if not allow:
        example = REPO / "docker-compose.example.yml"
        m = re.search(r'COMFY_ALLOWED_NODES: "([^"]*)"', example.read_text())
        if m:
            allow = set(m.group(1).split(","))
            print("note: no docker-compose.yml; checked against docker-compose.example.yml")

    bad = False
    for name, g in graphs.items():
        for t in sorted(node_types(g)):
            missing = t not in info
            blocked = bool(allow) and t not in allow
            if missing or blocked:
                bad = True
                why = "not on worker" if missing else "not in COMFY_ALLOWED_NODES"
                print(f"  FAIL {name}: {t} ({why})")
    # Model filenames in loader widgets must be ones fetch-models.sh installs.
    manifests = []
    for manifest in (REPO / "deploy/models").glob("*.json"):
        for e in json.loads(manifest.read_text()):
            manifests.append(e["file"])
    for name, g in graphs.items():
        text = json.dumps(g)
        for loader in ("CheckpointLoaderSimple", "UNETLoader", "CLIPLoader", "VAELoader"):
            for n in [x for x in g.get("nodes", []) if x.get("type") == loader]:
                for w in n.get("widgets_values", []) or []:
                    if isinstance(w, str) and w.endswith(".safetensors") and w not in manifests:
                        bad = True
                        print(f"  FAIL {name}: {loader} references {w}, in no deploy/models manifest")
    print("node check: FAILED" if bad else "node check: all node types present and allowlisted")
    sys.exit(1 if bad else 0)


main()
