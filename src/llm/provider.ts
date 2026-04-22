/**
 * Multi-provider LLM integration via Vercel AI SDK.
 *
 * Uses generateText() with dynamically-discovered MCP tools so the agent
 * automatically knows about every tool appium-mcp exposes — no hardcoded
 * tool names or manual sync required.
 */

import { generateText, streamText, tool, jsonSchema, type Tool } from 'ai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOllama } from 'ai-sdk-ollama';

import type { AppClawConfig } from '../config.js';
import { isVisionLocateEnabledFromConfig } from '../vision/locate-enabled.js';
import {
  DEFAULT_MODELS,
  GROQ_API_BASE_URL,
  VISION_PROVIDERS,
  THINKING_PROVIDERS,
} from '../constants.js';
import type { ScreenDiff } from '../perception/screen-diff.js';
import type { MCPToolInfo } from '../mcp/types.js';
import {
  convertMCPToolsToAITools,
  EXCLUDED_MCP_TOOLS,
  VISION_MODE_EXCLUDED_TOOLS,
} from '../mcp/tool-converter.js';
import { prepareScreenshotForLlm } from '../vision/prepare-screenshot-for-llm.js';
import {
  extractUsageFromGenerateTextResult,
  extractCachedTokensFromMetadata,
} from './extract-usage.js';
import { buildSystemPrompt, buildUserMessage } from './prompts.js';

export interface AgentContext {
  goal: string;
  step: number;
  maxSteps: number;
  /** Trimmed DOM XML — compact page source sent directly to LLM */
  dom: string;
  screenshot?: string;
  lastResult?: string;
  screenChanges: ScreenDiff;
  stuckHint?: string;
  platform: 'android' | 'ios';
  installedApps?: string;
  /** Number of editable fields on the current screen (pre-computed by trimmer) */
  editableCount?: number;
  /** Proactive negative cache: selectors that failed on the current screen */
  failedOnScreen?: string;
  /** Episodic memory: relevant past experience from previous successful runs */
  pastExperience?: string;
  /** AppGuide: per-app navigation knowledge injected when a known app is in the foreground */
  appGuide?: string;
}

/** Token usage for a single LLM call */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tokens served from Gemini implicit cache (reduces billed input cost by ~75%). */
  cachedTokens?: number;
}

/** What the LLM decided to do — a tool call with name and arguments */
export interface ToolCallDecision {
  toolName: string;
  args: Record<string, unknown>;
  /** LLM reasoning text (if any was emitted before the tool call) */
  reasoning?: string;
  /** Token usage for this decision */
  usage?: TokenUsage;
}

/** Streaming callback for live reasoning display */
export interface StreamCallbacks {
  /** Called when reasoning text starts streaming */
  onTextStart?: () => void;
  /** Called with each chunk of reasoning text */
  onTextChunk?: (text: string) => void;
  /** Called when reasoning streaming is complete */
  onDone?: () => void;
}

