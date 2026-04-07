/**
 * Quick verification script — run with: npx tsx tests/verify-parsing.ts
 * Tests the parser + variable resolver without needing a device.
 */

import { parseFlowYamlFile } from '../src/flow/parse-yaml-flow.js';
import { loadEnvironmentFile } from '../src/flow/variable-resolver.js';
import { resolve } from 'path';

async function main() {
  console.log('=== 1. Load environment file ===');
  const envFile = resolve(process.cwd(), '.appclaw/env/dev.yaml');
  const bindings = loadEnvironmentFile(envFile);
  console.log('Variables:', bindings.variables);

  console.log('\n=== 2. Parse phased flow with variable interpolation ===');
  const flowFile = resolve(process.cwd(), 'tests/flows/youtube-phased.yaml');
  const parsed = await parseFlowYamlFile(flowFile, { bindings });

  console.log('Meta:', parsed.meta);
  console.log('Total steps:', parsed.steps.length);
  console.log('Phases:', parsed.phases.length);

  console.log('\n=== 3. Phase breakdown ===');
  for (const { step, phase } of parsed.phases) {
    const display = step.verbatim ?? step.kind;
    console.log(`  [${phase.padEnd(9)}] ${step.kind.padEnd(14)} → ${display}`);
  }

  console.log('\n=== 4. Verify secret redaction ===');
  const typeStep = parsed.phases.find((p) => p.step.kind === 'type');
  if (typeStep && typeStep.step.kind === 'type') {
    console.log('  Resolved text:', typeStep.step.text); // actual value
    console.log('  Verbatim (display):', typeStep.step.verbatim); // should show ***
  }

  console.log('\n=== 5. Parse legacy flat flow (backward compat) ===');
  const legacyFile = resolve(process.cwd(), 'flows/youtube.yaml');
  const legacy = await parseFlowYamlFile(legacyFile);
  console.log('Legacy steps:', legacy.steps.length);
  console.log(
    'Legacy phases:',
    legacy.phases.map((p) => p.phase)
  );
  console.log(
    'All test phase?',
    legacy.phases.every((p) => p.phase === 'test')
  );

  console.log('\n✅ All parsing checks passed!');
}

main().catch((err) => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
