/**
 * Native Qwen2.5-VL vision client — a drop-in for df-vision's `StarkVisionClient`
 * covering the methods the flow/agent vision paths use:
 *   - understandAndLocate(instruction, image) → action + element coordinates
 *   - getBoundingBox(element, image)          → single element bbox
 *   - isElementVisible(image, query)          → visibility assertion
 *   - getElementInfo(image, query)            → free-form Q&A about the screen
 *
 * The whole point of this path is a *fully local* vision experience: reasoning
 * (which action) AND grounding (where) both run on a local Qwen2.5-VL server via
 * LM Studio. No cloud LLM, no df-vision/Gemini.
 *
 * Output contract matches df-vision so downstream code is unchanged:
 *   - `understandAndLocate` returns a JSON string array
 *     [{"action","value","locators":[{"element","coordinates":[y,x],"matchScore"}]}]
 *     with coordinates **normalized 0–1000 in [y, x] order** — the exact space
 *     `scaleCoordinates(coords, screenSize)` expects. Qwen natively returns pixel
 *     `bbox_2d` relative to the image we send, so we convert center pixels → 0–1000.
 *   - `isElementVisible` returns `{"conditionSatisfied":bool,"explanation":string}`.
 *   - `getElementInfo` returns `{"answer":string,"explanation":string}`.
 */

import { getStarkVisionBaseUrl, getStarkVisionModel } from './locate-enabled.js';
import { pngDimensionsFromBase64 } from './png-dimensions.js';
import { trackVisionTokenUsage } from './vision-token-tracker.js';

const appclawDebug = process.env.APPCLAW_DEBUG === '1' || process.env.APPCLAW_DEBUG === 'true';

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: ChatUsage;
}

/** Decide the data-URL MIME from the base64 header (df-vision downscale emits JPEG). */
function mimeForBase64(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  return 'image/png';
}

/**
 * Normalize an OpenAI-compatible base URL so it ends in `/v1` (where LM Studio's
 * chat/completions live). Accepts both `http://localhost:1234` and
 * `http://localhost:1234/v1` — matching how the df-vision client tolerates either.
 */
