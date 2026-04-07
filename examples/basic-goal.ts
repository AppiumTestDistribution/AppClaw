/**
 * Basic example: Run a goal on a connected device.
 *
 * Prerequisites:
 *   1. Appium server running: `appium`
 *   2. Device connected (USB or emulator)
 *   3. Set LLM_API_KEY in .env
 *
 * Usage:
 *   npx tsx examples/basic-goal.ts
 */

import { createMCPClient } from '../src/mcp/client.js';
import { AppiumTools } from '../src/mcp/tools.js';
import { createLLMProvider } from '../src/llm/provider.js';
import { runAgent } from '../src/agent/loop.js';
import { loadConfig } from '../src/config.js';

async function main() {
  const config = loadConfig();

  // Connect to appium-mcp via stdio
  const mcpClient = await createMCPClient({
    transport: 'stdio',
    host: 'localhost',
    port: 8080,
  });

  const tools = new AppiumTools(mcpClient);
  const llm = createLLMProvider(config);

  try {
    // Create a session on Android
    console.log('📱 Creating Android session...');
    await tools.createSession('android');

    // Run a simple goal
    const result = await runAgent({
      goal: 'Open the Settings app and navigate to Display settings',
      tools,
      llm,
      maxSteps: 15,
      onStep: (event) => {
        console.log(`  [${event.step + 1}] ${event.decision.action}: ${event.result.message}`);
      },
    });

    console.log(`\nResult: ${result.success ? '✅ Success' : '❌ Failed'}`);
    console.log(`Steps used: ${result.stepsUsed}`);
    console.log(`Reason: ${result.reason}`);

    // Clean up
    await tools.deleteSession();
  } finally {
    await mcpClient.close();
  }
}

main().catch(console.error);
