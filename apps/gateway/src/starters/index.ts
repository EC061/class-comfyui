// Seed each student's workspace with workflows that run on this lab's hardware.
//
// ComfyUI's own template browser is not proxied (see the catch-all in index.ts),
// and unblocking it would show students a gallery that is mostly broken here:
// most stock templates want models we have not downloaded, and the api_*
// templates are built on cloud API nodes the allowlist denies on purpose. So
// instead of exposing that gallery we place a small, curated set into each
// workspace: one image starter and one small-video starter. The MiniMax-H3
// weights stay downloaded and their nodes stay allowlisted, but H3 graphs are
// for students to build by hand rather than a seeded example.
import imageFlux from "./image-flux.json";
import videoWan from "./video-wan-t2v-1.3b.json";
import videoMiniMaxH3 from "./video-minimax-h3.json";
import { getDb, type Session } from "@class-comfyui/database";
import { saveUserData } from "../userdata";
import { getGrants } from "./grants";

// The marker records which starters have already been placed. Bump VERSION to
// push a revised starter to everyone; leave it alone and a student who deletes
// or edits a starter keeps that decision, because the path stays in the marker.
const VERSION = 2;
export const STARTERS_MARKER = "__starters__";

// `template` is the entry the frontend's template browser renders; `name` is
// also the URL it fetches the graph from (/templates/<name>.json). See
// templates.ts, which serves a curated index built from this same list so the
// browser and the seeded workspace copies never drift apart.
//
// A starter with `grant` set is only offered to students whose per-class
// grants include it (see grants.ts): the H3 example goes to students whose
// teacher enabled it on the roster, everyone else builds H3 graphs by hand.
export type Starter = {
  path: string;
  workflow: unknown;
  category: { title: string; type: string; icon: string };
  template: Record<string, unknown>;
  grant?: "h3Video";
};

export const STARTERS: Starter[] = [
  {
    // First entry, searchRank 0: the image starter is the default students see
    // in the template browser and at the top of a fresh workflows/ listing.
    path: "workflows/1 - Image (Flux).json",
    workflow: imageFlux,
    category: { title: "Image", type: "image", icon: "icon-[lucide--image]" },
    template: {
      name: "class_image_flux",
      title: "Image (Flux)",
      description:
        "Text to image on this lab's Flux weights. Edit the prompt and queue it; no downloads or extra nodes needed.",
      mediaType: "image",
      mediaSubtype: "webp",
      tags: ["Image", "Text to Image"],
      models: ["FLUX.1-schnell"],
      thumbnail: [],
      username: "This class",
      openSource: true,
      searchRank: 0,
      usage: 0,
      date: "2026-09-10",
    },
  },
  {
    path: "workflows/2 - Video (Wan 1.3B).json",
    workflow: videoWan,
    category: { title: "Video", type: "video", icon: "icon-[lucide--video]" },
    template: {
      name: "class_video_wan_t2v_1_3b",
      title: "Video (Wan 2.1 1.3B)",
      description:
        "Text to video on a small 1.3B model (~10 GB of weights, a few minutes per 2s clip). Raise the sampler steps for quality. The lab's MiniMax-H3 weights are installed for hand-built graphs, not seeded here.",
      mediaType: "image",
      mediaSubtype: "webp",
      tags: ["Video", "Text to Video"],
      models: ["Wan2.1-T2V-1.3B"],
      thumbnail: [],
      username: "This class",
      openSource: true,
      searchRank: 1,
      usage: 0,
      date: "2026-09-11",
    },
  },
  {
    path: "workflows/2 - Video with audio (MiniMax H3).json",
    workflow: videoMiniMaxH3,
    category: { title: "Video", type: "video", icon: "icon-[lucide--video]" },
    grant: "h3Video",
    template: {
      name: "class_video_minimax_h3",
      title: "Video with audio (MiniMax H3)",
      description:
        "Text to video with synchronized audio, on the lab's own MiniMax-H3 weights with the turbo LoRA enabled (8 steps). Shown only after your teacher enables the H3 example for you.",
      mediaType: "image",
      mediaSubtype: "webp",
      tags: ["Video", "Text to Video", "Audio"],
      models: ["MiniMax-H3"],
      thumbnail: [],
      username: "This class",
      openSource: true,
      searchRank: 2,
      usage: 0,
      date: "2026-09-10",
    },
  },
];

/** Starters one student may receive: the base pair plus any granted examples. */
export function eligibleStarters(session: Session) {
  const grants = getGrants(session.userId, session.classId!);
  return STARTERS.filter((s) => !s.grant || grants[s.grant]);
}

type Marker = { version: number; seeded: string[] };

/**
 * Place any starter this workspace has not been offered yet.
 *
 * Called on workspace entry rather than at enrollment so that students who
 * enrolled before the starters existed pick them up on their next visit, and
 * so a class never needs recreating to distribute a new one.
 */
export function seedStarters(session: Session) {
  try {
    getDb().transaction(() => {
      // A grant enabled after entry takes effect on the next visit, when the
      // newly eligible path is still missing from the marker.
      const eligible = eligibleStarters(session);
      const row = getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [
        session.userId,
        session.classId!,
        STARTERS_MARKER,
      ])[0];
      let marker: Marker = { version: 0, seeded: [] };
      if (row?.content) {
        try {
          const parsed = JSON.parse(row.content) as Partial<Marker>;
          if (Array.isArray(parsed.seeded)) marker = { version: Number(parsed.version) || 0, seeded: parsed.seeded };
        } catch {
          // A corrupt marker should not cost the student their workspace; treat
          // it as "nothing seeded" and let the path check below avoid clobbering.
        }
      }
      if (marker.version >= VERSION && eligible.every((s) => marker.seeded.includes(s.path))) return;

      const placed: string[] = [];
      const existing = new Set(
        getDb()
          .list("user_data", "user_id=? AND class_id=?", [session.userId, session.classId!])
          .map((v) => v.path)
      );
      for (const starter of eligible) {
        const nodes = (starter.workflow as { nodes?: unknown[] })?.nodes;
        // A placeholder that scripts/build-starters.py has not filled in yet.
        if (!Array.isArray(nodes) || nodes.length === 0) {
          console.warn(`starters: ${starter.path} is empty, skipping`);
          continue;
        }
        if (marker.seeded.includes(starter.path) || existing.has(starter.path)) continue;
        saveUserData(session, starter.path, JSON.stringify(starter.workflow));
        marker.seeded.push(starter.path);
        placed.push(starter.path);
      }
      marker.version = VERSION;
      saveUserData(session, STARTERS_MARKER, JSON.stringify(marker));
      // Logged so a deployment running a gateway build without starters, or one
      // whose seeding silently no-ops, is visible without querying the database.
      if (placed.length) console.log(`starters: placed ${placed.join(", ")} for ${session.userId}`);
    });
  } catch (error) {
    // Seeding is a convenience. Never let it block entry to the workspace.
    console.warn("starters: seeding failed", error);
  }
}