export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export class QwenVisionClient {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts?: { baseUrl?: string; model?: string }) {
    const baseUrl = opts?.baseUrl ?? getStarkVisionBaseUrl();
    if (!baseUrl) {
      throw new Error(
        'Qwen vision requires a local OpenAI-compatible server (set STARK_VISION_BASE_URL)'
      );
    }
    this.baseUrl = normalizeOpenAIBaseUrl(baseUrl);
    this.model = opts?.model ?? getStarkVisionModel();
  }

  /** Low-level single-turn vision chat. Returns the assistant message content. */
  private async chat(prompt: string, imageBase64: string, maxTokens = 512): Promise<string> {
    const body = {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeForBase64(imageBase64)};base64,${imageBase64}` },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    };

    const t0 = performance.now();
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Qwen vision: server returned ${response.status} ${errText.slice(0, 200)}`);
    }
    const json = (await response.json()) as ChatResponse;
    if (appclawDebug) {
      console.log(`        [qwen] chat/completions ${Math.round(performance.now() - t0)}ms`);
    }
    if (json.usage) {
      trackVisionTokenUsage({
        inputTokens: json.usage.prompt_tokens ?? 0,
        outputTokens: json.usage.completion_tokens ?? 0,
        totalTokens:
          json.usage.total_tokens ??
          (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
      });
    }
    return json.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Classify the action and ground the target in one call, returning the
   * df-vision-shaped JSON string the flow/agent paths already parse.
   */
  async understandAndLocate(instruction: string, imageBase64: string): Promise<string> {
    const dims = pngDimensionsFromBase64(imageBase64) ?? { width: 1, height: 1 };
    const prompt = buildUnderstandPrompt(instruction);
    // Response is a single small JSON object (~60 tokens); a tight budget avoids
    // the model rambling and trims generation time.
    const raw = await this.chat(prompt, imageBase64, 160);
    const parsed = parseQwenAction(raw);
    if (!parsed) {
      // Empty / unparseable → empty array signals "not actionable" to the caller,
      // which then routes to getElementInfo (matches df-vision behavior).
      return '[]';
    }

    // Visibility gate (mirrors df-vision's contract): a low matchScore means the
    // element isn't actually on screen. Qwen will still hallucinate a bbox + pick a
    // stray action ("swipe") in that case, so we DROP the locator and emit the
    // [0,0]/empty contract the flow already treats as "not found". This is what
    // makes a negative instruction ("click logout" when there's no logout) fail
    // cleanly instead of tapping/swiping a phantom element.
    const score = parsed.matchScore ?? 8;
    const center = pixelCenterFromCoords(parsed.bbox_2d);
    const visible = score >= VISIBILITY_MIN_SCORE && center !== null;

    const locators: DfLocator[] = [];
    if (visible && center) {
      // Pixels (relative to the sent image) → normalized 0–1000 [y, x].
      const yNorm = clamp01k((center.cy / dims.height) * 1000);
      const xNorm = clamp01k((center.cx / dims.width) * 1000);
      locators.push({
        element: parsed.label || instruction,
        coordinates: [Math.round(yNorm), Math.round(xNorm)],
        matchScore: score,
      });
    }

    // When not visible, also normalize the action to the instruction's verb so a
    // stray "swipe" doesn't trigger a directional gesture on an absent element.
    const action = visible ? parsed.action : verbFromInstruction(instruction);

    const dfShaped = [
      {
        action,
        value: visible ? (parsed.value ?? null) : null,
        locators,
      },
    ];
    if (appclawDebug) {
      const verdict = visible ? `visible (score ${score})` : `NOT visible (score ${score})`;
      console.log(
        `        [qwen] understand → ${verdict} → ${JSON.stringify(dfShaped).slice(0, 200)}`
      );
    }
    return JSON.stringify(dfShaped);
  }

  /**
   * Locate an element and return its raw `bbox_2d` (pixels relative to the sent
   * image) + label, or null if not present. Used by the agent-loop grounding path,
   * which applies its own device-pixel scaling.
   */
  async locateBoxPixels(
    element: string,
    imageBase64: string
  ): Promise<{ bbox: [number, number, number, number]; label: string } | null> {
    const prompt =
      `Locate "${element}". Output its bounding box coordinates as JSON: ` +
      `[{"bbox_2d":[x1,y1,x2,y2],"label":"..."}]. If not present, return [].`;
    const raw = await this.chat(prompt, imageBase64, 256);
    const boxes = parseQwenBoxes(raw);
    // Accept a 4-element box or a 2-element point (Qwen returns either).
    const box = boxes?.find((b) => pixelCenterFromCoords(b.bbox_2d) !== null);
    const center = pixelCenterFromCoords(box?.bbox_2d);
    if (!box || !center) return null;
    const raw4 = box.bbox_2d!;
    // Normalize to a 4-element box; a point becomes a degenerate box at its center
    // (downstream only uses the center, so this preserves the tap location).
    const bbox: [number, number, number, number] =
      raw4.length >= 4
        ? (raw4.slice(0, 4) as [number, number, number, number])
        : [center.cx, center.cy, center.cx, center.cy];
    return { bbox, label: box.label ?? '' };
  }

  /** Single element bbox → normalized 0–1000 [y, x] inside brackets (df-vision contract). */
  async getBoundingBox(element: string, imageBase64: string): Promise<string> {
    const dims = pngDimensionsFromBase64(imageBase64) ?? { width: 1, height: 1 };
    const prompt =
      `Locate "${element}". Output its bounding box as JSON: ` +
      `[{"bbox_2d":[x1,y1,x2,y2]}]. If not present, return [].`;
    const raw = await this.chat(prompt, imageBase64, 256);
    const boxes = parseQwenBoxes(raw);
    const box = boxes?.find((b) => pixelCenterFromCoords(b.bbox_2d) !== null);
    const center = pixelCenterFromCoords(box?.bbox_2d);
    if (!center) return '[0, 0]';
    const yNorm = Math.round(clamp01k((center.cy / dims.height) * 1000));
    const xNorm = Math.round(clamp01k((center.cx / dims.width) * 1000));
    return `[${yNorm}, ${xNorm}]`;
  }

  /** Visibility assertion → {"conditionSatisfied":bool,"explanation":string}. */
  async isElementVisible(imageBase64: string, query: string, _json = true): Promise<string> {
    const prompt =
      `Look at the screenshot. Is the following visible / true on screen: "${query}"? ` +
      `Answer ONLY with JSON: {"conditionSatisfied": true|false, "explanation": "<short reason>"}.`;
    const raw = await this.chat(prompt, imageBase64, 256);
    // Pass the raw model output through — callers already strip fences and JSON.parse it.
    return raw;
  }

  /** Free-form Q&A about the screen → {"answer":string,"explanation":string}. */
  async getElementInfo(imageBase64: string, query: string, _json = true): Promise<string> {
    const prompt =
      `Look at the screenshot and answer: "${query}". ` +
      `Answer ONLY with JSON: {"answer": "<answer>", "explanation": "<short reason>"}.`;
    const raw = await this.chat(prompt, imageBase64, 512);
    return raw;
  }
}

// ── Parsing helpers (exported for the verify harness) ──────────────────────────

export interface QwenBox {
  bbox_2d?: number[];
  label?: string;
}

export interface QwenAction {
  action: string;
  value?: string | null;
  bbox_2d?: number[];
  label?: string;
  matchScore?: number;
}

function clamp01k(v: number): number {
  return Math.max(0, Math.min(1000, v));
}

/**
 * matchScore below this means "element not actually visible" — drop the
 * (hallucinated) coordinates and report not-found. Matches df-vision's contract
 * where matchScore ≤ 3 ⇔ coordinates [0,0].
 */
const VISIBILITY_MIN_SCORE = 4;

