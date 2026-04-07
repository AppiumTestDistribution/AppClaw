/**
 * Explorer Agent — PRD-driven test flow generator.
 *
 * Three-phase agent loop:
 *   1. THINK   — Analyze the PRD, extract features and user journeys
 *   2. EXPLORE — Crawl the app on-device to discover real screens/elements
 *   3. ACT     — Generate N YAML test flows combining PRD + screen data
 *
 * Usage:
 *   appclaw --explore <prd-text-or-file> --num-flows 5
 *   appclaw --explore <prd-text-or-file> --num-flows 5 --no-crawl
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { AppClawConfig } from '../config.js';
import type { MCPClient } from '../mcp/types.js';
import { buildModel, buildThinkingOptions } from '../llm/provider.js';
import { analyzePRD } from './prd-analyzer.js';
import { crawlApp, type CrawlerOptions } from './screen-crawler.js';
import { generateFlows } from './flow-generator.js';
import type { ExplorerConfig, PRDAnalysis, ScreenGraph } from './types.js';
import * as ui from '../ui/terminal.js';

export interface ExplorerResult {
  success: boolean;
  flowsGenerated: number;
  outputDir: string;
  files: string[];
}

/**
 * Run the explorer agent — analyze PRD, optionally crawl device, generate flows.
 */
export async function runExplorer(
  explorerConfig: ExplorerConfig,
  appConfig: AppClawConfig,
  mcp?: MCPClient
): Promise<ExplorerResult> {
  const model = buildModel(appConfig);
  const thinkingOptions = buildThinkingOptions(appConfig);

  // Resolve PRD text — could be a file path or inline text
  let prdText = explorerConfig.prd;
  if (existsSync(prdText)) {
    ui.printExplorerPhase('Read', `Loading PRD from ${prdText}`);
    prdText = readFileSync(prdText, 'utf-8');
  }

  // ─── Phase 1: THINK — Analyze PRD ──────────────────────
  ui.printExplorerPhase('Think', 'Analyzing PRD...');
  ui.startSpinner('Analyzing PRD — extracting features and user journeys...', 'think');

  let analysis: PRDAnalysis;
  try {
    analysis = await analyzePRD(prdText, explorerConfig.numFlows, model, thinkingOptions);
    ui.stopSpinner();
  } catch (err: any) {
    ui.stopSpinner();
    ui.printError('PRD analysis failed', err?.message ?? String(err));
    return { success: false, flowsGenerated: 0, outputDir: explorerConfig.outputDir, files: [] };
  }

  // Display analysis results
  ui.printExplorerAnalysis(analysis);

  // ─── Phase 2: EXPLORE — Crawl device screens ──────────
  let screenGraph: ScreenGraph | undefined;

  if (explorerConfig.crawl && mcp) {
    ui.printExplorerPhase('Explore', 'Crawling app on device...');

    const crawlerOptions: CrawlerOptions = {
      maxScreens: explorerConfig.maxScreens,
      maxDepth: explorerConfig.maxDepth,
      maxElements: appConfig.MAX_ELEMENTS,
      stepDelayMs: appConfig.STEP_DELAY,
    };

    try {
      screenGraph = await crawlApp(mcp, analysis.appId, crawlerOptions);
    } catch (err: any) {
      ui.printWarning(`Crawling failed: ${err?.message ?? err}. Continuing without screen data.`);
    }
  } else if (explorerConfig.crawl && !mcp) {
    ui.printWarning('Crawling requested but no device connection. Generating flows from PRD only.');
  } else {
    ui.printExplorerPhase('Explore', 'Skipped (--no-crawl). Generating flows from PRD only.');
  }

  // ─── Phase 3: ACT — Generate flows ────────────────────
  ui.printExplorerPhase('Act', `Generating ${explorerConfig.numFlows} test flows...`);
  ui.startSpinner(`Generating ${explorerConfig.numFlows} flows...`, 'act');

  let flows;
  try {
    flows = await generateFlows(
      analysis,
      explorerConfig.numFlows,
      model,
      thinkingOptions,
      screenGraph
    );
    ui.stopSpinner();
  } catch (err: any) {
    ui.stopSpinner();
    ui.printError('Flow generation failed', err?.message ?? String(err));
    return { success: false, flowsGenerated: 0, outputDir: explorerConfig.outputDir, files: [] };
  }

  // ─── Save flows to disk ────────────────────────────────
  const outputDir = explorerConfig.outputDir;
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const savedFiles: string[] = [];
  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    // Sanitize name for filename
    const safeName = flow.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    const filename = `${String(i + 1).padStart(2, '0')}-${safeName}.yaml`;
    const filepath = path.join(outputDir, filename);

    writeFileSync(filepath, flow.yamlContent + '\n', 'utf-8');
    savedFiles.push(filepath);
  }

  // Display results
  ui.printExplorerResults(flows, savedFiles);

  return {
    success: true,
    flowsGenerated: flows.length,
    outputDir,
    files: savedFiles,
  };
}
