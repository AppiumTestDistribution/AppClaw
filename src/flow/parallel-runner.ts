/**
 * Parallel flow execution engine.
 *
 * Handles two modes:
 *
 * 1. **Single flow, N devices** (`parallel: N` in flow meta):
 *    Runs the same flow simultaneously on N different devices.
 *    Each worker gets its own appium-mcp process and unique ports.
 *
 * 2. **Suite of flows, N workers** (`parallel: N` in suite meta):
 *    Distributes a list of flow files across N workers using a
 *    work-queue model — each worker picks the next flow when it
 *    finishes its current one, so all N devices stay busy.
 *
 * Port allocation per worker (avoids Appium conflicts):
 *   Ports are dynamically allocated by asking the OS for a free port,
 *   so stale sessions from previous runs never cause conflicts.
 */

import { resolve, dirname } from 'path';
import * as crypto from 'crypto';
import * as net from 'net';
import { acquireSharedMCPClient } from '../mcp/client.js';
import type { AppClawConfig } from '../config.js';
import type { Platform, DeviceType } from '../index.js';
import { extractText } from '../mcp/tools.js';
import { parseDeviceList } from '../device/device-picker.js';
import { setupDevice } from '../device/index.js';
import type { DeviceSetupArgs } from '../device/index.js';
import { AppResolver } from '../agent/app-resolver.js';
import { runYamlFlow } from './run-yaml-flow.js';
import type { RunYamlFlowOptions, RunYamlFlowResult } from './run-yaml-flow.js';
import type { ParsedFlow, ParsedSuite } from './types.js';
import { resolveFlowApp } from './types.js';
import { parseFlowYamlFile } from './parse-yaml-flow.js';
import { RunArtifactCollector, writeSuiteEntry } from '../report/writer.js';
import { emitJson, isJsonMode } from '../json-emitter.js';
import * as ui from '../ui/terminal.js';
import chalk from 'chalk';

// ── Free port discovery ─────────────────────────────────────────────

/** Ask the OS for an available TCP port by binding to port 0. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

// ── Types ───────────────────────────────────────────────────────────

export interface WorkerFlowResult {
  flowFile: string;
  workerIndex: number;
  deviceName: string;
  deviceUdid: string;
  result: RunYamlFlowResult;
  error?: string;
}

export interface ParallelRunResult {
  workers: WorkerFlowResult[];
  allPassed: boolean;
  passedCount: number;
  failedCount: number;
}

// ── Device discovery ────────────────────────────────────────────────

interface DiscoveredDevice {
  name: string;
  udid: string;
  state?: string;
}

/**
 * Discover available devices using the shared MCP client.
 * Returns a sorted list (booted first).
 */
async function discoverDevices(
  mcp: import('../mcp/types.js').MCPClient,
  platform: Platform,
  deviceType?: DeviceType
): Promise<DiscoveredDevice[]> {
  const args: Record<string, unknown> = { platform };
  if (platform === 'ios' && deviceType) args.iosDeviceType = deviceType;

  const result = await mcp.callTool('select_device', args);
  const text = extractText(result);
  const devices = parseDeviceList(text, platform);

  // Sort: booted first, then by name
  devices.sort((a, b) => {
    const aBooted = a.state?.toLowerCase() === 'booted' ? 0 : 1;
    const bBooted = b.state?.toLowerCase() === 'booted' ? 0 : 1;
    if (aBooted !== bBooted) return aBooted - bBooted;
    return a.name.localeCompare(b.name);
  });

  return devices;
}

// ── Port allocation ─────────────────────────────────────────────────

interface WorkerCapsResult {
  caps: Record<string, unknown>;
  mjpegUrl?: string;
}

async function buildWorkerCaps(platform: Platform): Promise<WorkerCapsResult> {
  if (platform === 'android') {
    const [systemPort, mjpegPort] = await Promise.all([findFreePort(), findFreePort()]);
    const mjpegUrl = `http://127.0.0.1:${mjpegPort}`;
    return {
      caps: {
        'appium:systemPort': systemPort,
        'appium:mjpegServerPort': mjpegPort,
        'appium:mjpegScreenshotUrl': mjpegUrl,
      },
      mjpegUrl,
    };
  }
  if (platform === 'ios') {
    const wdaPort = await findFreePort();
    return {
      caps: { 'appium:wdaLocalPort': wdaPort },
    };
  }
  return { caps: {} };
}

// ── Worker execution ────────────────────────────────────────────────

interface WorkerJob {
  flowFile: string;
  parsed: ParsedFlow;
  suiteId?: string;
  suiteName?: string;
}

