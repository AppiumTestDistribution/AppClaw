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

const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('openApp'), query: z.string().describe('App name to open') }),
  z.object({ kind: z.literal('tap'), label: z.string().describe('Element label/text to tap') }),
  z.object({
    kind: z.literal('type'),
    text: z.string().describe('Text to type'),
    target: z.string().optional().describe('Target field to type into'),
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
]);

const SYSTEM_PROMPT =
  `You are a mobile app test step interpreter. Convert the user's natural language instruction into a structured test step.\n\n` +
  `Rules:\n` +
  `- "open/launch/start <app>" → openApp\n` +
  `- "click/tap/press/select <element>" → tap\n` +
  `- "type/enter/input <text>" or "search for <text>" → type\n` +
  `- "wait for <element> to be visible/appear" → waitUntil (visible)\n` +
  `- "wait for <element> to disappear/be gone" → waitUntil (gone)\n` +
  `- "wait for screen to load/stabilize" → waitUntil (screenLoaded)\n` +
  `- "wait <N> seconds" → wait\n` +
  `- "drag/slide/move X to Y" → drag (from=X, to=Y)\n` +
  `- "swipe/scroll <direction>" → swipe\n` +
  `- "verify/check/assert <text>" → assert\n` +
  `- "scroll until <text> visible" → scrollAssert\n` +
  `- "go back" → back, "go home" → home\n` +
  `- "press enter/submit/search" → enter\n` +
  `- "done" → done\n` +
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

  const { object, usage } = await generateObject({
    model: model as any,
    schema: stepSchema,
    system: SYSTEM_PROMPT,
    prompt: instruction,
    providerOptions: {
      google: { thinkingConfig: { thinkingBudget: 0 } },
      anthropic: { thinking: { type: 'disabled' } },
    },
  });

  return {
    step: { ...object, verbatim: instruction } as FlowStep,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
  };
}
