import express from "express";
import { STARTERS } from "./starters";

// ComfyUI's template browser (frontend 1.51) reads three things:
//
//   GET /templates/index.json       categories, each holding template entries
//   GET /templates/index_logo.json  logo metadata for the model-filter chips
//   GET /templates/<name>.json      one workflow graph per entry
//
// None of them were proxied, so the browser rendered "No templates found" and
// logged three 404s. Proxying the worker's own index is not an option: it lists
// 559 stock templates, nearly all of which want models this lab never
// downloaded or cloud API nodes the allowlist denies. So the index is built
// here from the same curated set that gets seeded into each workspace, and the
// stock graphs stay unreachable.
const byName = new Map(STARTERS.map((s) => [String(s.template.name), s]));

function index() {
  const categories: Record<string, Record<string, unknown>> = {};
  for (const starter of STARTERS) {
    const key = starter.category.title;
    const category = (categories[key] ??= {
      moduleName: "default",
      category: "Class starters",
      title: starter.category.title,
      icon: starter.category.icon,
      type: starter.category.type,
      templates: [],
    });
    (category.templates as unknown[]).push(starter.template);
  }
  return Object.values(categories);
}

/**
 * Serve the curated template index, and the graph behind each entry.
 *
 * `proxy` forwards a request to the metadata worker unchanged. It is used only
 * for the logo index and image/video media: static bytes with no student data,
 * which the filter chips and thumbnails need in order to render.
 */
export function installTemplates(
  app: express.Express,
  proxy: (req: express.Request, res: express.Response) => Promise<void>
) {
  app.get("/templates/index.json", (_req, res) => {
    res.json(index());
  });
  // A dict keyed by custom-node module. No custom nodes are exposed here, so an
  // empty one is the honest answer; the frontend fetches it unconditionally.
  app.get("/workflow_templates", (_req, res) => {
    res.json({});
  });
  app.get("/templates/index_logo.json", (req, res, next) => {
    proxy(req, res).catch(next);
  });
  app.get("/templates/*", (req, res, next) => {
    const rest = String((req.params as Record<string, string>)[0]);
    if (rest.split("/").includes("..")) {
      res.status(404).json({ error: "Unknown template" });
      return;
    }
    const starter = byName.get(rest.replace(/\.json$/, ""));
    if (starter) {
      res.json(starter.workflow);
      return;
    }
    // Thumbnails and filter-chip logos only. A stock template's graph is not
    // served: it would open in the student's editor and fail at submit time.
    if (/\.(png|webp|jpe?g|gif|svg|mp4|webm)$/.test(rest)) {
      proxy(req, res).catch(next);
      return;
    }
    res.status(404).json({ error: "Unknown template" });
  });
}
