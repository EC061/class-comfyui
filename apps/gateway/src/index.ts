import express from "express";
import multer from "multer";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { getEnv, validateStartup, isAllowedBrowserOrigin } from "@class-comfyui/config";
import {
  getDb,
  activeMembership,
  audit,
  fairQueuedJobs,
  activeJobCountsBySession,
  type Job,
  type Session,
  type Worker,
} from "@class-comfyui/database";
import { verifyWorkspaceToken, hashSessionToken, newSessionToken } from "@class-comfyui/auth";
import { Scheduler } from "./scheduler";
import { workerFetch, ownInputImages } from "./storage";
import { installUserData, saveUserData } from "./userdata";
import { seedStarters } from "./starters";
import { installTemplates } from "./templates";
import { installJobs } from "./jobs";
const cookieName = "comfy_gateway";
function cookie(header: string | undefined) {
  return header
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
}
function session(req: IncomingMessage): Session | undefined {
  const raw = cookie(req.headers.cookie);
  if (!raw) return;
  const db = getDb(),
    s = db.get("gateway_sessions", hashSessionToken(raw, getEnv().AUTH_SECRET));
  if (
    !s ||
    s.expiresAt <= Date.now() ||
    !s.classId ||
    !s.enrollmentId ||
    !activeMembership(db, s.userId, s.classId, s.enrollmentId)
  )
    return;
  return s;
}
function sameOrigin(req: IncomingMessage) {
  return isAllowedBrowserOrigin({
    publicUrl: getEnv().COMFY_PUBLIC_URL,
    originHeader: req.headers.origin,
    hostHeader: req.headers.host,
    fetchSite: req.headers["sec-fetch-site"] as string | undefined,
    referer: req.headers.referer,
  });
}
type LiveProgress = {
  nodeId: string | null;
  nodeTitle: string | null;
  step: number | null;
  maxSteps: number | null;
  updatedAt: number;
};
const liveJobProgress = new Map<string, LiveProgress>();
function resolveNodeTitle(job: Job, nodeId: string | null): string | null {
  if (!nodeId) return null;
  const node = (job.promptJson as Record<string, any> | undefined)?.[nodeId];
  if (!node || typeof node !== "object") return `Node #${nodeId}`;
  const metaTitle = typeof node._meta?.title === "string" ? node._meta.title.trim() : "";
  return metaTitle || (typeof node.class_type === "string" ? node.class_type : `Node #${nodeId}`);
}
function recordLiveProgress(job: Job, event: Record<string, any>) {
  const now = Date.now();
  if (liveJobProgress.size > 256) {
    for (const [k, v] of liveJobProgress) if (now - v.updatedAt > 3600_000) liveJobProgress.delete(k);
  }
  if (event.type === "execution_start") {
    liveJobProgress.set(job.id, {
      nodeId: null,
      nodeTitle: "Starting on GPU",
      step: null,
      maxSteps: null,
      updatedAt: now,
    });
    return;
  }
  if (event.type === "executing") {
    if (event.data?.node === null || event.data?.node === undefined) {
      liveJobProgress.delete(job.id);
      return;
    }
    const nodeId = String(event.data.node);
    liveJobProgress.set(job.id, {
      nodeId,
      nodeTitle: resolveNodeTitle(job, nodeId),
      step: null,
      maxSteps: null,
      updatedAt: now,
    });
    return;
  }
  if (event.type === "progress") {
    const prev = liveJobProgress.get(job.id);
    const nodeId =
      event.data?.node !== undefined && event.data?.node !== null ? String(event.data.node) : (prev?.nodeId ?? null);
    liveJobProgress.set(job.id, {
      nodeId,
      nodeTitle: nodeId ? resolveNodeTitle(job, nodeId) : (prev?.nodeTitle ?? "Sampling"),
      step: typeof event.data?.value === "number" ? Math.round(event.data.value) : (prev?.step ?? null),
      maxSteps: typeof event.data?.max === "number" ? Math.round(event.data.max) : (prev?.maxSteps ?? null),
      updatedAt: now,
    });
    return;
  }
  if (event.type === "progress_state" && event.data?.nodes && typeof event.data.nodes === "object") {
    const runningEntry = Object.entries(event.data.nodes as Record<string, any>).find(
      ([, v]) => v && typeof v === "object" && v.state === "running"
    );
    if (runningEntry) {
      const [nid, v] = runningEntry;
      liveJobProgress.set(job.id, {
        nodeId: nid,
        nodeTitle: resolveNodeTitle(job, nid),
        step: typeof v.value === "number" ? Math.round(v.value) : null,
        maxSteps: typeof v.max === "number" ? Math.round(v.max) : null,
        updatedAt: now,
      });
    }
    return;
  }
  if (["execution_success", "execution_error", "execution_interrupted"].includes(event.type)) {
    liveJobProgress.delete(job.id);
  }
}
const clients = new Map<WebSocket, Session>();
function notify(job: Job, event: Record<string, any>) {
  recordLiveProgress(job, event);
  for (const [client, s] of clients) {
    if (s.userId !== job.userId || s.classId !== job.classId) continue;
    if (client.readyState === WebSocket.OPEN && activeMembership(getDb(), s.userId, s.classId!, s.enrollmentId))
      client.send(JSON.stringify(event));
  }
}
const coreNodes = [
  "CheckpointLoaderSimple",
  "CLIPTextEncode",
  "CLIPSetLastLayer",
  "EmptyLatentImage",
  "KSampler",
  "KSamplerAdvanced",
  "VAEDecode",
  "VAEEncode",
  "VAELoader",
  "SaveImage",
  "PreviewImage",
  "LoadImage",
  "ImageScale",
  "ImageScaleBy",
  "ImageInvert",
  "ImageBatch",
  "ImagePadForOutpaint",
  "LatentUpscale",
  "LatentUpscaleBy",
  "LatentComposite",
  "LatentBlend",
  "RepeatLatentBatch",
  "LoraLoader",
  "LoraLoaderModelOnly",
  "ConditioningCombine",
  "ConditioningConcat",
  "ConditioningAverage",
  "ConditioningSetArea",
  "ConditioningSetMask",
  "ControlNetLoader",
  "ControlNetApply",
  "ControlNetApplyAdvanced",
  "CLIPVisionLoader",
  "CLIPVisionEncode",
  "UNETLoader",
  "DualCLIPLoader",
  "CLIPLoader",
  "FluxGuidance",
  "ModelSamplingFlux",
  // Model-sampling patches are pure timestep math on the loaded model: no
  // files, no network. The frontend's own default workflow (Z-Image-Turbo)
  // wires ModelSamplingAuraFlow, which rendered as a red "missing node" until
  // the family was listed — even though every worker supports it natively.
  "ModelSamplingDiscrete",
  "ModelSamplingContinuousEDM",
  "ModelSamplingContinuousV",
  "ModelSamplingStableCascade",
  "ModelSamplingSD3",
  "ModelSamplingAuraFlow",
  "ModelNoiseScale",
  "RescaleCFG",
  "EmptySD3LatentImage",
  // Latent-video shape for the seeded Wan 2.1 starter (and student-built video
  // graphs). A dimension holder like EmptyLatentImage: no files, no network.
  "EmptyHunyuanLatentVideo",
  "SaveAnimatedWEBP",
  // MiniMax-H3 video+audio, running on the lab's own weights. The ComfyCloud*
  // and Minimax*Node variants carry near-identical names but POST student
  // prompts and images to a paid third-party API, so they remain excluded.
  "MiniMaxH3ImageToVideo",
  "MiniMaxH3ReferenceToVideo",
  "MiniMaxH3AddGuide",
  "MiniMaxH3SigmaShift",
  "EmptyMiniMaxH3LatentAV",
  "VAEDecodeAudio",
  // H3 graphs sample through SamplerCustomAdvanced rather than KSampler.
  "SamplerCustomAdvanced",
  "BasicGuider",
  "BasicScheduler",
  "KSamplerSelect",
  "RandomNoise",
  // Video and audio output.
  "CreateVideo",
  "SaveVideo",
  "SaveAudio",
  // Utility nodes the stock H3 and Qwen Image 2.1 templates wire in.
  "ResolutionSelector",
  "GetImageSize",
  "ImageScaleToTotalPixels",
  "ComfyMathExpression",
  "ComfySwitchNode",
  "PrimitiveInt",
  "PrimitiveFloat",
  "PrimitiveBoolean",
  "PrimitiveString",
  "PrimitiveStringMultiline",
  // Qwen Image 2.1 text/vision conditioning, KV-cache control, local Qwen 3.5
  // prompt enhancer, and Turbo custom-sigma sampling/output nodes.
  "TextEncodeQwenImage21",
  "QwenImage21Cache",
  "TextGenerate",
  "TextGenerateV2",
  "PreviewAny",
  "ManualSigmas",
  "CFGGuider",
  "SaveImageAdvanced",
  "BatchImagesNode",
  "ImageCompare",
];
function approvedNodes() {
  return new Set(
    (process.env.COMFY_ALLOWED_NODES || coreNodes.join(","))
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  );
}
const objectInfoCache = new Map<string, { filtered: Record<string, any>; fetchedAt: number; persistedAt: number }>();
function filterApprovedNodeInfo(rawInfo: Record<string, any>): Record<string, any> {
  const allowed = approvedNodes();
  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries(rawInfo)) {
    if (!allowed.has(name)) continue;
    out[name] = def;
  }
  if (out.LoadImage?.input?.required?.image) {
    out.LoadImage = {
      ...out.LoadImage,
      input: {
        ...out.LoadImage.input,
        required: {
          ...out.LoadImage.input.required,
          image: [[], { image_upload: true }],
        },
      },
    };
  }
  return out;
}
function metadataWorker(): Worker | undefined {
  const isReachable = (w: Worker) => w.healthStatus === "ONLINE" || w.healthStatus === "BUSY";
  return getDb()
    .list("workers")
    .filter((w) => w.enabled && (isReachable(w) || w.nodeDefinitions))
    .sort(
      (a, b) =>
        Number(isReachable(b)) - Number(isReachable(a)) ||
        Number(!b.externalBusy) - Number(!a.externalBusy) ||
        Number(b.healthStatus === "ONLINE") - Number(a.healthStatus === "ONLINE") ||
        a.id.localeCompare(b.id)
    )[0];
}
async function objectInfo(worker: Worker, s: Session) {
  const cacheKey = `${worker.id}:${worker.baseUrl}`;
  const now = Date.now();
  const cached = objectInfoCache.get(cacheKey);
  let filtered: Record<string, any> | undefined;
  if (cached && now - cached.fetchedAt < 30_000 && worker.nodeDefinitions) {
    filtered = cached.filtered;
  } else if (worker.externalBusy && worker.nodeDefinitions) {
    filtered = cached?.filtered ?? filterApprovedNodeInfo(worker.nodeDefinitions);
    objectInfoCache.set(cacheKey, {
      filtered,
      fetchedAt: now,
      persistedAt: cached?.persistedAt || now,
    });
  } else {
    try {
      const r = await workerFetch(worker, "/object_info", {}, 3000);
      if (!r.ok) throw new Error("Worker metadata unavailable");
      const rawInfo = (await r.json()) as Record<string, any>;
      filtered = filterApprovedNodeInfo(rawInfo);
      const shouldPersist = !worker.nodeDefinitions || !cached || now - cached.persistedAt > 300_000;
      let persistedAt = cached?.persistedAt || 0;
      if (shouldPersist) {
        getDb().transaction(() => {
          const current = getDb().get("workers", worker.id);
          if (current) {
            current.nodeDefinitions = filtered;
            getDb().put("workers", current);
          }
        });
        persistedAt = now;
      }
      objectInfoCache.set(cacheKey, { filtered, fetchedAt: now, persistedAt });
    } catch {
      if (!worker.nodeDefinitions) throw new Error("Worker metadata unavailable");
      filtered = cached?.filtered ?? filterApprovedNodeInfo(worker.nodeDefinitions);
    }
  }
  const inputs = Array.from(ownInputImages(getDb(), s.userId, s.classId!).keys());
  if (!filtered.LoadImage?.input?.required?.image) return filtered;
  return {
    ...filtered,
    LoadImage: {
      ...filtered.LoadImage,
      input: {
        ...filtered.LoadImage.input,
        required: {
          ...filtered.LoadImage.input.required,
          image: [inputs, { image_upload: true }],
        },
      },
    },
  };
}
type PromptNode = { class_type: string; inputs: Record<string, unknown>; _meta?: unknown };
type PromptGraph = Record<string, PromptNode>;
function isLinkValue(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
}
function unwrapPreviewLinks(prompt: PromptGraph) {
  const resolveImageSource = (nodeId: string, slot: number): [string, number] => {
    let curId = nodeId;
    let curSlot = slot;
    const seen = new Set<string>();
    while (
      curSlot === 0 &&
      !seen.has(curId) &&
      prompt[curId] &&
      ["PreviewImage", "SaveImage", "SaveImageAdvanced"].includes(prompt[curId].class_type)
    ) {
      seen.add(curId);
      const upstream = prompt[curId].inputs?.images;
      if (!isLinkValue(upstream) || !prompt[upstream[0]]) break;
      curId = upstream[0];
      curSlot = upstream[1];
    }
    return [curId, curSlot];
  };
  for (const node of Object.values(prompt)) {
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if (isLinkValue(v) && v[1] === 0 && prompt[v[0]]) {
        const [nextId, nextSlot] = resolveImageSource(v[0], v[1]);
        if (nextId !== v[0] || nextSlot !== v[1]) {
          node.inputs[k] = [nextId, nextSlot];
        }
      }
    }
  }
}
function coneSignature(prompt: PromptGraph, rootId: string, memo = new Map<string, string>()): string {
  const visit = (nodeId: string, path: Set<string>): { digest: string; hadCycle: boolean } => {
    if (memo.has(nodeId)) return { digest: memo.get(nodeId)!, hadCycle: false };
    const node = prompt[nodeId];
    if (!node || path.has(nodeId)) {
      return {
        digest: createHash("sha256")
          .update(JSON.stringify({ $ref: nodeId }))
          .digest("hex"),
        hadCycle: true,
      };
    }
    path.add(nodeId);
    let hadCycle = false;
    const rawSwitch = node.class_type === "ComfySwitchNode" ? node.inputs?.switch : undefined;
    const switchVal =
      isLinkValue(rawSwitch) && prompt[rawSwitch[0]]?.class_type === "PrimitiveBoolean"
        ? prompt[rawSwitch[0]]?.inputs?.value
        : rawSwitch;
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(node.inputs || {}).sort()) {
      if (key === "filename_prefix") continue;
      if (node.class_type === "ComfySwitchNode") {
        if (switchVal === false && key === "on_true") continue;
        if (switchVal === true && key === "on_false") continue;
      }
      const val = node.inputs[key];
      if (isLinkValue(val)) {
        const sub = visit(val[0], path);
        if (sub.hadCycle) hadCycle = true;
        entries.push([key, { $link: sub.digest, slot: val[1] }]);
      } else {
        entries.push([key, val]);
      }
    }
    path.delete(nodeId);
    const digest = createHash("sha256")
      .update(JSON.stringify({ class_type: node.class_type, inputs: entries }))
      .digest("hex");
    if (!hadCycle) memo.set(nodeId, digest);
    return { digest, hadCycle };
  };
  return visit(rootId, new Set()).digest;
}
function dependsOnNode(prompt: PromptGraph, startId: string, targetId: string): boolean {
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === targetId) return true;
    if (seen.has(cur) || !prompt[cur]) continue;
    seen.add(cur);
    for (const v of Object.values(prompt[cur].inputs || {})) {
      if (isLinkValue(v) && prompt[v[0]] && !seen.has(v[0])) stack.push(v[0]);
    }
  }
  return false;
}
function resolveSwitchValue(prompt: PromptGraph, node: PromptNode): unknown {
  if (node.class_type !== "ComfySwitchNode") return undefined;
  const rawSwitch = node.inputs?.switch;
  return isLinkValue(rawSwitch) && prompt[rawSwitch[0]]?.class_type === "PrimitiveBoolean"
    ? prompt[rawSwitch[0]]?.inputs?.value
    : rawSwitch;
}
function cleanDanglingSwitchLinks(prompt: PromptGraph) {
  for (const node of Object.values(prompt)) {
    if (node.class_type !== "ComfySwitchNode" || !node.inputs) continue;
    const switchVal = resolveSwitchValue(prompt, node);
    if (switchVal === false && isLinkValue(node.inputs.on_true) && !prompt[node.inputs.on_true[0]]) {
      delete node.inputs.on_true;
    }
    if (switchVal === true && isLinkValue(node.inputs.on_false) && !prompt[node.inputs.on_false[0]]) {
      delete node.inputs.on_false;
    }
  }
}
function pruneUnreachableNodes(prompt: PromptGraph, info: Record<string, any>, partialTargets?: string[]) {
  cleanDanglingSwitchLinks(prompt);
  let removed = true;
  while (removed) {
    removed = false;
    for (const [id, node] of Object.entries(prompt)) {
      const switchVal = resolveSwitchValue(prompt, node);
      for (const [k, v] of Object.entries(node.inputs || {})) {
        if (node.class_type === "ComfySwitchNode") {
          if (switchVal === false && k === "on_true") continue;
          if (switchVal === true && k === "on_false") continue;
        }
        if (isLinkValue(v) && !prompt[v[0]]) {
          delete prompt[id];
          removed = true;
          break;
        }
      }
    }
  }
  const explicitTargets = (partialTargets || []).filter((id) => Boolean(prompt[id]));
  const primaryOutputs = Object.keys(prompt).filter(
    (id) => info[prompt[id].class_type]?.output_node === true && prompt[id].class_type !== "PreviewAny"
  );
  const defaultRoots =
    primaryOutputs.length > 0
      ? primaryOutputs
      : Object.keys(prompt).filter((id) => info[prompt[id].class_type]?.output_node === true);
  const roots = Array.from(new Set([...defaultRoots, ...explicitTargets]));
  if (roots.length === 0) {
    cleanDanglingSwitchLinks(prompt);
    return;
  }
  const reachable = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (reachable.has(cur) || !prompt[cur]) continue;
    reachable.add(cur);
    const node = prompt[cur];
    const switchVal = resolveSwitchValue(prompt, node);
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if (node.class_type === "ComfySwitchNode") {
        if (switchVal === false && k === "on_true") continue;
        if (switchVal === true && k === "on_false") continue;
      }
      if (isLinkValue(v) && prompt[v[0]] && !reachable.has(v[0])) {
        stack.push(v[0]);
      }
    }
  }
  for (const id of Object.keys(prompt)) {
    if (!reachable.has(id)) delete prompt[id];
  }
  cleanDanglingSwitchLinks(prompt);
}
function optimizeMultiStagePrompt(
  prompt: PromptGraph,
  submittedPrompt: PromptGraph,
  s: Session,
  info: Record<string, any>,
  availableImages: Set<string>,
  partialTargets?: string[]
) {
  const fallback = structuredClone(prompt);
  // Normalize any links wired from a PreviewImage/SaveImage output pin directly
  // to that preview node's upstream image producer so stock ComfyUI workers
  // (where PreviewImage has RETURN_TYPES = ()) execute them cleanly.
  unwrapPreviewLinks(prompt);
  unwrapPreviewLinks(submittedPrompt);
  const explicitTargetSet = new Set(partialTargets || []);
  // 1. If a MiniMaxH3ReferenceToVideo node has no reference inputs connected yet
  // while the graph also has independent image preview/save nodes, skip the video
  // branch so clicking Run only generates candidate images until references are wired.
  const imageOutputIds = Object.keys(prompt).filter((id) =>
    ["PreviewImage", "SaveImage", "SaveImageAdvanced"].includes(prompt[id].class_type)
  );
  if (imageOutputIds.length > 0) {
    let prunedVideo = false;
    for (const [id, node] of Object.entries(prompt)) {
      if (node.class_type !== "MiniMaxH3ReferenceToVideo") continue;
      const explicitlyTargeted = Array.from(explicitTargetSet).some(
        (targetId) => prompt[targetId] && dependsOnNode(prompt, targetId, id)
      );
      if (explicitlyTargeted) continue;
      const hasIndependentImageOutput = imageOutputIds.some((imgId) => !dependsOnNode(prompt, imgId, id));
      if (!hasIndependentImageOutput) continue;
      const hasRefs = Object.entries(node.inputs || {}).some(
        ([k, v]) =>
          (k.startsWith("ref_images.") || k.startsWith("ref_videos.") || k.startsWith("ref_audios.")) &&
          isLinkValue(v) &&
          Boolean(prompt[v[0]])
      );
      if (!hasRefs) {
        delete prompt[id];
        prunedVideo = true;
      }
    }
    if (prunedVideo) pruneUnreachableNodes(prompt, info, partialTargets);
  }
  // 2. Cross-job image branch caching: if the student already generated an identical
  // upstream image branch in a completed job in this class, reuse its archived PNG via
  // LoadImage so regenerating one bad image or running MiniMax H3 never re-runs
  // unchanged Qwen Image generators.
  const producerIds = new Set<string>();
  for (const node of Object.values(prompt)) {
    if (["PreviewImage", "SaveImage", "SaveImageAdvanced"].includes(node.class_type)) {
      const src = node.inputs?.images;
      if (isLinkValue(src) && src[1] === 0 && prompt[src[0]] && prompt[src[0]].class_type !== "LoadImage") {
        producerIds.add(src[0]);
      }
    } else if (node.class_type === "MiniMaxH3ReferenceToVideo") {
      for (const [k, v] of Object.entries(node.inputs || {})) {
        if (k.startsWith("ref_images.") && isLinkValue(v) && v[1] === 0 && prompt[v[0]]) {
          if (prompt[v[0]].class_type !== "LoadImage") {
            producerIds.add(v[0]);
          }
        }
      }
    }
  }
  const hasActiveVideoBranch = Object.values(prompt).some((n) =>
    ["MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo", "SaveVideo"].includes(n.class_type)
  );
  if (producerIds.size > 0 && (producerIds.size > 1 || hasActiveVideoBranch)) {
    const cachedBySig = new Map<string, string>();
    const completedJobs = getDb()
      .list("jobs", "user_id=? AND class_id=? AND status='COMPLETED' ORDER BY submitted_at DESC LIMIT 20", [
        s.userId,
        s.classId!,
      ])
      .reverse()
      .filter((j) => j.archiveStatus === "COMPLETE" && j.history?.outputs);
    for (const j of completedJobs) {
      const origRaw = (j.submittedPromptJson || j.promptJson) as PromptGraph | undefined;
      if (!origRaw) continue;
      const orig = structuredClone(origRaw);
      unwrapPreviewLinks(orig);
      const origMemo = new Map<string, string>();
      for (const [outId, outVal] of Object.entries((j.history?.outputs || {}) as Record<string, any>)) {
        const imgs = outVal?.images;
        if (!Array.isArray(imgs) || imgs.length !== 1) continue;
        const fname = imgs[0]?.filename;
        if (typeof fname !== "string" || !availableImages.has(fname)) continue;
        const outNode = orig[outId];
        if (!outNode || !["PreviewImage", "SaveImage", "SaveImageAdvanced"].includes(outNode.class_type)) continue;
        const src = outNode.inputs?.images;
        if (isLinkValue(src) && src[1] === 0 && orig[src[0]] && orig[src[0]].class_type !== "LoadImage") {
          cachedBySig.set(coneSignature(orig, src[0], origMemo), fname);
        }
      }
    }
    if (cachedBySig.size > 0) {
      const submittedMemo = new Map<string, string>();
      let substituted = false;
      for (const pid of producerIds) {
        const hasNonZeroSlotConsumer = Object.values(prompt).some((n) =>
          Object.values(n.inputs || {}).some((v) => isLinkValue(v) && v[0] === pid && v[1] !== 0)
        );
        if (hasNonZeroSlotConsumer) continue;
        const sig = coneSignature(submittedPrompt, pid, submittedMemo);
        const cachedFile = cachedBySig.get(sig);
        if (cachedFile) {
          prompt[pid] = { class_type: "LoadImage", inputs: { image: cachedFile } };
          substituted = true;
        }
      }
      if (substituted) pruneUnreachableNodes(prompt, info, partialTargets);
    }
  }
  cleanDanglingSwitchLinks(prompt);
  if (Object.keys(prompt).length === 0) {
    Object.assign(prompt, fallback);
    cleanDanglingSwitchLinks(prompt);
  }
}
function ownActiveCount(s: Session, db = getDb()): number {
  const row = db.sql
    .prepare(
      "SELECT COUNT(*) AS cnt FROM jobs WHERE user_id=? AND class_id=? AND status IN ('QUEUED','DISPATCHING','RUNNING')"
    )
    .get(s.userId, s.classId!) as { cnt: number };
  return Number(row?.cnt || 0);
}
function queue(s: Session) {
  const jobs = getDb().list(
      "jobs",
      "user_id=? AND class_id=? AND status IN ('QUEUED','DISPATCHING','RUNNING') ORDER BY submitted_at ASC",
      [s.userId, s.classId!]
    ),
    shape = (j: Job) => [Date.parse(j.submittedAt), j.id, j.promptJson, {}, []];
  return {
    queue_running: jobs.filter((j) => ["DISPATCHING", "RUNNING"].includes(j.status)).map(shape),
    queue_pending: jobs.filter((j) => j.status === "QUEUED").map(shape),
  };
}
function allowedFile(base: string, file: string) {
  const resolved = path.resolve(file);
  return resolved.startsWith(path.resolve(base) + path.sep) ? resolved : undefined;
}
// Forward a vetted path to the metadata worker verbatim. Callers decide what is
// vetted; this only moves bytes.
async function proxyWorkerFile(req: express.Request, res: express.Response) {
  const worker = metadataWorker();
  if (!worker) {
    res.status(503).send("No healthy worker available");
    return;
  }
  const response = await workerFetch(worker, req.path);
  res.status(response.status);
  if (response.headers.has("content-type")) res.setHeader("Content-Type", response.headers.get("content-type")!);
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as any), res);
}
async function proxyWorkerHtmlWithStatusWidget(req: express.Request, res: express.Response) {
  const worker = metadataWorker();
  if (!worker) {
    res.status(503).send("No healthy worker available");
    return;
  }
  const response = await workerFetch(worker, req.path);
  res.status(response.status);
  const ct = response.headers.get("content-type") || "text/html; charset=utf-8";
  res.setHeader("Content-Type", ct);
  const html = await response.text();
  if (!ct.includes("text/html")) {
    res.send(html);
    return;
  }
  const tag = '<script src="/lab/status-widget.js" defer></script>';
  res.send(html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : `${html}\n${tag}`);
}
const STATUS_WIDGET_JS = `(function(){
  if (window.__classComfyStatusMounted) return;
  window.__classComfyStatusMounted = true;
  var root = document.createElement("div");
  root.id = "class-comfy-status-pill";
  root.style.cssText = "position:fixed;bottom:14px;left:14px;z-index:99999;display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;background:rgba(15,23,42,0.92);border:1px solid rgba(148,163,184,0.28);color:#f8fafc;font:500 12px/1.35 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.38);backdrop-filter:blur(8px);max-width:min(520px,calc(100vw - 28px));pointer-events:auto;user-select:none;";
  var dot = document.createElement("span");
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;flex:0 0 8px;background:#10b981;box-shadow:0 0 8px rgba(16,185,129,0.7);";
  var label = document.createElement("span");
  label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  label.textContent = "Class GPU queue ready";
  root.appendChild(dot);
  root.appendChild(label);
  function mount(){ if (document.body && !document.getElementById(root.id)) document.body.appendChild(root); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  function fmtSec(iso){
    var ms = Date.now() - Date.parse(iso || "");
    if (!isFinite(ms) || ms < 0) return "0s";
    var s = Math.floor(ms / 1000);
    return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
  }
  async function poll(){
    if (document.hidden) return;
    mount();
    try {
      var r = await fetch("/lab/status", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) return;
      var d = await r.json();
      var own = Array.isArray(d.activeJobs) ? d.activeJobs : [];
      var running = own.find(function(j){ return j.status === "RUNNING" || j.status === "DISPATCHING"; });
      var queued = own.find(function(j){ return j.status === "QUEUED"; });
      if (running) {
        dot.style.background = "#38bdf8";
        dot.style.boxShadow = "0 0 10px rgba(56,189,248,0.85)";
        var stg = running.progress && running.progress.nodeTitle ? running.progress.nodeTitle : (running.status === "DISPATCHING" ? "Staging inputs on GPU" : "Executing on GPU");
        var stepTxt = running.progress && typeof running.progress.step === "number" && typeof running.progress.maxSteps === "number" && running.progress.maxSteps > 0
          ? " (" + running.progress.step + "/" + running.progress.maxSteps + ")"
          : "";
        label.textContent = "Generating: " + stg + stepTxt + " • " + fmtSec(running.startedAt || running.submittedAt) + (own.length > 1 ? " (+" + (own.length - 1) + " queued)" : "");
        return;
      }
      if (queued) {
        dot.style.background = "#f59e0b";
        dot.style.boxShadow = "0 0 10px rgba(245,158,11,0.85)";
        var pos = queued.queuePosition ? "#" + queued.queuePosition + " of " + d.totalQueued : "in queue";
        var gpuNote = d.availableWorkers > 0 ? d.availableWorkers + " class GPU" + (d.availableWorkers === 1 ? "" : "s") + " active" : "waiting for an available class GPU";
        label.textContent = "Queued (" + pos + ") • " + gpuNote + " • waited " + fmtSec(queued.submittedAt);
        return;
      }
      if (d.recentFinished && d.recentFinished.status === "FAILED") {
        dot.style.background = "#f87171";
        dot.style.boxShadow = "0 0 8px rgba(248,113,113,0.8)";
        label.textContent = "Last run failed: " + (d.recentFinished.error || "check node inputs");
        return;
      }
      dot.style.background = d.availableWorkers > 0 ? "#10b981" : "#94a3b8";
      dot.style.boxShadow = d.availableWorkers > 0 ? "0 0 8px rgba(16,185,129,0.7)" : "none";
      label.textContent = "Class GPUs: " + d.availableWorkers + " ready • Queue: " + d.totalQueued + " waiting" + (d.totalRunning > 0 ? " (" + d.totalRunning + " running)" : "");
    } catch (_e) {}
  }
  poll();
  setInterval(poll, 2500);
  document.addEventListener("visibilitychange", function(){ if (!document.hidden) poll(); });
})();`;
// Static frontend files the browser fetches without credentials, which the
// session gate below would answer with 401 or a JSON error body. The PWA
// manifest is fetched by <link rel="manifest">, which omits cookies; the
// icon-font stylesheet and its fonts are pulled in from the manifest's own
// document. Serving a JSON 404 for a .css request also trips strict MIME
// checking in the browser, so these must resolve or not be requested at all.
// All of it is public ComfyUI frontend build output, carrying no student data.
function publicAsset(p: string) {
  return (
    !p.split("/").includes("..") &&
    (/^\/(assets\/)?manifest-[A-Za-z0-9_-]+\.json$/.test(p) ||
      /^\/[A-Za-z0-9_.-]+\.(css|woff2?|ttf|eot|ico|png|svg|webp)$/.test(p) ||
      /^\/(assets|fonts)\/[A-Za-z0-9_.@-]+\.(css|woff2?|ttf|eot|ico|png|svg|webp)$/.test(p))
  );
}
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    for (const h of ["comfy-user", "x-user-id", "x-admin", "x-class-id", "x-role"]) delete req.headers[h];
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) {
      res.status(403).json({ error: "Origin check failed" });
      return;
    }
    if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
    next();
  });
  app.get("/health", (_req, res) => {
    getDb().sql.prepare("SELECT 1").get();
    res.json({ ok: true, service: "gateway", database: "sqlite-wal" });
  });
  app.get("/auth/exchange", (req, res) => {
    const token = String(req.query.token || ""),
      env = getEnv(),
      claims = verifyWorkspaceToken(token, env.WORKSPACE_JWT_SECRET);
    if (!claims) {
      res.status(401).send("Invalid or expired workspace link");
      return;
    }
    const raw = getDb().transaction(() => {
      const db = getDb(),
        ticket = db.get("workspace_tickets", claims.jti);
      if (
        !ticket ||
        ticket.consumedAt ||
        ticket.expiresAt <= Date.now() ||
        ticket.userId !== claims.sub ||
        ticket.classId !== claims.classId ||
        ticket.enrollmentId !== claims.enrollmentId ||
        !activeMembership(db, claims.sub, claims.classId, claims.enrollmentId)
      )
        return null;
      ticket.consumedAt = Date.now();
      db.put("workspace_tickets", ticket);
      const raw = newSessionToken();
      db.put("gateway_sessions", {
        id: hashSessionToken(raw, getEnv().AUTH_SECRET),
        userId: claims.sub,
        classId: claims.classId,
        enrollmentId: claims.enrollmentId,
        expiresAt: Date.now() + env.SESSION_TTL_HOURS * 3600000,
      });
      audit("WORKSPACE_EXCHANGED", { actorId: claims.sub, classId: claims.classId, targetId: claims.enrollmentId }, db);
      return raw;
    });
    if (!raw) {
      res.status(401).send("Workspace link used, expired, or access revoked");
      return;
    }
    // Placed on entry rather than at enrollment, so students who enrolled before
    // a starter existed receive it on their next visit.
    seedStarters({ userId: claims.sub, classId: claims.classId, enrollmentId: claims.enrollmentId } as Session);
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${env.SESSION_TTL_HOURS * 3600}${env.COMFY_PUBLIC_URL.startsWith("https:") ? "; Secure" : ""}`
    );
    res.redirect(303, "/");
  });
  app.get("*", (req, res, next) => {
    if (!publicAsset(req.path)) {
      next();
      return;
    }
    proxyWorkerFile(req, res).catch(next);
  });
  app.use((req, res, next) => {
    const s = session(req);
    if (!s) {
      res.status(401).send("Open ComfyUI from your class dashboard to sign in.");
      return;
    }
    res.locals.session = s;
    next();
  });
  app.use(
    express.json({
      limit: "5mb",
      strict: false,
      type: (req) =>
        !req.url?.startsWith("/userdata/") && !String(req.headers["content-type"] || "").startsWith("multipart/"),
    })
  );
  app.get("/lab/status-widget.js", (_req, res) => {
    res.type("application/javascript").send(STATUS_WIDGET_JS);
  });
  app.get("/lab/status", (_req, res) => {
    const s = res.locals.session as Session,
      db = getDb();
    const availableWorkers = db
      .list("workers")
      .filter((w) => w.enabled && ["ONLINE", "BUSY"].includes(w.healthStatus) && !w.externalBusy).length;
    const fairQueue = fairQueuedJobs(db, getEnv().MAX_ACTIVE_JOBS_PER_USER);
    const totalRunning = Number(
      (
        db.sql.prepare("SELECT COUNT(*) AS cnt FROM jobs WHERE status IN ('DISPATCHING','RUNNING')").get() as {
          cnt: number;
        }
      )?.cnt || 0
    );
    const ownActive = db
      .list(
        "jobs",
        "user_id=? AND class_id=? AND status IN ('QUEUED','DISPATCHING','RUNNING') ORDER BY submitted_at ASC",
        [s.userId, s.classId!]
      )
      .map((j) => {
        const pos = j.status === "QUEUED" ? fairQueue.findIndex((q) => q.id === j.id) + 1 : 0;
        const prog = liveJobProgress.get(j.id);
        return {
          id: j.id,
          status: j.status,
          submittedAt: j.submittedAt,
          startedAt: j.startedAt,
          queuePosition: pos > 0 ? pos : null,
          progress: prog ? { nodeTitle: prog.nodeTitle, step: prog.step, maxSteps: prog.maxSteps } : null,
        };
      });
    const recentCutoff = new Date(Date.now() - 45_000).toISOString();
    const recentRow = db
      .list(
        "jobs",
        "user_id=? AND class_id=? AND status IN ('FAILED','COMPLETED') ORDER BY submitted_at DESC LIMIT 5",
        [s.userId, s.classId!]
      )
      .find((j) => j.completedAt && j.completedAt >= recentCutoff);
    res.json({
      availableWorkers,
      totalQueued: fairQueue.length,
      totalRunning,
      activeJobs: ownActive,
      recentFinished: recentRow
        ? { id: recentRow.id, status: recentRow.status, error: recentRow.error, completedAt: recentRow.completedAt }
        : null,
    });
  });
  app.post("/prompt", async (req, res, next) => {
    try {
      const s = res.locals.session as Session,
        db = getDb(),
        env = getEnv();
      if (!db.rateLimit("prompt:" + s.userId, 30, 60000)) {
        res.status(429).json({ error: "Submission rate limit" });
        return;
      }
      const input = z
        .object({
          prompt: z
            .record(
              z.string(),
              z.object({
                class_type: z.string(),
                inputs: z.record(z.string(), z.unknown()),
                _meta: z.unknown().optional(),
              })
            )
            .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 1000),
          extra_data: z.record(z.string(), z.unknown()).default({}),
          required_tags: z.array(z.string().max(50)).max(20).default([]),
          partial_execution_targets: z.array(z.string().max(100)).max(1000).optional(),
        })
        .parse(req.body);
      const worker = metadataWorker();
      if (!worker) {
        res.status(503).json({ error: "No online worker available to validate the workflow" });
        return;
      }
      const info = await objectInfo(worker, s),
        allowed = approvedNodes(),
        jobId = randomUUID(),
        uploads = new Set(ownInputImages(db, s.userId, s.classId!).keys());
      for (const node of Object.values(input.prompt)) {
        if (node.class_type === "LoadImage" && typeof node.inputs.image === "string") {
          node.inputs.image = node.inputs.image.replace(/\s+\[(output|temp|input)\]$/, "");
        }
      }
      const submittedPromptJson = structuredClone(input.prompt);
      for (const node of Object.values(input.prompt)) {
        if (!allowed.has(node.class_type) || !info[node.class_type]) {
          audit("PROMPT_REJECTED", {
            actorId: s.userId,
            classId: s.classId!,
            metadata: { reason: "disallowed_node", nodeType: node.class_type },
          });
          res.status(400).json({ error: `Node ${node.class_type} is not approved or available` });
          return;
        }
        if (
          node.class_type === "LoadImage" &&
          (typeof node.inputs.image !== "string" || !uploads.has(node.inputs.image))
        ) {
          audit("PROMPT_REJECTED", {
            actorId: s.userId,
            classId: s.classId!,
            metadata: { reason: "foreign_or_missing_upload", nodeType: "LoadImage" },
          });
          res.status(403).json({ error: "Use an image uploaded in this workspace" });
          return;
        }
        if ("filename_prefix" in node.inputs || node.class_type.startsWith("Save"))
          node.inputs.filename_prefix = `lab/${jobId}/output`;
        // Model and dropdown selectors (required, optional, and V3 COMBO) must use worker-advertised choices.
        const required = info[node.class_type]?.input?.required || {};
        const optional = info[node.class_type]?.input?.optional || {};
        for (const [key, value] of Object.entries(node.inputs)) {
          const spec = required[key] ?? optional[key];
          const options = Array.isArray(spec?.[0])
            ? spec[0]
            : spec?.[0] === "COMBO" && Array.isArray(spec?.[1]?.options)
              ? spec[1].options
              : undefined;
          if (
            Array.isArray(options) &&
            !isLinkValue(value) &&
            value !== undefined &&
            value !== null &&
            !options.includes(value)
          ) {
            audit("PROMPT_REJECTED", {
              actorId: s.userId,
              classId: s.classId!,
              metadata: { reason: "invalid_option", nodeType: node.class_type, input: key },
            });
            res.status(400).json({ error: `Invalid selection for ${node.class_type}.${key}` });
            return;
          }
        }
      }
      optimizeMultiStagePrompt(input.prompt, submittedPromptJson, s, info, uploads, input.partial_execution_targets);
      const effectivePartialTargets = input.partial_execution_targets?.filter((id) => Boolean(input.prompt[id]));
      const outcome = db.transaction(() => {
        const member = activeMembership(db, s.userId, s.classId!, s.enrollmentId);
        if (!member) return { kind: "revoked" as const };
        const queuedCnt = Number(
          (
            db.sql.prepare("SELECT COUNT(*) AS cnt FROM jobs WHERE user_id=? AND status='QUEUED'").get(s.userId) as {
              cnt: number;
            }
          )?.cnt || 0
        );
        if (queuedCnt >= env.MAX_QUEUED_JOBS_PER_USER) return { kind: "queue_full" as const };
        const j: Job = {
          id: jobId,
          userId: s.userId,
          classId: s.classId!,
          enrollmentId: member.id,
          orgDefinedId: member.orgDefinedId,
          workerId: null,
          comfyPromptId: null,
          status: "QUEUED",
          archiveStatus: "PENDING",
          submittedAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          runtimeMs: null,
          promptJson: input.prompt,
          submittedPromptJson,
          workflowJson: (input.extra_data.extra_pnginfo as any)?.workflow ?? null,
          extraData: effectivePartialTargets?.length ? { partialExecutionTargets: effectivePartialTargets } : {},
          requiredTags: input.required_tags,
          error: null,
          archiveError: null,
          history: null,
          cancelRequested: false,
          leaseOwner: null,
        };
        db.put("jobs", j);
        audit("JOB_QUEUED", { actorId: s.userId, classId: s.classId!, targetId: j.id }, db);
        return { kind: "ok" as const, job: j };
      });
      if (outcome.kind === "revoked") {
        res.status(403).json({ error: "Class access paused or enrollment revoked" });
        return;
      }
      if (outcome.kind === "queue_full") {
        res.status(429).json({
          error: `Queue limit reached (${env.MAX_QUEUED_JOBS_PER_USER} waiting jobs). Wait for your running job or cancel a queued item.`,
        });
        return;
      }
      res.json({ prompt_id: outcome.job.id, number: Date.parse(outcome.job.submittedAt), node_errors: {} });
    } catch (e) {
      next(e);
    }
  });
  app.get("/prompt", (_req, res) => {
    const s = res.locals.session as Session;
    res.json({ exec_info: { queue_remaining: ownActiveCount(s) } });
  });
  app.get("/queue", (_req, res) => res.json(queue(res.locals.session)));
  app.post("/queue", (req, res) => {
    const s = res.locals.session as Session;
    getDb().transaction(() => {
      const db = getDb();
      for (const j of db.list("jobs", "user_id=? AND class_id=? AND status='QUEUED'", [s.userId, s.classId!])) {
        if (req.body.clear === true || (Array.isArray(req.body.delete) && req.body.delete.includes(j.id))) {
          j.status = "CANCELLED";
          j.completedAt = new Date().toISOString();
          db.put("jobs", j);
          audit(
            "JOB_CANCELLED",
            {
              actorId: s.userId,
              classId: s.classId!,
              targetId: j.id,
              metadata: { status: "CANCELLED", source: "comfy_queue" },
            },
            db
          );
        }
      }
    });
    res.json({ ok: true });
  });
  app.post("/interrupt", (_req, res) => {
    const s = res.locals.session as Session;
    getDb().transaction(() => {
      const db = getDb();
      for (const j of db.list("jobs", "user_id=? AND class_id=? AND status IN ('RUNNING','DISPATCHING')", [
        s.userId,
        s.classId!,
      ])) {
        if (!j.cancelRequested) {
          j.cancelRequested = true;
          db.put("jobs", j);
          audit(
            "JOB_CANCEL_REQUESTED",
            { actorId: s.userId, classId: s.classId!, targetId: j.id, metadata: { source: "comfy_interrupt" } },
            db
          );
        }
      }
    });
    res.json({ ok: true });
  });
  app.get(["/history", "/history/:id"], (req, res) => {
    const s = res.locals.session as Session,
      db = getDb();
    if (req.params.id) {
      const j = db.get("jobs", req.params.id);
      if (j && j.userId === s.userId && j.classId === s.classId && j.history && j.archiveStatus === "COMPLETE") {
        res.json({ [j.id]: j.history });
        return;
      }
      res.json({});
      return;
    }
    const jobs = db
      .list("jobs", "user_id=? AND class_id=? AND status='COMPLETED' ORDER BY submitted_at DESC LIMIT 200", [
        s.userId,
        s.classId!,
      ])
      .filter((j) => j.history && j.archiveStatus === "COMPLETE");
    res.json(Object.fromEntries(jobs.map((j) => [j.id, j.history])));
  });
  app.get("/view", (req, res) => {
    const s = res.locals.session as Session,
      db = getDb(),
      name = String(req.query.filename || "");
    let file: string | undefined,
      mime = "application/octet-stream";
    const upload = db.list("uploads", "user_id=? AND class_id=? AND filename=?", [s.userId, s.classId!, name])[0];
    if (upload) {
      file = allowedFile(getEnv().UPLOAD_DATA_DIR, upload.storagePath);
      mime = upload.mimeType;
    } else {
      const output = db.list("outputs", "json_extract(data,'$.fileName')=?", [name])[0];
      const job = output ? db.get("jobs", output.jobId) : undefined;
      if (output && job && job.userId === s.userId && job.classId === s.classId && job.archiveStatus === "COMPLETE") {
        file = allowedFile(getEnv().AUDIT_DATA_DIR, output.storagePath);
        mime = output.mimeType;
      }
    }
    if (!file || !fs.existsSync(file)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    if (!/^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm)|audio\/(wav|mpeg|ogg|flac))$/.test(mime))
      res.setHeader("Content-Disposition", "attachment");
    res.type(mime).sendFile(file);
  });
  const upload = multer({
    dest: path.join(getEnv().UPLOAD_DATA_DIR, ".incoming"),
    limits: { fileSize: getEnv().MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 4, fieldSize: 1024 },
  });
  app.post("/upload/image", upload.single("image"), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "Image required" });
        return;
      }
      const s = res.locals.session as Session,
        env = getEnv(),
        mime = req.file.mimetype;
      const exts: Record<string, string> = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
      };
      if (!exts[mime]) {
        await fsp.rm(req.file.path, { force: true });
        res.status(400).json({ error: "PNG, JPEG, WebP and GIF uploads are supported" });
        return;
      }
      const id = randomUUID(),
        filename = id + exts[mime],
        dest = path.resolve(env.UPLOAD_DATA_DIR, s.userId, s.classId!, filename);
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      const accepted = getDb().transaction(() => {
        const db = getDb();
        if (!activeMembership(db, s.userId, s.classId!, s.enrollmentId)) return false;
        const used = db.list("uploads", "user_id=?", [s.userId]).reduce((n, u) => {
          try {
            return n + fs.statSync(u.storagePath).size;
          } catch {
            return n;
          }
        }, 0);
        if (used + req.file!.size > env.MAX_USER_STORAGE_MB * 1024 * 1024) return false;
        fs.renameSync(req.file!.path, dest);
        db.put("uploads", {
          id,
          userId: s.userId,
          classId: s.classId!,
          filename,
          storagePath: dest,
          mimeType: mime,
          createdAt: new Date().toISOString(),
        });
        audit(
          "UPLOAD_CREATED",
          {
            actorId: s.userId,
            classId: s.classId!,
            targetId: id,
            metadata: { filename, mimeType: mime, sizeBytes: req.file!.size },
          },
          db
        );
        return true;
      });
      if (!accepted) {
        await fsp.rm(req.file.path, { force: true });
        res.status(413).json({ error: "Storage quota exceeded or access revoked" });
        return;
      }
      res.json({ name: filename, subfolder: "", type: "input" });
    } catch (e) {
      if (req.file) await fsp.rm(req.file.path, { force: true });
      next(e);
    }
  });
  app.get(["/object_info", "/object_info/:name"], async (req, res, next) => {
    try {
      const worker = metadataWorker();
      if (!worker) {
        res.status(503).json({ error: "No worker available" });
        return;
      }
      const info = await objectInfo(worker, res.locals.session);
      res.json(req.params.name ? { [req.params.name]: info[req.params.name] } : info);
    } catch (e) {
      next(e);
    }
  });
  // Real versions so the frontend can version-check nodes rather than warn blindly.
  // `devices` stays empty on purpose: GPU inventory is not a student's business.
  app.get("/system_stats", (_req, res) => {
    const w = metadataWorker();
    res.json({
      system: {
        comfyui_version: w?.comfyVersion ?? "managed",
        python_version: w?.pythonVersion ?? "managed",
        embedded_python: false,
      },
      devices: [],
    });
  });
  app.get("/users", (_req, res) => res.json({ storage: "server", migrated: true }));
  const defaultSettings: Record<string, unknown> = {
    "Comfy.Queue.QPOV2": true,
    "Comfy.Queue.ShowRunProgressBar": true,
  };
  app.get("/settings", (_req, res) => {
    const s = res.locals.session as Session;
    const stored = JSON.parse(
      getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [s.userId, s.classId!, "__settings__"])[0]
        ?.content || "{}"
    );
    res.json({ ...defaultSettings, ...stored });
  });
  app.get("/settings/:id", (req, res) => {
    const s = res.locals.session as Session;
    const all = {
      ...defaultSettings,
      ...JSON.parse(
        getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [s.userId, s.classId!, "__settings__"])[0]
          ?.content || "{}"
      ),
    };
    res.json(Object.hasOwn(all, req.params.id) ? all[req.params.id] : null);
  });
  app.post("/settings", (req, res) => {
    saveUserData(res.locals.session, "__settings__", JSON.stringify(req.body));
    res.json({});
  });
  app.post("/settings/:id", (req, res) => {
    const s = res.locals.session as Session;
    getDb().transaction(() => {
      const all = JSON.parse(
        getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [s.userId, s.classId!, "__settings__"])[0]
          ?.content || "{}"
      );
      all[req.params.id] = req.body;
      saveUserData(s, "__settings__", JSON.stringify(all));
    });
    res.json({});
  });
  installUserData(app);
  installJobs(app);
  installTemplates(app, proxyWorkerFile);
  // Public frontend assets and read-only model catalogs only. Worker-global APIs,
  // custom extension APIs, filesystem routes, manager/install and arbitrary mutations
  // are deliberately not proxied. Add vetted APIs explicitly with owner checks.
  app.get("*", async (req, res, next) => {
    try {
      const isRootHtml = req.path === "/" || req.path === "/index.html";
      const asset =
        isRootHtml ||
        /^\/(assets|scripts|extensions|locales|i18n)\/[a-zA-Z0-9_./@-]+\.(js|css|json|svg|png|woff2?|ttf|ico)$/.test(
          req.path
        ) ||
        /^\/(favicon\.ico|robots\.txt)$/.test(req.path);
      const catalog =
        ["/models", "/embeddings", "/extensions", "/features"].includes(req.path) ||
        /^\/models\/[a-zA-Z0-9_-]+$/.test(req.path);
      if ((!asset && !catalog) || req.path.split("/").includes("..")) {
        res.status(404).json({ error: "Unsupported or private worker endpoint" });
        return;
      }
      if (isRootHtml) {
        await proxyWorkerHtmlWithStatusWidget(req, res);
        return;
      }
      await proxyWorkerFile(req, res);
    } catch (e) {
      next(e);
    }
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    if (error instanceof multer.MulterError) {
      res.status(413).json({ error: "Upload exceeds limits" });
      return;
    }
    console.error("[gateway] request failed", error instanceof Error ? error.name : "Error");
    res.status(502).json({ error: "Gateway request failed" });
  });
  return app;
}
export function attachWs(server: ReturnType<typeof createServer>) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url || "/", "http://localhost").pathname !== "/ws" || !sameOrigin(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const s = session(req);
    if (!s) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    if ([...clients.values()].filter((v) => v.userId === s.userId).length >= 10) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      clients.set(client, s);
      client.on("error", () => {});
      client.on("close", () => clients.delete(client));
      client.on("message", (raw, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(raw.toString("utf8"));
          if (msg?.type === "feature_flags" && client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: "feature_flags",
                data: {
                  supports_preview_metadata: false,
                  max_upload_size: getEnv().MAX_UPLOAD_MB * 1024 * 1024,
                },
              })
            );
          }
        } catch {
          /* Ignore malformed client frames. */
        }
      });
      client.send(
        JSON.stringify({
          type: "status",
          data: {
            sid: randomUUID(),
            status: {
              exec_info: {
                queue_remaining: ownActiveCount(s),
              },
            },
          },
        })
      );
    });
  });
  const timer = setInterval(() => {
    if (!clients.size) return;
    const db = getDb();
    const counts = activeJobCountsBySession(db);
    for (const [client, s] of clients) {
      if (
        s.expiresAt <= Date.now() ||
        !db.get("gateway_sessions", s.id) ||
        !activeMembership(db, s.userId, s.classId!, s.enrollmentId)
      ) {
        client.close(1008, "Session expired or access revoked");
        clients.delete(client);
      } else if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "status",
            data: {
              status: {
                exec_info: {
                  queue_remaining: counts.get(`${s.userId}:${s.classId}`) ?? 0,
                },
              },
            },
          })
        );
      }
    }
  }, 1000);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    for (const client of clients.keys()) client.close();
    wss.close();
  });
  return wss;
}
export function startGateway() {
  validateStartup();
  getDb();
  const app = createApp(),
    server = createServer(app);
  attachWs(server);
  const scheduler = new Scheduler(notify);
  server.listen(getEnv().GATEWAY_PORT, "0.0.0.0", () => console.log("Gateway ready"));
  scheduler.start();
  const stop = () => {
    void scheduler.stop();
    server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { server, scheduler };
}
if (process.env.GATEWAY_RUN !== "0") startGateway();