async function runWorkerJob(
  job: WorkerJob,
  workerIndex: number,
  device: DiscoveredDevice,
  baseSetupArgs: DeviceSetupArgs,
  sharedMcp: import('../mcp/types.js').MCPClient,
  options: RunYamlFlowOptions,
  platform: Platform
): Promise<WorkerFlowResult> {
  const label = chalk.cyan(`[worker:${workerIndex + 1}]`);
  const isCloud = baseSetupArgs.config.CLOUD_PROVIDER === 'lambdatest';

  // setupDevice creates the Appium session and returns a session-scoped MCP
  // wrapper (scopedMcp). All subsequent tool calls go through scopedMcp so
  // they carry the correct sessionId and target the right device.
  // Include appium:udid directly in capabilities so create_session uses the
  // correct device regardless of appium-mcp's global select_device state.
  // Without this, concurrent workers race on the shared activeDevice global
  // in appium-mcp and both end up targeting the same physical device.
  // Cloud mode: skip local port allocation — LambdaTest allocates sessions dynamically.
  const { caps: workerCaps, mjpegUrl } = isCloud
    ? { caps: {}, mjpegUrl: undefined }
    : await buildWorkerCaps(platform);
  const appUrl = resolveFlowApp(job.parsed.meta.app, platform);
  const appCap = appUrl ? { 'appium:app': appUrl } : {};
  const deviceResult = await setupDevice(sharedMcp, {
    ...baseSetupArgs,
    cliUdid: isCloud ? null : device.udid,
    extraCaps: isCloud ? { ...appCap } : { 'appium:udid': device.udid, ...workerCaps, ...appCap },
  });

  emitJson({
    event: 'device_ready',
    data: { platform, device: deviceResult.deviceName, mjpegUrl },
  });

  const scopedMcp = deviceResult.scopedMcp;

  try {
    console.log(`${label} ${chalk.green('ready')} — ${deviceResult.deviceName}`);

    const appResolver = new AppResolver();
    await appResolver.initialize(scopedMcp, deviceResult.platform);

    const artifactCollector = new RunArtifactCollector(
      job.flowFile,
      job.parsed.meta,
      deviceResult.platform,
      deviceResult.deviceName,
      job.suiteId,
      job.suiteName
    );

    const deviceLabel = deviceResult.deviceName;
    const workerOnFlowStep = isJsonMode()
      ? (
          step: number,
          total: number,
          kind: string,
          target: string | undefined,
          status: 'running' | 'passed' | 'failed',
          error?: string,
          message?: string
        ) => {
          emitJson({
            event: 'flow_step',
            data: { step, total, kind, target, status, error, message, device: deviceLabel },
          });
        }
      : undefined;

    const result = await runYamlFlow(
      scopedMcp,
      job.parsed.meta,
      job.parsed.steps,
      {
        ...options,
        appResolver,
        artifactCollector,
        deviceUdid: deviceResult.deviceUdid,
        onFlowStep: workerOnFlowStep,
      },
      job.parsed.phases
    );

    const status = result.success ? chalk.green('passed') : chalk.red('failed');
    console.log(
      `${label} ${status} — ${job.flowFile} (${result.stepsExecuted}/${result.stepsTotal} steps)`
    );

    try {
      await scopedMcp.callTool('appium_session_management', {
        action: 'delete',
        sessionId: deviceResult.sessionId,
      });
    } catch {
      /* ignore */
    }

    try {
      const runId = await artifactCollector.finalize(process.cwd(), result);
      console.log(`${label} report saved: .appclaw/runs/${runId}`);
    } catch {
      /* non-fatal */
    }

    return {
      flowFile: job.flowFile,
      workerIndex,
      deviceName: deviceResult.deviceName,
      deviceUdid: deviceResult.deviceUdid,
      result,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${label} ${chalk.red('error')} — ${job.flowFile}: ${message}`);
    try {
      await scopedMcp.callTool('appium_session_management', {
        action: 'delete',
        sessionId: deviceResult.sessionId,
      });
    } catch {
      /* ignore */
    }
    return {
      flowFile: job.flowFile,
      workerIndex,
      deviceName: device.name,
      deviceUdid: device.udid,
      result: { success: false, stepsExecuted: 0, stepsTotal: job.parsed.steps.length },
      error: message,
    };
  }
}

// ── Work-queue dispatcher ───────────────────────────────────────────

/**
 * Dispatch a queue of jobs across N workers.
 * Each worker pulls the next job when it finishes, keeping all devices busy.
 */
async function dispatchQueue(
  jobs: WorkerJob[],
  devices: DiscoveredDevice[],
  parallelCount: number,
  baseSetupArgs: DeviceSetupArgs,
  sharedMcp: import('../mcp/types.js').MCPClient,
  options: RunYamlFlowOptions,
  platform: Platform
): Promise<WorkerFlowResult[]> {
  const queue = [...jobs];
  const results: WorkerFlowResult[] = [];

  // Each worker runs jobs sequentially until the queue is empty
  async function workerLoop(workerIndex: number): Promise<void> {
    const device = devices[workerIndex];
    while (true) {
      const job = queue.shift();
      if (!job) break;
      const result = await runWorkerJob(
        job,
        workerIndex,
        device,
        baseSetupArgs,
        sharedMcp,
        options,
        platform
      );
      results.push(result);
    }
  }

  // Launch all workers in parallel
  await Promise.all(Array.from({ length: parallelCount }, (_, i) => workerLoop(i)));

  return results;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Run a single flow on N devices in parallel.
 * Used when a flow YAML has `parallel: N`.
 */
export async function runFlowOnDevices(
  flowFile: string,
  parsed: ParsedFlow,
  parallelCount: number,
  baseSetupArgs: DeviceSetupArgs,
  config: AppClawConfig,
  options: RunYamlFlowOptions
): Promise<ParallelRunResult> {
  const platform = (baseSetupArgs.cliPlatform ?? parsed.meta.platform ?? 'android') as Platform;
  const deviceType = baseSetupArgs.cliDeviceType ?? undefined;
  const mcpConfig = {
    transport: config.MCP_TRANSPORT,
    host: config.MCP_HOST,
    port: config.MCP_PORT,
  };

  // One shared appium-mcp process for all workers
  const sharedMcp = await acquireSharedMCPClient(mcpConfig);

  try {
    const isCloud = config.CLOUD_PROVIDER === 'lambdatest';
    let selected: DiscoveredDevice[];

    if (isCloud) {
      ui.printInfo(
        `Using LambdaTest cloud — ${parallelCount} parallel session(s) on ${config.LAMBDATEST_DEVICE_NAME}`
      );
      selected = Array.from({ length: parallelCount }, (_, i) => ({
        name: `${config.LAMBDATEST_DEVICE_NAME} [${i + 1}]`,
        udid: `lambdatest-cloud-${i + 1}`,
      }));
    } else {
      ui.printInfo(`Discovering ${platform} devices for ${parallelCount} parallel workers...`);
      const devices = await discoverDevices(sharedMcp, platform, deviceType);

      if (devices.length < parallelCount) {
        throw new Error(
          `parallel: ${parallelCount} requires ${parallelCount} ${platform} device(s), ` +
            `but only ${devices.length} found. Available: ${devices.map((d) => d.name).join(', ')}`
        );
      }

      selected = devices.slice(0, parallelCount);
      ui.printInfo(`Workers: ${selected.map((d, i) => `[${i + 1}] ${d.name}`).join('  ')}`);
    }

    const suiteId = generateSuiteId();
    const suiteName =
      parsed.meta.name ??
      flowFile
        .split('/')
        .pop()
        ?.replace(/\.ya?ml$/, '');

    const startedAt = new Date().toISOString();
    const jobs: WorkerJob[] = selected.map(() => ({ flowFile, parsed, suiteId, suiteName }));
    const workerResults = await dispatchQueue(
      jobs,
      selected,
      parallelCount,
      baseSetupArgs,
      sharedMcp,
      options,
      platform
    );

    const result = summarize(workerResults);
    const durationMs = Date.now() - new Date(startedAt).getTime();

    try {
      await writeSuiteEntry(process.cwd(), {
        suiteId,
        suiteName,
        platform,
        startedAt,
        durationMs,
        runIds: [],
        passedCount: result.passedCount,
        failedCount: result.failedCount,
      });
    } catch {
      /* non-fatal */
    }

    return result;
  } finally {
    await sharedMcp.release();
  }
}

/**
 * Run a suite of flows across N worker devices.
 * Used when a suite YAML has `parallel: N` and lists multiple flow files.
 *
 * Workers pull from a shared queue — if you have 4 flows and 2 workers,
 * worker A runs flows 1 & 3, worker B runs flows 2 & 4 (or similar).
 * If `parallelCount` is 1 (or unset), flows run sequentially on one device.
 */
export async function runSuite(
  suite: ParsedSuite,
  parallelCount: number,
  baseSetupArgs: DeviceSetupArgs,
  config: AppClawConfig,
  baseOptions: RunYamlFlowOptions
): Promise<ParallelRunResult> {
  const platform = (baseSetupArgs.cliPlatform ?? suite.meta.platform ?? 'android') as Platform;
  const deviceType = baseSetupArgs.cliDeviceType ?? undefined;
  const mcpConfig = {
    transport: config.MCP_TRANSPORT,
    host: config.MCP_HOST,
    port: config.MCP_PORT,
  };

  // One shared appium-mcp process for all workers
  const sharedMcp = await acquireSharedMCPClient(mcpConfig);

  try {
    ui.printInfo(`Suite: ${suite.flows.length} flows, ${parallelCount} worker(s) on ${platform}`);

    const isCloud = config.CLOUD_PROVIDER === 'lambdatest';
    let selected: DiscoveredDevice[];

    if (isCloud) {
      ui.printInfo(
        `Using LambdaTest cloud — ${parallelCount} parallel session(s) on ${config.LAMBDATEST_DEVICE_NAME}`
      );
      selected = Array.from({ length: parallelCount }, (_, i) => ({
        name: `${config.LAMBDATEST_DEVICE_NAME} [${i + 1}]`,
        udid: `lambdatest-cloud-${i + 1}`,
      }));
    } else {
      const devices = await discoverDevices(sharedMcp, platform, deviceType);
      if (devices.length < parallelCount) {
        throw new Error(
          `parallel: ${parallelCount} requires ${parallelCount} ${platform} device(s), ` +
            `but only ${devices.length} found. Available: ${devices.map((d) => d.name).join(', ')}`
        );
      }
      selected = devices.slice(0, parallelCount);
      ui.printInfo(`Workers: ${selected.map((d, i) => `[${i + 1}] ${d.name}`).join('  ')}`);
    }

    const suiteId = generateSuiteId();
    const suiteName = suite.meta.name;
    const startedAt = new Date().toISOString();

    // Parse all flow files up front so errors surface before execution
    const jobs: WorkerJob[] = [];
    for (const flowFile of suite.flows) {
      let parsed: ParsedFlow;
      try {
        parsed = await parseFlowYamlFile(flowFile, { strict: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse suite flow "${flowFile}": ${msg}`);
      }
      jobs.push({ flowFile, parsed, suiteId, suiteName });
    }

    const workerResults = await dispatchQueue(
      jobs,
      selected,
      parallelCount,
      baseSetupArgs,
      sharedMcp,
      baseOptions,
      platform
    );

    const result = summarize(workerResults);
    const durationMs = Date.now() - new Date(startedAt).getTime();

    try {
      await writeSuiteEntry(process.cwd(), {
        suiteId,
        suiteName,
        platform,
        startedAt,
        durationMs,
        runIds: [],
        passedCount: result.passedCount,
        failedCount: result.failedCount,
      });
    } catch {
      /* non-fatal */
    }

    return result;
  } finally {
    await sharedMcp.release();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateSuiteId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', 'T').split('.')[0];
  const suffix = crypto.randomBytes(3).toString('hex');
  return `suite-${ts}-${suffix}`;
}

