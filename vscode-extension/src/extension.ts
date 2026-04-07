/**
 * AppClaw VS Code Extension — entry point.
 *
 * Registers commands, tree views, CodeLens providers,
 * and wires them to the AppclawBridge (CLI child process).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AppclawBridge, getEnvFromSettings, getCliCommand, type WorkerResult } from './bridge';
import { DevicePanel } from './webview/device-panel';
import { FlowCodeLensProvider } from './providers/flow-codelens';
import { FlowCompletionProvider } from './providers/flow-completion';
import { DevicesTreeProvider } from './views/devices-tree';
import { FlowsTreeProvider } from './views/flows-tree';
import { HistoryTreeProvider } from './views/history-tree';

let bridge: AppclawBridge;
let outputChannel: vscode.OutputChannel;

/** Suite run state — persisted so "Re-run Failed" can reference it after the run finishes. */
let lastSuiteFile: string | undefined;
let lastFailedFlows: string[] = [];

/** Format a bridge event into a human-readable log line */
function formatEvent(event: any): string | null {
  const d = event.data;
  switch (event.event) {
    case 'connected':
      return `[appclaw] Connected (transport: ${d.transport})`;
    case 'device_ready':
      return `[appclaw] Device ready — platform: ${d.platform}${d.device ? `, device: ${d.device}` : ''}`;
    case 'plan':
      return `[appclaw] Plan: ${d.goal} (${d.subGoals?.length ?? 0} sub-goals, complex: ${d.isComplex})`;
    case 'goal_start':
      return `[appclaw] Goal ${d.subGoalIndex}/${d.totalSubGoals}: ${d.goal}`;
    case 'step': {
      const icon = d.success ? '\u2713' : '\u2717';
      const target = d.target ? ` → ${d.target}` : '';
      return `[step ${d.step}] ${icon} ${d.action}${target} — ${d.message}`;
    }
    case 'flow_step': {
      if (
        d.kind === 'yaml' ||
        d.kind === 'export' ||
        d.kind === 'list' ||
        d.kind === 'undo' ||
        d.kind === 'clear'
      ) {
        // Playground slash-command results — show as-is
        return `[appclaw] /${d.kind}: ${d.target ?? d.status}`;
      }
      const icon = d.status === 'passed' ? '\u2713' : d.status === 'failed' ? '\u2717' : '\u25B6';
      const err = d.error ? ` — ${d.error}` : '';
      let line = `[step ${d.step}/${d.total}] ${icon} ${d.kind}${d.target ? `: ${d.target}` : ''}${err}`;
      // Show getInfo response inline
      if (d.kind === 'getInfo' && d.status === 'passed' && d.message) {
        line += ` — ${d.message}`;
      }
      return line;
    }
    case 'goal_done': {
      const icon = d.success ? '\u2713' : '\u2717';
      return `[appclaw] ${icon} Goal done: ${d.reason} (${d.stepsUsed} steps)`;
    }
    case 'flow_done': {
      const icon = d.success ? '\u2713' : '\u2717';
      const fail = d.failedAt ? ` (failed at step ${d.failedAt})` : '';
      return `[appclaw] ${icon} Flow done: ${d.stepsExecuted}/${d.stepsTotal} steps${fail}${d.reason ? ` — ${d.reason}` : ''}`;
    }
    case 'parallel_done': {
      const icon = d.success ? '\u2713' : '\u2717';
      return `[appclaw] ${icon} Parallel run: ${d.passedCount}/${d.passedCount + d.failedCount} passed${d.reason ? ` — ${d.reason}` : ''}`;
    }
    case 'suite_done': {
      const icon = d.success ? '\u2713' : '\u2717';
      return `[appclaw] ${icon} Suite done: ${d.passedCount}/${d.passedCount + d.failedCount} passed${d.reason ? ` — ${d.reason}` : ''}`;
    }
    case 'hitl':
      return `[appclaw] HITL (${d.type}): ${d.prompt}`;
    case 'error':
      return `[appclaw] ERROR: ${d.message}${d.detail ? ` — ${d.detail}` : ''}`;
    case 'done': {
      const icon = d.success ? '\u2713' : '\u2717';
      return `[appclaw] ${icon} Done (${d.totalSteps} steps${d.totalCost ? `, cost: $${d.totalCost.toFixed(4)}` : ''})`;
    }
    case 'screen':
      // Screen events are frequent and noisy — skip in output channel
      return null;
    default:
      return `[appclaw] ${event.event}: ${JSON.stringify(d)}`;
  }
}