export interface LLMProvider {
  supportsVision: boolean;
  getDecision(context: AgentContext, stream?: StreamCallbacks): Promise<ToolCallDecision>;
  /** Record an action and its result for history injection into future prompts */
  feedToolResult(result: string): void;
  /** Reset action history (e.g., between sub-goals) */
  resetHistory(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildModel(config: AppClawConfig): any {
  const modelId = config.LLM_MODEL || DEFAULT_MODELS[config.LLM_PROVIDER] || 'gpt-4o';

  switch (config.LLM_PROVIDER) {
    case 'anthropic':
      return createAnthropic({ apiKey: config.LLM_API_KEY })(modelId);

    case 'openai':
      return createOpenAI({ apiKey: config.LLM_API_KEY })(modelId);

    case 'gemini':
      return createGoogleGenerativeAI({ apiKey: config.LLM_API_KEY })(modelId);

    case 'groq':
      return createOpenAI({
        apiKey: config.LLM_API_KEY,
        baseURL: GROQ_API_BASE_URL,
      })(modelId);

    case 'ollama': {
      const ollamaProvider = createOllama({
        ...(config.OLLAMA_BASE_URL ? { baseURL: config.OLLAMA_BASE_URL } : {}),
        ...(config.OLLAMA_API_KEY ? { apiKey: config.OLLAMA_API_KEY } : {}),
      });
      return ollamaProvider(modelId);
    }

    default:
      throw new Error(`Unknown LLM provider: ${config.LLM_PROVIDER}`);
  }
}

/**
 * Build meta-tools — compound actions and convenience wrappers.
 *
 * find_and_click / find_and_type combine appium_find_element + action
 * into a single tool call so the LLM doesn't need to manage element UUIDs.
 *
 * In AGENT_MODE=vision the schema must NOT advertise xpath/id — otherwise the model
 * emits locators even though runtime uses Stark / ai_instruction only.
 */
function buildMetaTools(agentMode: 'dom' | 'vision'): Record<string, Tool> {
  const findAndClickVision = tool({
    description:
      'Tap something on screen using AI vision (screenshot). ' +
      'Describe what you SEE in plain language — visible text, icon shape, color, position. ' +
      'Do NOT use xpath, resource IDs, XML, or accessibility ids; vision cannot parse those reliably. ' +
      'If you can estimate the tap location, provide tapX and tapY (normalized 0-1000) to skip the vision-locate step and speed up execution.',
    inputSchema: z.object({
      selector: z
        .string()
        .describe(
          'Plain-language target, e.g. first video titled Appium 3.0, red Subscribe button, magnifying glass search icon top right'
        ),
      tapY: z
        .number()
        .optional()
        .describe('Estimated Y position in normalized 0-1000 scale (0=top, 1000=bottom)'),
      tapX: z
        .number()
        .optional()
        .describe('Estimated X position in normalized 0-1000 scale (0=left, 1000=right)'),
      bounds: z
        .string()
        .optional()
        .describe('Optional [x1,y1][x2,y2] center fallback if vision fails — rarely needed'),
    }),
  });

  const findAndTypeVision = tool({
    description:
      'Focus an input using AI vision, then type. Describe the field in plain language from the screenshot. ' +
      'Do NOT use xpath or resource IDs. After typing, check the next screenshot for suggestions before calling done. ' +
      'If you can estimate the field location, provide tapX and tapY (normalized 0-1000) to skip the vision-locate step.',
    inputSchema: z.object({
      selector: z
        .string()
        .describe(
          'Plain-language field, e.g. search bar at top with hint Search YouTube, email text field'
        ),
      text: z.string().describe('Text to type'),
      tapY: z
        .number()
        .optional()
        .describe('Estimated Y position in normalized 0-1000 scale (0=top, 1000=bottom)'),
      tapX: z
        .number()
        .optional()
        .describe('Estimated X position in normalized 0-1000 scale (0=left, 1000=right)'),
      bounds: z
        .string()
        .optional()
        .describe('Optional [x1,y1][x2,y2] center fallback if vision fails'),
    }),
  });

  const findAndLongPressVision = tool({
    description:
      'Long-press something on screen using AI vision (press and hold to open context menus, trigger drag, etc.). ' +
      'Describe what you SEE in plain language — visible text, icon shape, color, position. ' +
      'Do NOT use xpath, resource IDs, or element UUIDs. ' +
      'If you can estimate the location, provide tapX and tapY (normalized 0-1000) to skip the vision-locate step.',
    inputSchema: z.object({
      selector: z
        .string()
        .describe(
          'Plain-language target, e.g. Medium Daily Digest email row, red unread notification dot'
        ),
      tapY: z
        .number()
        .optional()
        .describe('Estimated Y position in normalized 0-1000 scale (0=top, 1000=bottom)'),
      tapX: z
        .number()
        .optional()
        .describe('Estimated X position in normalized 0-1000 scale (0=left, 1000=right)'),
      duration: z
        .number()
        .int()
        .optional()
        .describe('Hold duration in milliseconds (default 2000, range 500-10000)'),
      bounds: z
        .string()
        .optional()
        .describe('Optional [x1,y1][x2,y2] center fallback if vision fails'),
    }),
  });

  const findAndLongPressDom = tool({
    description:
      'Find an element and long-press it (press and hold) in one step. ' +
      'Use EXACT locator values from the DOM. ALWAYS include bounds from the DOM as fallback. ' +
      'Use for context menus, drag initiation, or any press-and-hold interaction.',
    inputSchema: z.object({
      strategy: z.enum(['accessibility id', 'id', 'xpath']).describe('Locator strategy'),
      selector: z.string().describe('Locator value — MUST be the EXACT, FULL string from the DOM'),
      duration: z
        .number()
        .int()
        .optional()
        .describe('Hold duration in milliseconds (default 2000, range 500-10000)'),
      bounds: z
        .string()
        .optional()
        .describe('Element bounds from DOM e.g. [x1,y1][x2,y2] — used as coordinate fallback'),
    }),
  });

  const findAndClickDom = tool({
    description:
      'Find an element and click it in one step. ' +
      'Use EXACT locator values from the DOM — never abbreviate. ' +
      'ALWAYS include bounds from the DOM as fallback. ' +
      'This is the PREFERRED way to tap any element.',
    inputSchema: z.object({
      strategy: z.enum(['accessibility id', 'id', 'xpath']).describe('Locator strategy'),
      selector: z.string().describe('Locator value — MUST be the EXACT, FULL string from the DOM'),
      bounds: z
        .string()
        .optional()
        .describe('Element bounds from DOM e.g. [x1,y1][x2,y2] — used as coordinate fallback'),
    }),
  });

  const findAndTypeDom = tool({
    description:
      'Find an input field, click to focus it, and type text — all in one step. ' +
      "Use EXACT locator values from the DOM. Target elements with editable='true'. " +
      'ALWAYS include bounds from the DOM as fallback. ' +
      'After typing, CHECK the screen on the next step — if autocomplete suggestions appeared, you must handle them (tap the right suggestion or press Enter) before proceeding.',
    inputSchema: z.object({
      strategy: z.enum(['accessibility id', 'id', 'xpath']).describe('Locator strategy'),
      selector: z.string().describe('Locator value — MUST be the EXACT, FULL string from the DOM'),
      text: z.string().describe('The text to type into the field'),
      bounds: z
        .string()
        .optional()
        .describe('Element bounds from DOM e.g. [x1,y1][x2,y2] — used as coordinate fallback'),
    }),
  });

  return {
    done: tool({
      description:
        'Signal that the goal has been achieved. ONLY call this when you can see SPECIFIC, OBSERVABLE EVIDENCE on the current screen that the goal is fully complete. ' +
        'Your reason MUST describe what you can see on screen that proves completion (e.g., "The timer shows 16:20", "WiFi toggle is now ON", "Message sent confirmation visible"). ' +
        'Never call done based on assumptions or because an action was performed — only when you can verify the result on screen.',
      inputSchema: z.object({
        reason: z
          .string()
          .describe(
            'What you can SEE on screen right now that proves the goal is complete (cite specific visible elements, text, or state)'
          ),
      }),
    }),

    ask_user: tool({
      description:
        'Ask the user a question when you need human input (OTP, CAPTCHA, ambiguous choices).',
      inputSchema: z.object({
        question: z.string().describe('The question to ask the user'),
      }),
    }),

    find_and_click: agentMode === 'vision' ? findAndClickVision : findAndClickDom,

    find_and_type: agentMode === 'vision' ? findAndTypeVision : findAndTypeDom,

    find_and_long_press: agentMode === 'vision' ? findAndLongPressVision : findAndLongPressDom,

    launch_app: tool({
      description:
        'Launch/activate an app by package name (Android) or bundle ID (iOS). ' +
        'On some OEM devices activate_app cannot resolve a launchable activity; AppClaw retries with a deep link for known apps (e.g. YouTube). ' +
        'You can also call appium_deep_link yourself if a specific URL is needed.',
      inputSchema: z.object({
        appId: z.string().describe('Package name (Android) or bundle ID (iOS)'),
      }),
    }),

    go_back: tool({
      description:
        'Press the Back button. WARNING: This is DESTRUCTIVE — you will lose in-progress work ' +
        '(typed text, loading responses, navigation state). Only use as a last resort.',
      inputSchema: z.object({}),
    }),

    go_home: tool({
      description: 'Press the Home button to go to the home screen.',
      inputSchema: z.object({}),
    }),

    press_enter: tool({
      description:
        'Press the Enter/Return key. Use to submit search queries, confirm text input, ' +
        'dismiss the keyboard, or select the highlighted suggestion. ' +
        'Equivalent to Android KEYCODE_ENTER (66).',
      inputSchema: z.object({}),
    }),
  };
}

/**
 * Build provider-specific options for extended thinking/reasoning.
 * Returns undefined if thinking is disabled or provider doesn't support it.
 */
// Models known to support extended thinking
const THINKING_MODELS: Record<string, RegExp> = {
  anthropic: /claude/, // All Claude models support thinking
  gemini: /gemini-(2\.5|3\.|[4-9])/, // Gemini 2.5+ and 3+ (Google thinking API)
  openai: /^(o1|o3|o4)/, // Only reasoning models (o-series)
};

function isGemini3Family(modelId: string): boolean {
  return /gemini-3/i.test(modelId);
}

function isGemini25Family(modelId: string): boolean {
  return /gemini-2\.5/i.test(modelId);
}

export function buildThinkingOptions(config: AppClawConfig): Record<string, any> | undefined {
  if (config.LLM_THINKING !== 'on') return undefined;
  if (!THINKING_PROVIDERS.has(config.LLM_PROVIDER)) return undefined;

  // Check if the specific model supports thinking
  const modelId = config.LLM_MODEL || DEFAULT_MODELS[config.LLM_PROVIDER] || '';
  const modelPattern = THINKING_MODELS[config.LLM_PROVIDER];
  if (modelPattern && !modelPattern.test(modelId)) return undefined;

  const budget = config.LLM_THINKING_BUDGET;

  switch (config.LLM_PROVIDER) {
    case 'anthropic':
      return {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: budget },
        },
      };
    case 'gemini': {
      // https://ai.google.dev/gemini-api/docs/thinking
      const thinkingConfig: Record<string, unknown> = {};
      if (config.LLM_GEMINI_INCLUDE_THOUGHTS) {
        thinkingConfig.includeThoughts = true;
      }
      if (isGemini3Family(modelId)) {
        thinkingConfig.thinkingLevel = config.LLM_GEMINI_THINKING_LEVEL;
        return { google: { thinkingConfig } };
      }
      if (isGemini25Family(modelId)) {
        thinkingConfig.thinkingBudget = budget;
        return { google: { thinkingConfig } };
      }
      if (config.LLM_GEMINI_INCLUDE_THOUGHTS) {
        return { google: { thinkingConfig } };
      }
      return undefined;
    }
    case 'openai':
      return {
        openai: {
          reasoningEffort: 'medium',
        },
      };
    default:
      return undefined;
  }
}

