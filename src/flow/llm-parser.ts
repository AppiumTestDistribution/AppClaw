/**
 * LLM-based step resolver — fallback when regex can't parse a natural language step.
 *
 * Sends the instruction to the configured LLM with a structured schema
 * and gets back a concrete FlowStep. Supports any language or phrasing.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { buildModel } from '../llm/provider.js';
import { Config } from '../config.js';
import type { FlowStep } from './types.js';

// Spatial qualifier disambiguating which matching element to act on, e.g.
// "the login button below the password field". Set BOTH fields together or neither.
const proximitySchema = z
  .object({
    relation: z
      .enum(['above', 'below', 'toLeftOf', 'toRightOf', 'near', 'within'])
      .describe('Spatial relation of the target element to the anchor'),
    anchor: z.string().describe('Label/text of the reference element the target is positioned by'),
  })
  .optional()
  .describe('Only when the instruction positions the target relative to another element');

const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('openApp'), query: z.string().describe('App name to open') }),
  z.object({
    kind: z.literal('closeApp'),
    query: z
      .string()
      .optional()
      .describe('App name to close/terminate; omit to close the current foreground app'),
  }),
  z.object({
    kind: z.literal('tap'),
    label: z.string().describe('Element label/text to tap'),
    proximity: proximitySchema,
  }),
  z.object({
    kind: z.literal('longPress'),
    label: z.string().describe('Element label/text to long-press'),
    duration: z.number().optional().describe('Hold duration in ms, default 2000'),
  }),
  z.object({
    kind: z.literal('type'),
    text: z.string().describe('Text to type'),
    target: z.string().optional().describe('Target field to type into'),
    proximity: proximitySchema,
  }),
  z.object({ kind: z.literal('enter') }),
  z.object({ kind: z.literal('back') }),
  z.object({ kind: z.literal('home') }),
  z.object({
    kind: z.literal('swipe'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    repeat: z.number().optional(),
  }),
  z.object({ kind: z.literal('wait'), seconds: z.number().describe('Seconds to wait, default 2') }),
  z.object({
    kind: z.literal('waitUntil'),
    condition: z.enum(['visible', 'gone', 'screenLoaded']),
    text: z.string().optional().describe('Text/element to wait for (not needed for screenLoaded)'),
    timeoutSeconds: z.number().describe('Timeout in seconds, default 10'),
  }),
  z.object({ kind: z.literal('assert'), text: z.string().describe('Text to verify is visible') }),
  z.object({
    kind: z.literal('scrollAssert'),
    text: z.string(),
    direction: z.enum(['up', 'down', 'left', 'right']),
    maxScrolls: z.number(),
  }),
  z.object({
    kind: z.literal('drag'),
    from: z.string().describe('Visual description of the element to drag from'),
    to: z.string().describe('Visual description of the drop target'),
    duration: z.number().optional().describe('Drag movement duration in ms, default 1200'),
    longPressDuration: z.number().optional().describe('Hold before drag in ms, default 600'),
  }),
  z.object({ kind: z.literal('getInfo'), query: z.string() }),
  z.object({ kind: z.literal('done'), message: z.string().optional() }),
  z.object({ kind: z.literal('launchApp') }),
  z.object({
    kind: z.literal('zoom'),
    scale: z
      .number()
      .describe(
        'Scale factor: > 1 = zoom in, < 1 = zoom out. e.g. 2.0 = 2x zoom in, 0.5 = zoom out'
      ),
    target: z.string().optional().describe('Optional element label to zoom on'),
  }),
]);

const SYSTEM_PROMPT =
  `You are a mobile app test step interpreter. Convert the user's natural language instruction into a structured test step.\n\n` +
  `Rules:\n` +
  `- "open/launch/start <app>" → openApp\n` +
  `- "close/terminate/quit/kill <app>" → closeApp (query = app name); "close the app" → closeApp with no query (closes current app)\n` +
  `- "click/tap/press/select <element>" → tap\n` +
  `- "long press/long-press/press and hold <element>" → longPress\n` +
  `- "type/enter/input <text>" or "search for <text>" → type\n` +
  `- "wait for <element> to be visible/appear" → waitUntil (visible)\n` +
  `- "wait for <element> to disappear/be gone" → waitUntil (gone)\n` +
  `- "wait for screen to load/stabilize" → waitUntil (screenLoaded)\n` +
  `- "wait <N> seconds" → wait\n` +
  `- "drag/slide/move X to Y" → drag (from=X, to=Y)\n` +
  `- "swipe/scroll <direction>" → swipe\n` +
  `- "zoom in [Nx] [on/into/the <element>]" → zoom (scale > 1), "zoom out [on <element>]" → zoom (scale < 1). e.g. "zoom in the map", "zoom in 2x on the image"\n` +
  `- "pinch in/out [on/into/the <element>]" → zoom\n` +
  `- "verify/check/assert <text>" → assert\n` +
  `- "scroll until <text> visible" → scrollAssert\n` +
  `- "go back" → back, "go home" → home\n` +
  `- "press enter/submit/search" → enter\n` +
  `- "done" → done\n` +
  `When a tap/type names a target positioned relative to another element ` +
  `("the login button below the password field", "the icon to the right of the title", ` +
  `"the field inside the form"), set proximity={relation, anchor}: relation is one of ` +
  `above|below|toLeftOf|toRightOf|near|within, anchor is the reference element's label. ` +
  `Put only the target's own label in label/target — not the relation or anchor. ` +
  `Omit proximity entirely when there is no relative positioning.\n` +
  `Extract the relevant parameters. Works with any language.`;

export interface ResolvedStep {
  step: FlowStep;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Resolve a free-form natural language instruction into a concrete FlowStep via LLM.
 */
export async function resolveNaturalStep(instruction: string): Promise<ResolvedStep> {
  const model = buildModel(Config);

  // Wrap the discriminated union in an object so the generated JSON schema has a
  // top-level `type: "object"`. A bare top-level union serializes to `anyOf`/`oneOf`
  // with no root `type`, which the Anthropic tool API rejects with
  // `tools.0.custom.input_schema.type: Field required` (older provider versions
  // silently normalized this; @ai-sdk/anthropic v3 forwards the schema verbatim).
  const { object, usage } = await generateObject({
    model: model as any,
    schema: z.object({ step: stepSchema }),
    system: SYSTEM_PROMPT,
    prompt: instruction,
    providerOptions: {
      google: { thinkingConfig: { thinkingBudget: 0 } },
      anthropic: { thinking: { type: 'disabled' } },
    },
  });

  return {
    step: { ...object.step, verbatim: instruction } as FlowStep,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
  };
}
