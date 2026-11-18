import { describe, it, expect } from "vitest";
import { jobModels } from "../../apps/gateway/src/scheduler";

describe("jobModels", () => {
  it("counts loaders feeding an output, skipping disconnected nodes and switched-off branches", () => {
    const prompt = {
      "1": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
      "2": { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: ["3", 0], on_true: ["4", 0] } },
      "3": { class_type: "UNETLoader", inputs: { unet_name: "qwen.safetensors" } },
      "4": { class_type: "CLIPLoader", inputs: { clip_name: "enhancer.safetensors" } },
      "5": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "stray.ckpt" } },
    };
    expect(jobModels(prompt)).toEqual(["qwen.safetensors"]);
    expect(jobModels({ ...prompt, "2": { ...prompt["2"], inputs: { ...prompt["2"].inputs, switch: true } } })).toEqual([
      "enhancer.safetensors",
    ]);
  });
  it("follows both branches when the switch is wired, and every node without an output", () => {
    const wired = {
      "1": { class_type: "PreviewImage", inputs: { images: ["2", 0] } },
      "2": { class_type: "ComfySwitchNode", inputs: { switch: ["6", 0], on_false: ["3", 0], on_true: ["4", 0] } },
      "3": { class_type: "UNETLoader", inputs: { unet_name: "a.safetensors" } },
      "4": { class_type: "UNETLoader", inputs: { unet_name: "b.gguf" } },
      "6": { class_type: "PrimitiveBoolean", inputs: { value: true } },
    };
    expect(jobModels(wired)).toEqual(["a.safetensors", "b.gguf"]);
    expect(jobModels({ "1": { class_type: "UNETLoader", inputs: { unet_name: "x.sft" } } })).toEqual(["x.sft"]);
    expect(jobModels(null)).toEqual([]);
  });
});