export function createLLMProvider(config: AppClawConfig, mcpTools: MCPToolInfo[]): LLMProvider {
  const model = buildModel(config);
  const supportsVision = VISION_PROVIDERS.has(config.LLM_PROVIDER);
  const thinkingOptions = buildThinkingOptions(config);

  // Build tool map: dynamic MCP tools + our meta-tools
  // In vision mode, also exclude DOM-oriented tools that distract the agent
  const excludedTools =
    config.AGENT_MODE === 'vision'
      ? new Set([...EXCLUDED_MCP_TOOLS, ...VISION_MODE_EXCLUDED_TOOLS])
      : EXCLUDED_MCP_TOOLS;
  const dynamicTools = convertMCPToolsToAITools(mcpTools, excludedTools);
  const metaTools = buildMetaTools(config.AGENT_MODE);
  const allTools = { ...dynamicTools, ...metaTools };

  // ─── System prompt cache ────────────────────────────────
  // Built lazily on first getDecision() call (platform not known at init time),
  // then reused for every subsequent step — platform/mode never change mid-run.
  let cachedSystemPrompt: string | undefined;

  // ─── Action history for context injection ──────────────
  // Instead of multi-turn messages (which break across providers),
  // we inject a compact action history into each user prompt.
  // This approach works reliably with ALL LLM providers.
  const actionHistory: string[] = [];
  let lastToolName: string | null = null;
  const MAX_HISTORY_ENTRIES = 25;

  return {
    supportsVision,

    async getDecision(
      context: AgentContext,
      callbacks?: StreamCallbacks
    ): Promise<ToolCallDecision> {
      // Build system prompt once and cache it — platform/mode never change mid-run.
      if (!cachedSystemPrompt) {
        cachedSystemPrompt = buildSystemPrompt(
          context.platform,
          isVisionLocateEnabledFromConfig(config),
          config.AGENT_MODE,
          Object.keys(allTools).length
        );
      }
      const systemPrompt = cachedSystemPrompt;

      let userMessage = buildUserMessage(context);
      if (actionHistory.length > 0) {
        const historyBlock = actionHistory.slice(-MAX_HISTORY_ENTRIES).join('\n');
        userMessage = `ACTION_HISTORY (your previous actions — do NOT repeat failed ones):\n${historyBlock}\n\n${userMessage}`;
      }

      // Prepare screenshot async (overlaps with prompt construction above)
      const rawShot = context.screenshot;
      const couldBeImage =
        Boolean(rawShot) &&
        supportsVision &&
        (rawShot!.startsWith('iVBOR') || rawShot!.startsWith('/9j/'));
      const imageForLlm = couldBeImage
        ? await prepareScreenshotForLlm(rawShot, config.LLM_SCREENSHOT_MAX_EDGE_PX)
        : undefined;
      const hasValidScreenshot = Boolean(imageForLlm);

      const messages = [
        {
          role: 'user' as const,
          content: hasValidScreenshot
            ? [
                { type: 'text' as const, text: userMessage },
                { type: 'image' as const, image: imageForLlm! },
              ]
            : userMessage,
        },
      ];

      // Request timeout — abort if the LLM takes too long (hangs on preview models).
      const timeoutMs = config.LLM_REQUEST_TIMEOUT_MS;
      const abortController = timeoutMs > 0 ? new AbortController() : undefined;
      const abortTimer = abortController
        ? setTimeout(() => abortController.abort(), timeoutMs)
        : undefined;

      // Use streaming when callbacks are provided for live reasoning display.
      // Single streamText call with tools — streams any reasoning text the model
      // emits before its tool call, then extracts the tool call from the final result.
      // This replaces the previous two-phase approach that doubled token cost.
      if (callbacks) {
        const stream = streamText({
          model: model as any,
          system: systemPrompt,
          tools: allTools,
          toolChoice: 'required' as const,
          ...(thinkingOptions ? { providerOptions: thinkingOptions } : {}),
          ...(abortController ? { abortSignal: abortController.signal } : {}),
          messages,
        });

        // Stream any reasoning text the model emits before the tool call.
        // Defer onTextStart until the first non-empty chunk arrives — avoids
        // a brief "Reasoning..." flicker for providers (Gemini, GPT-4o) that
        // go straight to tool calls with no text prefix.
        // Gemini thought summaries map to reasoning-delta; plain pre-tool text is text-delta.
        // textStream omits reasoning — use fullStream so goal-based runs show thinking.
        let reasoningText = '';
        let streamingStarted = false;
        for await (const part of stream.fullStream) {
          const chunk =
            part.type === 'reasoning-delta'
              ? part.text
              : part.type === 'text-delta'
                ? part.text
                : '';
          if (!chunk) continue;
          if (!streamingStarted) {
            callbacks.onTextStart?.();
            streamingStarted = true;
          }
          reasoningText += chunk;
          callbacks.onTextChunk?.(chunk);
        }
        if (streamingStarted) callbacks.onDone?.();

        // Await final results after stream completes
        const [streamUsage, streamTotalUsage, toolCalls, text, providerMeta, response] =
          await Promise.all([
            stream.usage,
            stream.totalUsage,
            stream.toolCalls,
            stream.text,
            stream.providerMetadata,
            stream.response,
          ]);

        const extracted = extractUsageFromGenerateTextResult({
          usage: streamUsage,
          totalUsage: streamTotalUsage,
          providerMetadata: providerMeta,
          response: { body: (response as any)?.body },
        });
        const cachedTokens = extractCachedTokensFromMetadata(providerMeta);
        const usage: TokenUsage = {
          inputTokens: extracted.inputTokens,
          outputTokens: extracted.outputTokens,
          totalTokens: extracted.totalTokens,
          cachedTokens: cachedTokens || undefined,
        };

        const toolCall = toolCalls?.[0];
        if (!toolCall) {
          clearTimeout(abortTimer);
          return {
            toolName: 'done',
            args: { reason: text || reasoningText || 'No action decided' },
            reasoning: reasoningText || undefined,
            usage,
          };
        }

        const toolArgs = 'args' in toolCall ? (toolCall as any).args : (toolCall as any).input;

        lastToolName = toolCall.toolName;
        clearTimeout(abortTimer);

        return {
          toolName: toolCall.toolName,
          args: (toolArgs ?? {}) as Record<string, unknown>,
          reasoning: reasoningText || undefined,
          usage,
        };
      }

      // Non-streaming fallback — uses toolChoice "required" for reliability
      const result = await generateText({
        model: model as any,
        system: systemPrompt,
        tools: allTools,
        toolChoice: 'required' as const,
        ...(thinkingOptions ? { providerOptions: thinkingOptions } : {}),
        ...(abortController ? { abortSignal: abortController.signal } : {}),
        messages,
      });
      clearTimeout(abortTimer);

      // Prefer totalUsage + raw Gemini usageMetadata — some models omit fields the SDK maps to 0
      const extracted = extractUsageFromGenerateTextResult(result);
      const cachedTokens = extractCachedTokensFromMetadata(result.providerMetadata);
      const usage: TokenUsage = {
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        totalTokens: extracted.totalTokens,
        cachedTokens: cachedTokens || undefined,
      };

      // Extract the first tool call
      const toolCall = result.toolCalls?.[0];
      if (!toolCall) {
        const fallbackReason = [result.reasoningText, result.text].filter(Boolean).join('\n');
        return {
          toolName: 'done',
          args: { reason: result.text || fallbackReason || 'No action decided' },
          reasoning: fallbackReason || result.text,
          usage,
        };
      }

      // DynamicToolCall uses `input`, StaticToolCall uses `args`
      const toolArgs = 'args' in toolCall ? (toolCall as any).args : (toolCall as any).input;

      // Track last tool for feedToolResult
      lastToolName = toolCall.toolName;

      const reasoningCombined = [result.reasoningText, result.text].filter(Boolean).join('\n');

      return {
        toolName: toolCall.toolName,
        args: (toolArgs ?? {}) as Record<string, unknown>,
        reasoning: reasoningCombined || undefined,
        usage,
      };
    },

    feedToolResult(resultText: string) {
      if (lastToolName) {
        // Compact summary: "tool_name → result" (max 150 chars)
        const summary = `${lastToolName} → ${resultText.slice(0, 250)}`;
        actionHistory.push(summary);
        // Trim to max entries
        while (actionHistory.length > MAX_HISTORY_ENTRIES) {
          actionHistory.shift();
        }
        lastToolName = null;
      }
    },

    resetHistory() {
      actionHistory.length = 0;
      lastToolName = null;
    },
  };
}