/** Filter stderr lines — only keep important appium/mcp output, skip debug noise */
function isRelevantStderr(line: string): boolean {
  // Skip empty lines
  if (!line.trim()) {
    return false;
  }
  // Skip verbose debug/proxy lines from Appium drivers
  if (/\bdbug\b/.test(line)) {
    return false;
  }
  if (/\bProxying \[/.test(line)) {
    return false;
  }
  if (/\bGot response with status\b/.test(line)) {
    return false;
  }
  if (/\bMatched '.*' to command name\b/.test(line)) {
    return false;
  }
  if (/^\s*"/.test(line)) {
    return false;
  } // JSON body fragments
  if (/^\s*[{}\[\]]/.test(line.trim())) {
    return false;
  } // JSON structure lines
  // Keep info/warn/error lines, tool start/end, and anything else meaningful
  return true;
}

// Flow step gutter icons — shows pass/fail/running next to each YAML step
let runningStepDecoration: vscode.TextEditorDecorationType;
let passedStepDecoration: vscode.TextEditorDecorationType;
let failedStepDecoration: vscode.TextEditorDecorationType;
let activeFlowFilePath: string | undefined;
let passedLines: number[] = [];
let failedLines: number[] = [];

export function activate(context: vscode.ExtensionContext): void {
  bridge = new AppclawBridge();
  outputChannel = vscode.window.createOutputChannel('AppClaw');

  // Initialize gutter icon decorations
  const mediaPath = (name: string) => vscode.Uri.joinPath(context.extensionUri, 'media', name);
  runningStepDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: mediaPath('step-running.svg').fsPath,
    gutterIconSize: 'contain',
    isWholeLine: true,
    backgroundColor: 'rgba(255, 196, 0, 0.06)',
  });
  passedStepDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: mediaPath('step-passed.svg').fsPath,
    gutterIconSize: 'contain',
    isWholeLine: true,
  });
  failedStepDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: mediaPath('step-failed.svg').fsPath,
    gutterIconSize: 'contain',
    isWholeLine: true,
  });

  // Forward all bridge events to output channel with human-readable formatting
  bridge.on('event', (event: any) => {
    const formatted = formatEvent(event);
    if (formatted) {
      outputChannel.appendLine(formatted);
    }
  });
  bridge.on('stderr', (line: string) => {
    // Filter out noisy appium-mcp debug/proxy lines — only keep important ones
    if (isRelevantStderr(line)) {
      outputChannel.appendLine(`[appium] ${line.replace(/^\s*\[appium-mcp\]\s*/, '')}`);
    }
  });

  // ─── Tree Views ───────────────────────────────────────
  const devicesTree = new DevicesTreeProvider();
  const flowsTree = new FlowsTreeProvider();
  const historyTree = new HistoryTreeProvider();

  vscode.window.registerTreeDataProvider('appclaw.devices', devicesTree);
  vscode.window.registerTreeDataProvider('appclaw.flows', flowsTree);
  vscode.window.registerTreeDataProvider('appclaw.history', historyTree);

  // Track history from bridge events
  let currentGoal = '';
  let currentSteps = 0;
  let goalStartTime = Date.now();

  bridge.on('goal_start', (data) => {
    currentGoal = data.goal;
    currentSteps = 0;
    goalStartTime = Date.now();
  });
  bridge.on('step', () => {
    currentSteps++;
  });
  bridge.on('goal_done', (data) => {
    historyTree.addEntry({
      goal: data.goal || currentGoal,
      success: data.success,
      steps: data.stepsUsed || currentSteps,
      timestamp: new Date(),
      duration: Date.now() - goalStartTime,
    });
  });
  bridge.on('flow_done', (data) => {
    historyTree.addEntry({
      goal: currentGoal || 'Flow execution',
      success: data.success,
      steps: data.stepsExecuted,
      timestamp: new Date(),
    });
  });
  bridge.on('suite_done', (data) => {
    handleSuiteOrParallelDone(
      data.workers as WorkerResult[] | undefined,
      data.passedCount,
      data.failedCount,
      data.success
    );
  });
  bridge.on('parallel_done', (data) => {
    handleSuiteOrParallelDone(
      data.workers as WorkerResult[] | undefined,
      data.passedCount,
      data.failedCount,
      data.success
    );
  });

  // ─── Suite / Parallel Result Handling ────────────────
  /**
   * Find the YAML line for a flow file entry in a suite YAML.
   * Matches lines like `  - flows/foo.yaml` or `  - ./flows/foo.yaml`.
   */
  function findSuiteFlowLine(doc: vscode.TextDocument, flowFile: string): number | undefined {
    const base = path.basename(flowFile);
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      if (/^\s*-\s+/.test(text) && (text.includes(flowFile) || text.includes(base))) {
        return i;
      }
    }
    return undefined;
  }

  async function handleSuiteOrParallelDone(
    workers: WorkerResult[] | undefined,
    passedCount: number,
    failedCount: number,
    success: boolean
  ) {
    const total = passedCount + failedCount;
    const label = success
      ? `Suite passed: ${passedCount}/${total}`
      : `Suite: ${passedCount}/${total} passed, ${failedCount} failed`;

    // Store failed flows for re-run
    lastFailedFlows = (workers ?? [])
      .filter((w) => !w.success && w.flowFile)
      .map((w) => w.flowFile!);

    // Add to history tree
    historyTree.addEntry({
      goal: lastSuiteFile ? `Suite: ${path.basename(lastSuiteFile)}` : 'Suite run',
      success,
      steps: (workers ?? []).reduce((sum, w) => sum + w.stepsExecuted, 0),
      timestamp: new Date(),
    });

    // Apply gutter decorations to the suite YAML editor (if visible)
    if (lastSuiteFile && workers && workers.length > 0) {
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.fsPath === lastSuiteFile
      );
      if (editor) {
        const passed: vscode.Range[] = [];
        const failed: vscode.Range[] = [];
        for (const w of workers) {
          if (!w.flowFile) {
            continue;
          }
          const lineIdx = findSuiteFlowLine(editor.document, w.flowFile);
          if (lineIdx === undefined) {
            continue;
          }
          const r = new vscode.Range(
            lineIdx,
            0,
            lineIdx,
            editor.document.lineAt(lineIdx).text.length
          );
          (w.success ? passed : failed).push(r);
        }
        editor.setDecorations(passedStepDecoration, passed);
        editor.setDecorations(failedStepDecoration, failed);
      }
    }

    // Show notification with action buttons
    const actions: string[] = ['View Report'];
    if (lastFailedFlows.length > 0) {
      actions.push('Re-run Failed');
    }

    const choice = await vscode.window.showInformationMessage(label, ...actions);
    if (choice === 'View Report') {
      vscode.commands.executeCommand('appclaw.viewReport');
    } else if (choice === 'Re-run Failed') {
      vscode.commands.executeCommand('appclaw.rerunFailed');
    }
  }

  // ─── Flow Step Highlighting ───────────────────────────
  /**
   * Find the line number for step N in a YAML file.
   * Steps are lines matching `- <action>` under setup:/steps:/assertions: sections.
   * Step indices are global across all sections.
   */
  function findStepLine(doc: vscode.TextDocument, stepIndex: number): number | undefined {
    let inSection = false;
    let count = 0;
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      if (/^\s*(setup|steps|assertions)\s*:/.test(text)) {
        inSection = true;
        continue;
      }
      if (inSection && /^\s*-\s+/.test(text)) {
        count++;
        if (count === stepIndex) {
          return i;
        }
      }
      // If we hit a non-indented, non-empty, non-comment line after a section, we've left it
      if (inSection && /^\S/.test(text) && text.trim() !== '') {
        inSection = false;
      }
    }
    return undefined;
  }

  function highlightFlowStep(stepIndex: number, status: 'running' | 'passed' | 'failed') {
    if (!activeFlowFilePath) {
      return;
    }
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === activeFlowFilePath
    );
    if (!editor) {
      return;
    }

    const line = findStepLine(editor.document, stepIndex);
    if (line === undefined) {
      return;
    }

    const range = new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length);

    if (status === 'running') {
      editor.setDecorations(runningStepDecoration, [range]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } else if (status === 'passed') {
      passedLines.push(line);
      editor.setDecorations(runningStepDecoration, []);
      editor.setDecorations(
        passedStepDecoration,
        passedLines.map((l) => new vscode.Range(l, 0, l, editor.document.lineAt(l).text.length))
      );
    } else if (status === 'failed') {
      failedLines.push(line);
      editor.setDecorations(runningStepDecoration, []);
      editor.setDecorations(
        failedStepDecoration,
        failedLines.map((l) => new vscode.Range(l, 0, l, editor.document.lineAt(l).text.length))
      );
    }
  }

  function clearFlowDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(runningStepDecoration, []);
      editor.setDecorations(passedStepDecoration, []);
      editor.setDecorations(failedStepDecoration, []);
    }
    passedLines = [];
    failedLines = [];
  }

  bridge.on('flow_step', (data) => {
    if (data.step && data.status) {
      highlightFlowStep(data.step, data.status);
    }
  });
  bridge.on('flow_done', () => {
    // Keep decorations for a few seconds so user can see the result, then clear
    setTimeout(() => clearFlowDecorations(), 5000);
  });

  // ─── CodeLens ─────────────────────────────────────────
  const codeLensProvider = new FlowCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: 'yaml', scheme: 'file' },
      codeLensProvider
    )
  );

  // ─── Autocomplete ───────────────────────────────────────
  const completionProvider = new FlowCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'yaml', scheme: 'file' },
      completionProvider,
      '.',
      '$',
      '{' // Trigger on ${ and .
    )
  );

  // ─── Commands ─────────────────────────────────────────

  // Run Goal — prompt for goal text, execute on device
  context.subscriptions.push(
    vscode.commands.registerCommand('appclaw.runGoal', async () => {
      const goal = await vscode.window.showInputBox({
        prompt: 'Enter a goal for AppClaw',
        placeHolder: 'e.g. "Open Settings and enable Wi-Fi"',
      });
      if (!goal) {
        return;
      }

      currentGoal = goal;
      outputChannel.show(true);
      outputChannel.appendLine(`\n--- Running goal: ${goal} ---`);

      // Open device panel and show loading state immediately
      const panel = DevicePanel.createOrShow(context.extensionUri, bridge);
      panel.setRunMode('single', 1);
      panel.showLoading('Running goal...');

      bridge.runGoal(goal);
      vscode.window.showInformationMessage(`AppClaw: Running "${goal}"`);
    })
  );

  // Run Flow — from file URI (context menu, codelens, or prompt)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'appclaw.runFlow',
      async (uriOrItem?: vscode.Uri | { uri: vscode.Uri }) => {
        let filePath: string | undefined;

        // Handle both Uri (from codelens/context menu) and FlowItem (from tree view inline button)
        const uri = uriOrItem instanceof vscode.Uri ? uriOrItem : uriOrItem?.uri;
        if (uri) {
          filePath = uri.fsPath;
        } else {
          // Try active editor
          const editor = vscode.window.activeTextEditor;
          if (editor && editor.document.languageId === 'yaml') {
            filePath = editor.document.uri.fsPath;
          }
        }

        // If still no file, prompt user to pick one
        if (!filePath) {
          const files = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'YAML Flow': ['yaml', 'yml'] },
          });
          if (!files || files.length === 0) {
            return;
          }
          filePath = files[0].fsPath;
        }

        currentGoal = `Flow: ${filePath.split('/').pop()}`;
        activeFlowFilePath = filePath;
        clearFlowDecorations();

        // Detect suite/parallel YAMLs — sets run mode and captures suite_done context
        let runMode: 'single' | 'multi' = 'single';
        let deviceCount = 1;
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const parallelMatch = content.match(/^\s*parallel\s*:\s*(\d+)/m);
          if (parallelMatch) {
            runMode = 'multi';
            deviceCount = parseInt(parallelMatch[1], 10);
          } else if (/^\s*flows\s*:/m.test(content)) {
            const flowLines = content.match(/^\s+-\s+\S+/gm);
            runMode = 'multi';
            deviceCount = flowLines?.length ?? 2;
            lastSuiteFile = filePath;
            lastFailedFlows = [];
          }
        } catch {
          /* ignore */
        }
        outputChannel.show(true);
        outputChannel.appendLine(`\n--- Running flow: ${filePath} ---`);

        // Open the YAML file so user can see step highlighting
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, true);

        const panel = DevicePanel.createOrShow(context.extensionUri, bridge);
        panel.setRunMode(runMode, deviceCount);
        panel.showLoading(`Running ${filePath.split('/').pop()}...`);

        bridge.runFlow(filePath);
      }
    )
  );

  // Run Flow Step — execute a single step from a flow file
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'appclaw.runFlowStep',
      async (uri: vscode.Uri, stepIndex: number) => {
        outputChannel.show(true);
        outputChannel.appendLine(`\n--- Running step ${stepIndex} from ${uri.fsPath} ---`);
        // For now, run the full flow — single-step execution requires CLI support
        // TODO: Add --step flag to appclaw CLI
        bridge.runFlow(uri.fsPath);
        vscode.window.showInformationMessage(`AppClaw: Running step ${stepIndex}`);
      }
    )
  );

  // Open Device Panel
  context.subscriptions.push(
    vscode.commands.registerCommand('appclaw.openDevicePanel', () => {
      DevicePanel.createOrShow(context.extensionUri, bridge);
    })
  );

  // Playground — opens an interactive REPL in the integrated terminal
  context.subscriptions.push(
    vscode.commands.registerCommand('appclaw.playground', () => {
      const { command, baseArgs } = getCliCommand();
      const env = getEnvFromSettings();

      const terminal = vscode.window.createTerminal({
        name: 'AppClaw Playground',
        env,
      });
      terminal.show();
      terminal.sendText(`${command} ${baseArgs.join(' ')} --playground`.trim());
    })
  );

  // Take Screenshot
  context.subscriptions.push(
    vscode.commands.registerCommand('appclaw.takeScreenshot', () => {
      vscode.window.showInformationMessage(
        'AppClaw: Screenshot capture requires an active agent session'
      );
    })
  );

  // View Report — open execution report in browser
  let reportServerProcess: ReturnType<typeof import('child_process').spawn> | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('appclaw.viewReport', async () => {
      const { command, baseArgs } = getCliCommand();
      const env = getEnvFromSettings();
      const port = vscode.workspace.getConfiguration('appclaw').get<number>('reportPort', 4173);

      // Check if server is already running
      try {
        const resp = await fetch(`http://localhost:${port}/health`);
        if (resp.ok) {
          vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
          return;
        }
      } catch {
        /* not running, start it */
      }

      const cp = await import('child_process');
      reportServerProcess = cp.spawn(
        command,
        [...baseArgs, '--report', '--report-port', String(port)],
        {
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          env: { ...process.env, ...env },
          stdio: 'ignore',
          detached: true,
        }
      );
      reportServerProcess.unref();

      // Give the server a moment to start
      await new Promise((r) => setTimeout(r, 1000));
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
      outputChannel.appendLine(`[appclaw] Report server started on http://localhost:${port}`);
    })
  );

  // Re-run Failed — write a temp suite YAML with only failed flows and execute it
  context.subscriptions.push(
    vscode.commands.registerCommand('appclaw.rerunFailed', async () => {
      if (lastFailedFlows.length === 0) {
        vscode.window.showWarningMessage('AppClaw: No failed flows to re-run.');
        return;
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const tmpDir = path.join(workspaceRoot, '.appclaw');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      const tmpFile = path.join(tmpDir, 'rerun-failed.yaml');

      // Emit relative paths so the CLI resolves them from the workspace root
      const relPaths = lastFailedFlows.map((f) =>
        path.isAbsolute(f) ? path.relative(workspaceRoot, f) : f
      );
      const yaml = `# Auto-generated: re-run of failed flows\nflows:\n${relPaths.map((f) => `  - ${f}`).join('\n')}\n`;
      fs.writeFileSync(tmpFile, yaml, 'utf8');

      lastSuiteFile = tmpFile;
      lastFailedFlows = [];
      outputChannel.show(true);
      outputChannel.appendLine(`\n--- Re-running ${relPaths.length} failed flow(s) ---`);
      bridge.runFlow(tmpFile);
    })
  );

  // Stop Execution
  context.subscriptions.push(
    vscode.commands.registerCommand('appclaw.stopExecution', () => {
      bridge.stop();
      vscode.window.showInformationMessage('AppClaw: Execution stopped');
    })
  );

  // Refresh tree views
  context.subscriptions.push(
    vscode.commands.registerCommand('appclaw.refreshDevices', () => {
      devicesTree.refresh();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('appclaw.refreshFlows', () => {
      flowsTree.refresh();
    })
  );

  // Show bridge exit in output
  bridge.on('exit', (code: number | null) => {
    outputChannel.appendLine(`--- Process exited (code: ${code}) ---`);
  });

  // ── Setting-change hints ──────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('appclaw.agentMode')) {
        const config = vscode.workspace.getConfiguration('appclaw');
        const agentMode = config.get<string>('agentMode', 'vision');
        if (agentMode === 'vision') {
          const llmProvider = config.get<string>('llmProvider', 'gemini');
          if (llmProvider === 'gemini') {
            vscode.window.showInformationMessage(
              'Vision mode enabled. Your LLM API Key will be reused for Stark vision automatically.'
            );
          } else {
            vscode.window
              .showInformationMessage(
                'Vision mode enabled. Set a Gemini API Key under Vision settings for Stark vision.',
                'Open Vision Settings'
              )
              .then((choice) => {
                if (choice) {
                  vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'appclaw.geminiApiKey'
                  );
                }
              });
          }
        }
      }
    })
  );

  outputChannel.appendLine('AppClaw extension activated');
}

export function deactivate(): void {
  bridge?.stop();
  outputChannel?.dispose();
}