function summarize(workers: WorkerFlowResult[]): ParallelRunResult {
  const passedCount = workers.filter((w) => w.result.success).length;
  return {
    workers,
    allPassed: passedCount === workers.length,
    passedCount,
    failedCount: workers.length - passedCount,
  };
}

/** Print a human-readable summary table after a parallel/suite run. */
export function printParallelSummary(result: ParallelRunResult): void {
  console.log();
  console.log(chalk.bold('── Run Summary ──────────────────────────────────────────'));
  for (const w of result.workers) {
    const icon = w.result.success ? chalk.green('✓') : chalk.red('✗');
    const steps = `${w.result.stepsExecuted}/${w.result.stepsTotal}`;
    const device = chalk.dim(`[${w.deviceName}]`);
    const flowName = w.flowFile.split('/').pop() ?? w.flowFile;
    const reason = w.error ?? w.result.reason;
    const tail = reason ? chalk.red(` — ${reason}`) : '';
    console.log(`  ${icon} ${flowName} ${device} ${steps} steps${tail}`);
  }
  console.log();
  const total = result.workers.length;
  const summary = `${result.passedCount}/${total} passed`;
  if (result.allPassed) {
    console.log(chalk.green.bold(`  All ${summary}`));
  } else {
    console.log(chalk.red.bold(`  ${summary} (${result.failedCount} failed)`));
  }
  console.log();
}
