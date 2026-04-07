/**
 * Flow Generator — generates YAML test flows from PRD analysis + screen data.
 *
 * Combines the PRD understanding (user journeys, features) with real device
 * screen data (element labels, navigation paths) to produce accurate,
 * executable YAML flows.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { PRDAnalysis, ScreenGraph, GeneratedFlow } from './types.js';

const generatedFlowSchema = z.object({
  flows: z.array(
    z.object({
      comment: z
        .string()
        .describe(
          'A one-line comment describing what this flow does (will be placed as a YAML comment on the first line)'
        ),
      name: z
        .string()
        .describe(
          "Descriptive name for this test flow (e.g. 'YouTube — search Appium 3.0 and verify TestMu AI video')"
        ),
      steps: z
        .array(z.string())
        .describe('Ordered steps as natural language strings. Each string is one flow step.'),
    })
  ),
  reasoning: z.string().describe('Why these specific flows were chosen'),
});

const FLOW_GENERATOR_PROMPT = `You are a mobile test automation expert generating YAML flow files for AppClaw.

Each generated flow MUST follow this EXACT format:

\`\`\`yaml
# One-line comment describing what this flow does.
name: Descriptive flow name
---
- open YouTube app
- Click on Search Button
- Type "Appium 3.0" in the search bar
- Perform Search
- Scroll down 2 times until TestMu AI is visible
- done: "TestMu AI video for Appium 3.0 on YouTube is visible"
\`\`\`

The YAML has two documents separated by \`---\`:
- Document 1: metadata with \`name:\` field
- Document 2: a list of steps as natural language strings

Supported step patterns (use NATURAL LANGUAGE — these are the preferred forms):
- open <app name> app              → Opens the app by name (e.g. "open YouTube app")
- Click on <element>               → Taps a UI element (e.g. "Click on Search Button")
- Tap <element>                    → Same as click (e.g. "Tap Subscribe")
- Type "<text>" in the <field>     → Types text into a field. Text MUST be in quotes. (e.g. 'Type "Appium 3.0" in the search bar')
- Perform Search / Submit          → Presses Enter/Return
- Scroll down/up                   → Swipe gesture
- Scroll down N times until "X" is visible → Scroll+assert combo
- wait N s                         → Wait N seconds (e.g. "wait 2 s")
- go back                          → Navigate back
- assert "X" is visible            → Verify text is on screen
- done: "message"                  → Mark flow complete with a description

CRITICAL FORMAT RULES FOR TYPE STEPS:
- The text to type MUST ALWAYS be wrapped in double quotes: Type "search term" in the search bar
- NEVER write: Type Appium automation in the search bar (WRONG — unquoted text gets typed literally)
- ALWAYS write: Type "Appium automation" in the search bar (CORRECT — quotes delimit the text)

RULES:
1. Each flow MUST be a COMPLETE user journey from app launch to completion
2. ALWAYS start with "open <app name> app" as the first step
3. ALWAYS end with done: "description of what was achieved"
4. Use NATURAL LANGUAGE for ALL steps — e.g. "Click on Search Button", NOT "tap: Search"
5. Steps should read like human instructions — capitalize naturally, be specific
6. For Type steps, ALWAYS quote the text: Type "hello world" in the search bar
7. Include assertions where appropriate to verify state
8. Flows MUST be independent — each one can run standalone
9. Use realistic test data (search terms, messages, etc.)
10. If screen data is provided, use REAL element labels from the actual UI
11. Mix happy paths with edge cases — don't just test the obvious
12. Each flow should take 5-15 steps
12. Be specific about which elements to interact with
13. Do NOT use structured YAML keys like "tap:", "type:", "wait:" — use natural language instead`;

/**
 * Generate N YAML flows from PRD analysis and optional screen data.
 */
export async function generateFlows(
  analysis: PRDAnalysis,
  numFlows: number,
  model: any,
  providerOptions?: Record<string, any>,
  screenGraph?: ScreenGraph
): Promise<GeneratedFlow[]> {
  // Build context about available screens
  let screenContext = '';
  if (screenGraph && screenGraph.screens.length > 0) {
    screenContext = '\n\n## Real Device Screen Data\n';
    screenContext += `Discovered ${screenGraph.screens.length} screens with ${screenGraph.transitions.length} transitions.\n\n`;

    for (const screen of screenGraph.screens) {
      screenContext += `### ${screen.id}\n`;
      if (screen.reachedVia) {
        screenContext += `Reached via: ${screen.reachedVia.action} from ${screen.reachedVia.fromScreen}\n`;
      }
      screenContext += `Visible texts: ${screen.visibleTexts.slice(0, 20).join(', ')}\n`;
      screenContext += `Tappable elements: ${screen.tappableElements.map((e) => `"${e.label}" (${e.type})`).join(', ')}\n\n`;
    }

    screenContext += '### Navigation Paths\n';
    for (const t of screenGraph.transitions) {
      screenContext += `- ${t.fromScreen} → tap "${t.element}" → ${t.toScreen}\n`;
    }

    screenContext +=
      '\nIMPORTANT: Use the REAL element labels from screen data above. They are the actual UI labels on the device.';
  }

  // Build journey context
  const journeyContext = analysis.userJourneys
    .sort((a, b) => {
      const priority = { high: 0, medium: 1, low: 2 };
      return priority[a.priority] - priority[b.priority];
    })
    .map(
      (j, i) =>
        `${i + 1}. [${j.priority}] ${j.name}: ${j.description}\n   Steps: ${j.steps.join(' → ')}`
    )
    .join('\n');

  const featureContext = analysis.features
    .map((f) => `- ${f.name}: ${f.description} (elements: ${f.expectedElements.join(', ')})`)
    .join('\n');

  const { object } = await generateObject({
    model,
    schema: generatedFlowSchema,
    system: FLOW_GENERATOR_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Generate exactly ${numFlows} YAML test flows for this mobile app.

## App: ${analysis.appName}
${analysis.appId ? `Package: ${analysis.appId}` : ''}
Platform: ${analysis.platform}

## Features
${featureContext}

## User Journeys (prioritized)
${journeyContext}
${screenContext}

Generate ${numFlows} diverse flows covering the most important journeys. Include a mix of:
- Core happy-path flows (high priority journeys)
- Secondary feature flows
- At least one edge case or error recovery flow if applicable`,
      },
    ],
    ...(providerOptions ? { providerOptions } : {}),
  });

  return object.flows.map((flow, i) => {
    // Build YAML in the exact target format:
    // # Comment describing the flow.
    // name: Flow Name
    // ---
    // - step 1
    // - step 2
    const lines: string[] = [];
    lines.push(`# ${flow.comment}`);
    lines.push(`name: ${flow.name}`);
    lines.push('---');
    for (const step of flow.steps) {
      lines.push(`- ${step}`);
    }

    // Auto-append "done" if the last step isn't already a done step
    const lastStep = flow.steps[flow.steps.length - 1];
    if (!lastStep || !lastStep.toLowerCase().startsWith('done')) {
      lines.push('- done');
    }

    return {
      name: flow.name,
      description: flow.comment,
      yamlContent: lines.join('\n'),
      journey: analysis.userJourneys[i]?.name ?? flow.name,
    };
  });
}