/** Best-effort action verb from the instruction, for the not-found case. */
function verbFromInstruction(instruction: string): string {
  const t = instruction.trim().toLowerCase();
  const m = t.match(
    /\b(click|tap|touch|select|long\s*press|enter|type|send|set|verify|validate|check|wait|drag|swipe|scroll|back|home)\b/
  );
  return m ? m[1].replace(/\s+/g, ' ') : 'click';
}

/**
 * Center (in image pixels) of a Qwen coordinate array. Qwen2.5-VL is inconsistent:
 * it returns either a 4-element box `[x1,y1,x2,y2]` or a 2-element point `[x,y]`
 * (the element center). Accept both — a missing/short array, or one containing
 * null/NaN (Qwen sometimes emits `[null,null]` when it claims an element is
 * visible but can't actually localize it), yields null so callers report not-found.
 */
export function pixelCenterFromCoords(coords?: number[]): { cx: number; cy: number } | null {
  if (!Array.isArray(coords)) return null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  if (coords.length >= 4) {
    const [x1, y1, x2, y2] = coords.map(num);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
  }
  if (coords.length >= 2) {
    const [x, y] = coords.map(num);
    if (x === null || y === null) return null;
    return { cx: x, cy: y };
  }
  return null;
}

/** Strip ```json fences and return the first JSON value (object or array). */
function extractJson(raw: string): string | null {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  if (text.startsWith('[') || text.startsWith('{')) return text;
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) return arr[0];
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) return obj[0];
  return null;
}

export function parseQwenBoxes(raw: string): QwenBox[] | null {
  const json = extractJson(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed as QwenBox[];
    if (parsed && typeof parsed === 'object') return [parsed as QwenBox];
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Parse the understand prompt's response into a single normalized action.
 * Accepts either an object or a one-element array of the shape
 * {"action","value","bbox_2d","label","matchScore"}.
 */
export function parseQwenAction(raw: string): QwenAction | null {
  const json = extractJson(raw);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action.toLowerCase().trim() : '';
  if (!action) return null;
  return {
    action,
    value: typeof o.value === 'string' ? o.value : o.value == null ? null : String(o.value),
    bbox_2d: Array.isArray(o.bbox_2d) ? (o.bbox_2d as number[]) : undefined,
    label: typeof o.label === 'string' ? o.label : undefined,
    matchScore: typeof o.matchScore === 'number' ? o.matchScore : undefined,
  };
}

interface DfLocator {
  element: string;
  coordinates: [number, number];
  matchScore: number;
}

/**
 * The single-call "understand + ground" prompt. Asks Qwen to both classify the
 * action and return the target's native pixel bbox, in one JSON object.
 */
function buildUnderstandPrompt(instruction: string): string {
  // Kept deliberately short: prompt length drives prompt-processing latency on
  // local Qwen. This compact form preserves the visibility gate + matchScore↔
  // presence contract that stops phantom taps, at ~1.4s instead of ~2.2s.
  return [
    'You are a mobile UI automation agent. You are given a screenshot and an instruction.',
    `Instruction: "${instruction}"`,
    '',
    'Follow these steps:',
    'STEP 1 — PARSE: extract the action verb (click/tap/type/long press/swipe/...) and the target element.',
    'STEP 2 — VISIBILITY CHECK (most important): Is the EXACT element the instruction describes actually visible in this screenshot? Answer yes or no.',
    '  - "Exact" means the literal element described, not "something similar" and not "what the user probably meant".',
    '  - Icons/buttons must match by FUNCTION. A "Sign up" button is NOT a "logout button". A gear icon is NOT a search icon.',
    '  - If you can articulate ANY reason to doubt it is present, the answer is NO.',
    'STEP 3 — EMIT one JSON object (no prose, no markdown fence):',
    '{',
    '  "action": "<the verb from STEP 1: click, type, long press, swipe, scroll, back, home, verify, drag>",',
    '  "value": "<text to type, or a direction word for swipe/scroll, else null>",',
    '  "bbox_2d": [x1, y1, x2, y2],   // FOUR pixel numbers locating the target in THIS image. Required (with real values) when STEP 2 = yes.',
    '  "label": "<short name of the target element>",',
    '  "matchScore": <1-10 how literally the element is present & matches>',
    '}',
    '',
    'CRITICAL RULES:',
    '- If STEP 2 = YES → "bbox_2d" MUST be four real pixel numbers (never null, never a 2-number point) and matchScore 4-10.',
    '- If STEP 2 = NO  → OMIT "bbox_2d" entirely and set matchScore 1-3. Do NOT invent a box for a similar element. Keep "action" as the instruction verb (never switch to "swipe"/"scroll" just because the target is absent).',
    '- matchScore <= 3 MUST mean the element is not present. matchScore and presence must agree.',
    '- For a full-screen swipe/scroll with no specific element, use action "swipe"/"scroll", set "value" to the direction, omit "bbox_2d".',
  ].join('\n');
}
