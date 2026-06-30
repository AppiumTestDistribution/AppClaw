# Plan: Native Qwen2.5-VL Vision Locator for AppClaw

## Goal

Add a native Qwen vision path that grounds UI elements using Qwen2.5-VL's _own_
format (proven pixel-perfect at ~1.4s in testing), running locally via LM Studio.
Leave df-vision untouched as the Gemini path.

## Background / motivation

The original ask was to run NVIDIA **LocateAnything-3B** locally on an Apple
Silicon Mac to power AppClaw vision mode. Findings:

- **LocateAnything-3B cannot run on a Mac** — it requires NVIDIA CUDA GPUs
  (Ampere/Hopper/Lovelace/Blackwell) and Linux, and serves via vLLM/SGLang.
  License is non-commercial (research only).
- It _is_ built on **Qwen2.5-3B** and does GUI element grounding, outputting
  normalized 0–1000 coordinates over an OpenAI-compatible endpoint.
- The practical Mac substitute is **Qwen2.5-VL-7B-Instruct** (the family
  LocateAnything is built on), run locally via **LM Studio**.

### What testing proved (LM Studio, Apple Silicon)

| Model                                                               | Result                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen/qwen3.5-9b` (reasoning)                                       | ❌ burns entire token budget thinking, returns empty content; ignores `/no_think` and `enable_thinking=false`; 6–13s+/locate. Unusable. |
| `qwen2.5-vl-7b-instruct` (vision, native bbox)                      | ✅ pixel-perfect grounding, ~1.4s, clean output                                                                                         |
| `qwen2.5-vl-7b-instruct` (forced into Gemini `[y,x]` 0–1000 format) | ❌ wrong/transposed (`[500,500]`, `[850,200]`)                                                                                          |
| `qwen2.5-vl-7b-instruct` (DOM mode tool-calling)                    | ✅ correct action but ~24s/step — **too slow for the agent loop**                                                                       |

Conclusion: use Qwen2.5-VL **for vision grounding only**, in its **native
format**. DOM mode stays on a cloud LLM.

## Why a new path (not a df-vision config tweak)

Qwen's contract is fundamentally different from df-vision's Gemini contract:

|                           | df-vision (Gemini)                   | Qwen2.5-VL native               |
| ------------------------- | ------------------------------------ | ------------------------------- |
| Prompt                    | `[y,x]` normalized 0–1000            | `"Output bounding box in JSON"` |
| Output                    | `[y, x]`                             | `[{"bbox_2d":[x1,y1,x2,y2]}]`   |
| Scale                     | 0–1000 normalized                    | **image pixels**                |
| Forced into Gemini format | ❌ `[500,500]` / `[850,200]` (wrong) | ✅ pixel-perfect                |

The `STARK_VISION_COORDINATE_ORDER=xy` flag only swaps axis order — it cannot fix
the prompt difference or the pixel-vs-normalized mismatch. A native path is the
correct fix.

## Verified integration contract

The synthetic UUID embeds **device-pixel coordinates** (`ai-element:x,y:tag`),
parsed at `src/agent/element-finder.ts:22` and tapped via `appium_click`. So the
Qwen locator must output **device-pixel** center coordinates — same as the
existing Stark path.

---

## Changes

### 1. Config — `src/config.ts`

Add one provider switch (default preserves all current behavior):

```ts
VISION_PROVIDER: z.enum(['stark', 'qwen']).default('stark'),
```

Reuse existing `STARK_VISION_BASE_URL` + `STARK_VISION_MODEL` for the
endpoint/model (no new connection vars).

### 2. New file — `src/vision/qwen-locate.ts`

Mirror `starkLocateTapTarget`'s signature and return type exactly, so it's a
drop-in:

```ts
export async function qwenLocateTapTarget(
  mcp,
  instruction,
  existingScreenshot?
): Promise<{ x; y; elementLabel; syntheticUuid }>;
```

Pipeline:

1. **Screenshot** — reuse `captureScreenshotBase64` pattern + `existingScreenshot` reuse.
2. **Device size** — reuse `getScreenSizeForStark(mcp, raw)` (handles Android px / iOS points already).
3. **Downscale + track scale factor** — reuse `downscaleForVision` (512px max edge),
   but capture `scaleX = deviceWidth / sentImageWidth`, `scaleY = deviceHeight / sentImageHeight`
   via `pngDimensionsFromBase64` on the _sent_ image. **This is the crux** — Qwen
   returns coords relative to the image we send, not the device.
4. **Native prompt:** `Locate "<instruction>". Output its bounding box coordinates as JSON: [{"bbox_2d":[x1,y1,x2,y2],"label":"..."}]. If not present, return [].`
5. **Call LM Studio** via raw `fetch` to `${baseUrl}/chat/completions` (no df-vision dependency).
6. **Parse** — strip ```json fences, `JSON.parse`, read `bbox_2d`. Empty array / missing → throw "not found" (mirrors Stark's `[0,0]` contract).
7. **Center → device pixels:** `cx = ((x1+x2)/2) * scaleX`, `cy = ((y1+y2)/2) * scaleY`.
8. **Return** `ai-element:${cx},${cy}:qwen` synthetic UUID.

### 3. Dispatch — `src/mcp/tools.ts` `findElementByVision` (line 108–110)

```ts
const provider = Config.VISION_PROVIDER;
const located =
  provider === 'qwen'
    ? await (
        await import('../vision/qwen-locate.js')
      ).qwenLocateTapTarget(client, description, existingScreenshot)
    : await (
        await import('../vision/stark-locate.js')
      ).starkLocateTapTarget(client, description, existingScreenshot);
```

Both return the same shape → everything downstream (synthetic UUID →
`appium_click`) is unchanged.

### 4. Enablement — `src/vision/locate-enabled.ts`

`starkConfigured()` returns true when `STARK_VISION_BASE_URL` is set, so
`VISION_PROVIDER=qwen` + base URL already reports vision as enabled. No change
needed (verify only).

---

## Critical correctness risk & how to de-risk it

**Coordinate scaling (step 3/7) is the whole ballgame** — Qwen's pixels are
relative to the downscaled image, must be scaled to device pixels. Before any
device run, validate with a test harness:

- Reuse a 400×400 multi-element test image (known ground-truth boxes).
- Run `qwenLocateTapTarget` logic against LM Studio, assert computed center lands
  inside the true bbox for red/green/blue elements.
- Test both Android (pixels) and iOS-shaped (points) screen sizes via mocked
  `getScreenSizeForStark`.

This catches scaling bugs in seconds, on the desk, before touching Appium.

---

## Out of scope (decided)

- **DOM mode** (~24s/step — too slow; stays on cloud LLM).
- **df-vision changes** (remains the Gemini path).
- **The genuine NVIDIA LocateAnything-3B** (CUDA/Linux only; remote-GPU is a
  separate future option — serve it on a rented NVIDIA GPU and point
  `STARK_VISION_BASE_URL` at the remote URL).

## Files touched

- `src/config.ts` (+1 enum)
- `src/vision/qwen-locate.ts` (new, ~120 lines)
- `src/mcp/tools.ts` (dispatch, ~5 lines)
- `.env` docs / README vision table
- A verify script in scratchpad (scaling validation)

## Final `.env`

```bash
AGENT_MODE=vision
VISION_PROVIDER=qwen
STARK_VISION_BASE_URL=http://localhost:1234/v1
STARK_VISION_MODEL=qwen2.5-vl-7b-instruct
```

## LM Studio setup

1. Discover/Search tab → search `Qwen2.5-VL-7B-Instruct` → pick a build with the
   vision (👁️) badge. On Apple Silicon prefer an **MLX** build
   (e.g. `mlx-community/Qwen2.5-VL-7B-Instruct-4bit`); GGUF also works.
2. Load it; eject any reasoning model (e.g. `qwen3.5-9b`).
3. Developer / Local Server tab → Start Server (default `http://localhost:1234`).
4. Copy the exact model id LM Studio shows into `STARK_VISION_MODEL`.

## Implementation order (when building)

1. `qwen-locate.ts` + scaling verify script (the riskiest part) — prove
   coordinates land correctly against the test harness.
2. Wire the dispatch in `findElementByVision`.
3. Add config enum + docs.
4. Validate on a real device.
