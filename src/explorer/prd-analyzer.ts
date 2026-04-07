/**
 * PRD Analyzer — extracts app features and user journeys from a PRD.
 *
 * Uses LLM to understand the product description and identify
 * testable user flows that can be automated.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { PRDAnalysis } from './types.js';

const prdSchema = z.object({
  appName: z.string().describe('Name of the application'),
  appId: z
    .string()
    .optional()
    .describe('Package name (Android) or bundle ID (iOS) if identifiable'),
  platform: z.enum(['android', 'ios', 'unknown']).describe('Target platform'),
  features: z
    .array(
      z.object({
        name: z.string().describe('Feature name'),
        description: z.string().describe('What this feature does'),
        expectedElements: z
          .array(z.string())
          .describe('UI elements expected for this feature (buttons, inputs, labels)'),
      })
    )
    .describe('Key features of the app'),
  userJourneys: z
    .array(
      z.object({
        name: z.string().describe('Short name for this journey'),
        description: z.string().describe('What the user is trying to accomplish'),
        steps: z.array(z.string()).describe('High-level ordered steps the user takes'),
        priority: z.enum(['high', 'medium', 'low']).describe('Testing priority'),
      })
    )
    .describe('User journeys that can be automated as test flows'),
  reasoning: z.string().describe('Analysis reasoning — how you interpreted the PRD'),
});

const PRD_ANALYZER_PROMPT = `You are a mobile app testing expert. Given a Product Requirements Document (PRD) or use case description for a mobile application, analyze it and extract:

1. **App Information**: Name, package ID (if identifiable from common apps), platform
2. **Features**: Key features with their expected UI elements
3. **User Journeys**: Testable end-to-end user flows, ordered by priority

Rules:
- Focus on TESTABLE journeys — things that can be automated via UI interactions
- Each journey should be a complete user flow from start to finish
- Steps should be high-level actions (not individual taps)
- Identify at least 2x more journeys than the user requests (they'll pick the best ones)
- Include edge cases and error paths, not just happy paths
- For well-known apps (YouTube, WhatsApp, Settings, etc.), use the correct package name
- Priority: "high" for core features, "medium" for secondary features, "low" for edge cases

Common Android package names:
- YouTube: com.google.android.youtube
- WhatsApp: com.whatsapp
- Chrome: com.android.chrome
- Settings: com.android.settings
- Gmail: com.google.android.gm
- Maps: com.google.android.apps.maps
- Play Store: com.android.vending
- Phone: com.android.dialer
- Messages: com.google.android.apps.messaging
- Camera: com.android.camera2
- Calendar: com.google.android.calendar
- Clock: com.google.android.deskclock`;

/**
 * Analyze a PRD and extract testable features and user journeys.
 */
export async function analyzePRD(
  prdText: string,
  numFlows: number,
  model: any,
  providerOptions?: Record<string, any>
): Promise<PRDAnalysis> {
  const { object } = await generateObject({
    model,
    schema: prdSchema,
    system: PRD_ANALYZER_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Analyze the following PRD/use case description and extract testable user journeys.
I need at least ${numFlows * 2} user journeys (I will select the best ${numFlows}).

PRD / Use Cases:
${prdText}`,
      },
    ],
    ...(providerOptions ? { providerOptions } : {}),
  });

  return object as PRDAnalysis;
}
