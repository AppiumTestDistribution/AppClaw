/**
 * Device Preview Panel — webview showing live device screen,
 * goal input, and step execution log.
 */

import * as vscode from "vscode";
import { AppclawBridge } from "../bridge";

export class DevicePanel {
  public static currentPanel: DevicePanel | undefined;
  private static readonly viewType = "appclaw.devicePanel";

  private readonly panel: vscode.WebviewPanel;
  private readonly bridge: AppclawBridge;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    bridge: AppclawBridge
  ): DevicePanel {
    const column = vscode.ViewColumn.Beside;

    if (DevicePanel.currentPanel) {
      DevicePanel.currentPanel.panel.reveal(column);
      return DevicePanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      DevicePanel.viewType,
      "AppClaw Device",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    DevicePanel.currentPanel = new DevicePanel(panel, bridge);
    return DevicePanel.currentPanel;
  }

  private webviewReady = false;
  private pendingMessages: any[] = [];

  private constructor(panel: vscode.WebviewPanel, bridge: AppclawBridge) {
    this.panel = panel;
    this.bridge = bridge;

    // Read MJPEG config from settings
    const config = vscode.workspace.getConfiguration("appclaw");
    const mjpegEnabled = config.get<boolean>("mjpegEnabled", true);
    const mjpegHost = config.get<string>("mjpegHost", "127.0.0.1");
    const mjpegPortAndroid = config.get<number>("mjpegPortAndroid", 7810);
    const mjpegPortIos = config.get<number>("mjpegPortIos", 9100);

    this.panel.webview.html = this.getHtml({
      mjpegEnabled,
      mjpegHost,
      mjpegPortAndroid,
      mjpegPortIos,
    });

    // Forward ALL bridge events to webview
    const forwardEvent = (event: any) => {
      const msg = { type: "appclaw-event", event: event.event, data: event.data };
      if (this.webviewReady) {
        this.panel.webview.postMessage(msg);
      } else {
        this.pendingMessages.push(msg);
      }
    };
    bridge.on("event", forwardEvent);

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "webviewReady":
            // Webview signals it's ready — flush buffered messages
            this.webviewReady = true;
            for (const msg of this.pendingMessages) {
              this.panel.webview.postMessage(msg);
            }
            this.pendingMessages = [];
            break;
          case "runGoal": {
            const goalArgs: string[] = [];
            if (message.platform) { goalArgs.push("--platform", message.platform); }
            this.bridge.runGoal(message.goal, goalArgs);
            break;
          }
          case "startPlayground": {
            const pgArgs: string[] = [];
            if (message.platform) { pgArgs.push("--platform", message.platform); }
            this.bridge.startPlayground(pgArgs);
            break;
          }
          case "sendCommand":
            this.bridge.sendCommand(message.text);
            break;
          case "exportFlow": {
            const defaultUri = vscode.Uri.file(
              require("path").join(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require("os").homedir(),
                `flow-${Date.now()}.yaml`
              )
            );
            const uri = await vscode.window.showSaveDialog({
              defaultUri,
              filters: { "YAML files": ["yaml", "yml"] },
              title: "Export Flow",
            });
            if (uri) {
              this.bridge.sendCommand(`/export ${uri.fsPath}`);
            }
            break;
          }
          case "sendInput":
            this.bridge.sendInput(message.text);
            break;
          case "stop":
            this.bridge.stop();
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      bridge.removeListener("event", forwardEvent);
      this.dispose();
    }, null, this.disposables);
  }

  /** Show a loading state immediately when a flow/goal is triggered */
  public showLoading(label: string): void {
    const msg = { type: "appclaw-loading", label };
    if (this.webviewReady) {
      this.panel.webview.postMessage(msg);
    } else {
      this.pendingMessages.push(msg);
    }
  }

  public dispose(): void {
    DevicePanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }

  private getHtml(mjpeg: {
    mjpegEnabled: boolean;
    mjpegHost: string;
    mjpegPortAndroid: number;
    mjpegPortIos: number;
  }): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http://127.0.0.1:* http://localhost:* data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>AppClaw Device</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Header */
    .header {
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-yellow); }
    .status-dot.connected { background: var(--vscode-charts-green); }
    .status-dot.error { background: var(--vscode-charts-red); }
    .device-name { font-weight: 600; font-size: 12px; }
    .platform-badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

    /* Main split layout */
    .main-split {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    /* Left: device screen with frame */
    .device-pane {
      width: 38%;
      min-width: 220px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #1a1a2e;
      overflow: hidden;
      position: relative;
      padding: 20px;
    }
    /* Default idle state — no device frame, just a clean welcome */
    .device-pane.idle {
      background: linear-gradient(145deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    }
    .idle-welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      color: rgba(255,255,255,0.5);
      text-align: center;
      width: 100%;
      height: 100%;
    }
    .idle-welcome .idle-icon {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
    }
    .idle-welcome .idle-title {
      font-size: 15px;
      font-weight: 600;
      color: rgba(255,255,255,0.7);
    }
    .idle-welcome .idle-subtitle {
      font-size: 12px;
      color: rgba(255,255,255,0.35);
      line-height: 1.5;
    }
    .device-frame {
      position: relative;
      border-radius: 40px;
      border: 5px solid #3a3a3a;
      background: #000;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08);
      max-height: 100%;
      /* Phone aspect ratio — prevent tablet-like stretching */
      aspect-ratio: 9 / 19.5;
      max-width: 100%;
      width: auto;
      display: none;
      align-items: center;
      justify-content: center;
    }
    .device-frame.active {
      display: flex;
    }
    .device-frame.ios {
      border-radius: 40px;
      border: 5px solid #3a3a3a;
      aspect-ratio: 9 / 19.5;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08), inset 0 0 0 1px rgba(255,255,255,0.04);
    }
    .device-frame.android {
      border-radius: 24px;
      border: 4px solid #3a3a3a;
      aspect-ratio: 9 / 20;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08);
    }
    /* Home indicator for iOS */
    .device-frame.ios::after {
      content: "";
      position: absolute;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      width: 28%;
      height: 4px;
      background: #666;
      border-radius: 2px;
      z-index: 2;
    }
    .device-frame img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    /* Spinner for loading */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: var(--vscode-textLink-foreground);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      display: inline-block;
      vertical-align: middle;
    }

    /* Right: controls + log */
    .controls-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      border-left: 1px solid var(--vscode-panel-border);
      overflow: hidden;
    }

    /* Step log */
    .step-log {
      flex: 1;
      overflow-y: auto;
      font-size: 14px;
      font-family: var(--vscode-font-family);
    }
    .step-entry {
      padding: 8px 14px;
      display: flex;
      gap: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      line-height: 1.6;
    }
    .step-entry .step-num { color: var(--vscode-descriptionForeground); min-width: 32px; font-size: 13px; }
    .step-entry .step-action { color: var(--vscode-textLink-foreground); min-width: 90px; font-weight: 600; font-size: 13px; }
    .step-entry .step-msg { color: var(--vscode-foreground); flex: 1; word-break: break-word; font-size: 14px; }
    .step-entry.success .step-icon::before { content: "\\2713"; color: var(--vscode-charts-green); }
    .step-entry.failed .step-icon::before { content: "\\2717"; color: var(--vscode-charts-red); }
    .step-entry.running .step-icon::before { content: "\\25CB"; color: var(--vscode-charts-yellow); }

    /* Input area */
    .input-area {
      padding: 12px 14px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .input-area input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      font-size: 14px;
      outline: none;
    }
    .input-area input:focus { border-color: var(--vscode-focusBorder); }
    .input-area input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .input-area button {
      padding: 6px 14px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .btn-run { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-run:hover { background: var(--vscode-button-hoverBackground); }
    .btn-stop { background: var(--vscode-errorForeground); color: #fff; }
    .action-btn {
      background: none;
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-foreground);
      padding: 2px 7px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    }
    .action-btn:hover { background: var(--vscode-list-hoverBackground); }

    /* HITL overlay */
    .hitl-overlay { display: none; padding: 10px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; margin: 8px 10px; }
    .hitl-overlay.active { display: block; }
    .hitl-overlay .hitl-prompt { font-size: 12px; margin-bottom: 6px; color: var(--vscode-editorWarning-foreground); }
    .hitl-overlay .hitl-input-row { display: flex; gap: 6px; }

    @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

    /* Setup progress indicator */
    .setup-progress {
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .setup-step {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }
    .setup-step.active {
      color: var(--vscode-foreground);
    }
    .setup-step.done {
      color: var(--vscode-charts-green);
    }
    .setup-step .setup-icon {
      width: 18px;
      text-align: center;
      flex-shrink: 0;
    }
    .setup-step.active .setup-icon { animation: pulse 1.2s infinite; }
    .setup-step.pending { opacity: 0.4; }
  </style>
</head>
<body>
  <div class="header">
    <span class="status-dot" id="statusDot"></span>
    <span class="device-name" id="deviceName">No device connected</span>
    <span class="platform-badge" id="platformBadge" style="display:none"></span>
  </div>

  <div class="main-split">
    <!-- Left: Device screen -->
    <div class="device-pane idle" id="devicePane">
      <!-- Idle welcome (shown when no device connected) -->
      <div class="idle-welcome" id="idleWelcome">
        <div class="idle-icon">&#128241;</div>
        <div class="idle-title">AppClaw</div>
        <div class="idle-subtitle">Enter a goal or switch to<br>Playground to connect a device</div>
      </div>
      <!-- Device frame (shown when device is connected) -->
      <div class="device-frame" id="deviceFrame">
        <img id="mjpegStream" style="display:none;" />
      </div>
    </div>

    <!-- Right: Controls + Step log -->
    <div class="controls-pane">
      <div class="step-log" id="stepLog"></div>

      <div class="hitl-overlay" id="hitlOverlay">
        <div class="hitl-prompt" id="hitlPrompt"></div>
        <div class="hitl-input-row">
          <input type="text" id="hitlInput" placeholder="Enter response...">
          <button class="btn-run" onclick="submitHitl()">Send</button>
        </div>
      </div>

      <div id="debugLog" style="font-size:10px;color:var(--vscode-descriptionForeground);padding:3px 10px;max-height:40px;overflow-y:auto;border-top:1px solid var(--vscode-panel-border);font-family:monospace;"></div>

      <div class="input-area">
        <div style="display:flex;gap:6px;align-items:center;">
          <div id="modeToggle" style="display:flex;border-radius:4px;overflow:hidden;border:1px solid var(--vscode-input-border);font-size:11px;cursor:pointer;">
            <span id="modeGoal" onclick="setMode('goal')" style="padding:2px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);">Goal</span>
            <span id="modePlayground" onclick="setMode('playground')" style="padding:2px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);">Playground</span>
          </div>
          <div id="platformToggle" style="display:flex;border-radius:4px;overflow:hidden;border:1px solid var(--vscode-input-border);font-size:11px;cursor:pointer;">
            <span id="platAndroid" onclick="setPlatform('android')" style="padding:2px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);">Android</span>
            <span id="platIos" onclick="setPlatform('ios')" style="padding:2px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);">iOS</span>
          </div>
          <span id="modeHint" style="font-size:10px;color:var(--vscode-descriptionForeground);flex:1;">AI agent executes your goal</span>
          <span id="playgroundActions" style="display:none;">
            <button class="action-btn" onclick="sendSlash('/yaml')">YAML</button>
            <button class="action-btn" onclick="exportFlow()">Export</button>
            <button class="action-btn" onclick="sendSlash('/undo')">Undo</button>
            <button class="action-btn" onclick="sendSlash('/clear')">Clear</button>
          </span>
        </div>
        <div style="display:flex;gap:6px;">
          <input type="text" id="goalInput" placeholder="Enter a goal... e.g. &quot;Open Settings and enable Wi-Fi&quot;" />
          <button class="btn-run" id="runBtn" onclick="handleRun()">Run</button>
          <button class="btn-stop" id="stopBtn" onclick="stopExecution()" style="display:none">Stop</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let isRunning = false;
    let currentMode = "goal"; // "goal" or "playground"
    let playgroundConnected = false;
    let commandInFlight = false; // true while a playground command is being executed

    // MJPEG config injected from extension settings
    const MJPEG = ${JSON.stringify(mjpeg)};

    const goalInput = document.getElementById("goalInput");
    const runBtn = document.getElementById("runBtn");
    const stopBtn = document.getElementById("stopBtn");
    const stepLog = document.getElementById("stepLog");
    const statusDot = document.getElementById("statusDot");
    const deviceName = document.getElementById("deviceName");
    const platformBadge = document.getElementById("platformBadge");
    const devicePane = document.getElementById("devicePane");
    const idleWelcome = document.getElementById("idleWelcome");
    const deviceFrame = document.getElementById("deviceFrame");
    const mjpegStream = document.getElementById("mjpegStream");
    const hitlOverlay = document.getElementById("hitlOverlay");
    const hitlPrompt = document.getElementById("hitlPrompt");
    const hitlInput = document.getElementById("hitlInput");
    const platAndroid = document.getElementById("platAndroid");
    const platIos = document.getElementById("platIos");
    const platformToggle = document.getElementById("platformToggle");
    let selectedPlatform = ""; // "" = use settings default

    function setPlatform(platform) {
      if (selectedPlatform === platform) {
        // Deselect — go back to default (from settings)
        selectedPlatform = "";
        platAndroid.style.background = "var(--vscode-input-background)";
        platAndroid.style.color = "var(--vscode-input-foreground)";
        platIos.style.background = "var(--vscode-input-background)";
        platIos.style.color = "var(--vscode-input-foreground)";
        return;
      }
      selectedPlatform = platform;
      if (platform === "android") {
        platAndroid.style.background = "var(--vscode-button-background)";
        platAndroid.style.color = "var(--vscode-button-foreground)";
        platIos.style.background = "var(--vscode-input-background)";
        platIos.style.color = "var(--vscode-input-foreground)";
      } else {
        platIos.style.background = "var(--vscode-button-background)";
        platIos.style.color = "var(--vscode-button-foreground)";
        platAndroid.style.background = "var(--vscode-input-background)";
        platAndroid.style.color = "var(--vscode-input-foreground)";
      }
    }

    /** Get selected platform (empty = use settings default) */
    function getSelectedPlatform() {
      return selectedPlatform || undefined;
    }

    /** Switch device pane between idle welcome and active device frame */
    function showDeviceScreen() {
      devicePane.classList.remove("idle");
      idleWelcome.style.display = "none";
      deviceFrame.classList.add("active");
    }
    function showIdleWelcome() {
      devicePane.classList.add("idle");
      idleWelcome.style.display = "";
      idleWelcome.innerHTML =
        '<div class="idle-icon">&#128241;</div>' +
        '<div class="idle-title">AppClaw</div>' +
        '<div class="idle-subtitle">Enter a goal or switch to<br>Playground to connect a device</div>';
      deviceFrame.classList.remove("active");
      mjpegStream.src = "";
      mjpegStream.style.display = "none";
    }

    goalInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (currentMode === "playground") {
          sendPlaygroundCommand();
        } else if (!isRunning) {
          runGoal();
        }
      }
    });

    hitlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitHitl();
    });

    function setMode(mode) {
      currentMode = mode;
      const modeGoal = document.getElementById("modeGoal");
      const modePlayground = document.getElementById("modePlayground");
      const modeHint = document.getElementById("modeHint");

      var playgroundActions = document.getElementById("playgroundActions");

      if (mode === "goal") {
        modeGoal.style.background = "var(--vscode-button-background)";
        modeGoal.style.color = "var(--vscode-button-foreground)";
        modePlayground.style.background = "var(--vscode-input-background)";
        modePlayground.style.color = "var(--vscode-input-foreground)";
        goalInput.placeholder = 'Enter a goal... e.g. "Open Settings and enable Wi-Fi"';
        modeHint.textContent = "AI agent executes your goal";
        runBtn.textContent = "Run";
        playgroundActions.style.display = "none";
        // Stop playground session if running
        if (playgroundConnected) {
          vscode.postMessage({ command: "stop" });
          playgroundConnected = false;
        }
      } else {
        modePlayground.style.background = "var(--vscode-button-background)";
        modePlayground.style.color = "var(--vscode-button-foreground)";
        modeGoal.style.background = "var(--vscode-input-background)";
        modeGoal.style.color = "var(--vscode-input-foreground)";
        goalInput.placeholder = 'tap "Login", type "hello", swipe down, open YouTube...';
        modeHint.textContent = "Commands run directly on device";
        playgroundActions.style.display = "";
        // If already connected, show Send button; otherwise show Connect button
        if (playgroundConnected) {
          runBtn.textContent = "Send";
        } else {
          runBtn.textContent = "Connect";
          goalInput.placeholder = "Select platform above, then click Connect";
          goalInput.disabled = true;
        }
      }
    }

    function handleRun() {
      if (currentMode === "playground") {
        if (!playgroundConnected) {
          // Connect to device — start playground session
          connectPlayground();
        } else {
          sendPlaygroundCommand();
        }
      } else {
        runGoal();
      }
    }

    function connectPlayground() {
      stepLog.innerHTML = "";
      statusDot.className = "status-dot";
      deviceName.textContent = "Connecting to device...";
      idleWelcome.innerHTML = '<div class="idle-icon" style="animation:pulse 1.5s infinite;">&#128241;</div><div class="idle-title">Connecting...</div><div class="idle-subtitle">Starting playground session<br>This may take a moment</div>';
      vscode.postMessage({ command: "startPlayground", platform: getSelectedPlatform() });
      playgroundConnected = true;
      setRunning(true);
      runBtn.textContent = "Send";
      goalInput.placeholder = 'tap "Login", type "hello", swipe down, open YouTube...';
      goalInput.disabled = false;
    }

    function runGoal() {
      const goal = goalInput.value.trim();
      if (!goal) return;
      stepLog.innerHTML = "";
      setRunning(true);
      vscode.postMessage({ command: "runGoal", goal, platform: getSelectedPlatform() });
    }

    let pendingCommandId = 0;
    function sendPlaygroundCommand() {
      const cmd = goalInput.value.trim();
      if (!cmd || commandInFlight) return;
      // Show a "running" entry immediately so user sees feedback
      if (!cmd.startsWith("/")) {
        pendingCommandId++;
        commandInFlight = true;
        setPlaygroundBusy(true);
        addStepEntry("...", cmd.split(" ")[0], cmd, "running", "pending-cmd-" + pendingCommandId);
      }
      vscode.postMessage({ command: "sendCommand", text: cmd });
      goalInput.value = "";
    }

    function setPlaygroundBusy(busy) {
      commandInFlight = busy;
      runBtn.disabled = busy;
      goalInput.disabled = busy;
      if (busy) {
        runBtn.style.opacity = "0.5";
        runBtn.style.cursor = "not-allowed";
        goalInput.placeholder = "Executing command...";
      } else {
        runBtn.style.opacity = "";
        runBtn.style.cursor = "";
        goalInput.placeholder = 'tap "Login", type "hello", swipe down, open YouTube...';
        goalInput.disabled = false;
        goalInput.focus();
      }
    }

    function sendSlash(cmd) {
      vscode.postMessage({ command: "sendCommand", text: cmd });
    }

    function exportFlow() {
      vscode.postMessage({ command: "exportFlow" });
    }

    function stopExecution() {
      vscode.postMessage({ command: "stop" });
      setRunning(false);
      playgroundConnected = false;
      resetPanel();
    }

    function resetPanel() {
      statusDot.className = "status-dot";
      deviceName.textContent = "No device connected";
      platformBadge.style.display = "none";
      showIdleWelcome();
      goalInput.value = "";
    }

    function submitHitl() {
      const text = hitlInput.value.trim();
      if (!text) return;
      vscode.postMessage({ command: "sendInput", text });
      hitlOverlay.classList.remove("active");
      hitlInput.value = "";
    }

    function setRunning(running) {
      isRunning = running;
      // Disable platform toggle while a session is active
      platformToggle.style.pointerEvents = running ? "none" : "";
      platformToggle.style.opacity = running ? "0.5" : "";
      if (currentMode === "playground") {
        // In playground mode: always show Send + Stop, keep input enabled
        runBtn.style.display = "";
        stopBtn.style.display = running ? "" : "none";
        goalInput.disabled = false;
      } else {
        runBtn.style.display = running ? "none" : "";
        stopBtn.style.display = running ? "" : "none";
        goalInput.disabled = running;
      }
    }

    function addStepEntry(step, action, message, status, id) {
      // If an ID is given, check for an existing pending entry to replace
      if (id) {
        var existing = document.getElementById(id);
        if (existing) {
          existing.className = "step-entry " + status;
          existing.innerHTML =
            '<span class="step-icon"></span>' +
            '<span class="step-num">#' + step + '</span>' +
            '<span class="step-action">' + escapeHtml(action) + '</span>' +
            '<span class="step-msg">' + escapeHtml(message) + '</span>';
          stepLog.scrollTop = stepLog.scrollHeight;
          return;
        }
      }
      const entry = document.createElement("div");
      entry.className = "step-entry " + status;
      if (id) entry.id = id;
      // Show spinner for running state
      if (status === "running") {
        entry.innerHTML =
          '<span class="spinner"></span>' +
          '<span class="step-num">#' + step + '</span>' +
          '<span class="step-action">' + escapeHtml(action) + '</span>' +
          '<span class="step-msg">' + escapeHtml(message) + '</span>';
      } else {
        entry.innerHTML =
          '<span class="step-icon"></span>' +
          '<span class="step-num">#' + step + '</span>' +
          '<span class="step-action">' + escapeHtml(action) + '</span>' +
          '<span class="step-msg">' + escapeHtml(message) + '</span>';
      }
      stepLog.appendChild(entry);
      stepLog.scrollTop = stepLog.scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text || "";
      return div.innerHTML;
    }

    /** Remove setup progress indicator when execution starts */
    function clearSetupProgress() {
      var setupEl = document.getElementById("setupProgress");
      if (setupEl) {
        setupEl.remove();
      }
    }

    const debugLog = document.getElementById("debugLog");
    function debug(text) {
      const line = document.createElement("div");
      line.textContent = new Date().toLocaleTimeString() + " " + text;
      debugLog.appendChild(line);
      debugLog.scrollTop = debugLog.scrollHeight;
    }
    debug("webview ready, sending ready signal");
    vscode.postMessage({ command: "webviewReady" });

    // Handle messages from extension
    window.addEventListener("message", (event) => {
      const msg = event.data;
      debug("recv: " + JSON.stringify(msg).substring(0, 120));

      // Loading indicator — triggered immediately when flow/goal starts
      if (msg.type === "appclaw-loading") {
        statusDot.className = "status-dot";
        statusDot.style.animation = "pulse 1.2s infinite";
        deviceName.textContent = msg.label || "Starting...";
        // Update left pane to show loading state
        idleWelcome.innerHTML =
          '<div class="idle-icon" style="animation:pulse 1.5s infinite;"><span class="spinner" style="width:28px;height:28px;border-width:3px;"></span></div>' +
          '<div class="idle-title">Setting up device...</div>' +
          '<div class="idle-subtitle">Launching MCP server and<br>connecting to your device</div>';
        stepLog.innerHTML = '<div class="setup-progress" id="setupProgress">' +
          '<div class="setup-step active"><span class="setup-icon"><span class="spinner"></span></span> Starting MCP server...</div>' +
          '<div class="setup-step pending"><span class="setup-icon">&#9675;</span> Connecting to device</div>' +
          '<div class="setup-step pending"><span class="setup-icon">&#9675;</span> Starting MJPEG stream</div>' +
          '<div class="setup-step pending"><span class="setup-icon">&#9675;</span> Executing steps</div>' +
          '</div>';
        setRunning(true);
        return;
      }

      if (msg.type !== "appclaw-event") return;

      switch (msg.event) {
        case "connected":
          // MCP connected — update setup progress
          statusDot.style.animation = "";
          statusDot.className = "status-dot connected";
          deviceName.textContent = "Setting up...";
          stepLog.innerHTML = '<div class="setup-progress" id="setupProgress">' +
            '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Connected to MCP server</div>' +
            '<div class="setup-step active"><span class="setup-icon"><span class="spinner"></span></span> Detecting device...</div>' +
            '<div class="setup-step pending"><span class="setup-icon">&#9675;</span> Starting MJPEG stream</div>' +
            '<div class="setup-step pending"><span class="setup-icon">&#9675;</span> Ready to execute</div>' +
            '</div>';
          break;

        case "device_ready":
          statusDot.className = "status-dot connected";
          deviceName.textContent = msg.data.device || "Device Ready";
          platformBadge.textContent = msg.data.platform;
          platformBadge.style.display = "";

          // Update setup progress
          var setupEl = document.getElementById("setupProgress");
          if (setupEl) {
            setupEl.innerHTML =
              '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Connected to MCP server</div>' +
              '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Device: ' + escapeHtml(msg.data.device || msg.data.platform) + '</div>' +
              '<div class="setup-step active"><span class="setup-icon"><span class="spinner"></span></span> Starting MJPEG stream</div>' +
              '<div class="setup-step pending"><span class="setup-icon">&#9675;</span> Ready to execute</div>';
          }

          // Apply device frame style based on platform and show it
          deviceFrame.className = "device-frame active " + (msg.data.platform === "ios" ? "ios" : "android");
          showDeviceScreen();

          // Start/reconnect MJPEG live stream (cache-bust for new sessions)
          if (MJPEG.mjpegEnabled) {
            const port = msg.data.platform === "ios"
              ? MJPEG.mjpegPortIos
              : MJPEG.mjpegPortAndroid;
            const url = "http://" + MJPEG.mjpegHost + ":" + port + "?t=" + Date.now();
            debug("Starting MJPEG stream: " + url);
            mjpegStream.src = url;
            mjpegStream.style.display = "";
            mjpegStream.onload = function() {
              // MJPEG stream connected — mark setup as ready
              debug("MJPEG stream connected");
              var sp = document.getElementById("setupProgress");
              if (sp) {
                sp.innerHTML =
                  '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Connected to MCP server</div>' +
                  '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Device: ' + escapeHtml(msg.data.device || msg.data.platform) + '</div>' +
                  '<div class="setup-step done"><span class="setup-icon">&#10003;</span> MJPEG stream connected</div>' +
                  '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Ready to execute</div>';
              }
            };
            mjpegStream.onerror = function() {
              debug("MJPEG stream error — falling back to screenshots");
              mjpegStream.style.display = "none";
              // Mark MJPEG as skipped but still ready
              var sp = document.getElementById("setupProgress");
              if (sp) {
                sp.innerHTML =
                  '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Connected to MCP server</div>' +
                  '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Device: ' + escapeHtml(msg.data.device || msg.data.platform) + '</div>' +
                  '<div class="setup-step failed"><span class="setup-icon">&#10007;</span> MJPEG stream unavailable (using screenshots)</div>' +
                  '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Ready to execute</div>';
              }
            };
          } else {
            // MJPEG disabled — skip straight to ready
            var sp2 = document.getElementById("setupProgress");
            if (sp2) {
              sp2.innerHTML =
                '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Connected to MCP server</div>' +
                '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Device: ' + escapeHtml(msg.data.device || msg.data.platform) + '</div>' +
                '<div class="setup-step done"><span class="setup-icon">&#10003;</span> Ready to execute</div>';
            }
          }
          break;

        case "plan":
          clearSetupProgress();
          if (msg.data.isComplex) {
            addStepEntry("plan", "decomposed", msg.data.subGoals.length + " sub-goals", "running");
          }
          break;

        case "goal_start":
          clearSetupProgress();
          addStepEntry(
            (msg.data.subGoalIndex + 1) + "/" + msg.data.totalSubGoals,
            "goal",
            msg.data.goal,
            "running"
          );
          break;

        case "step":
          clearSetupProgress();
          // Replace the pending "running" command entry if one exists
          var pendingEl = document.querySelector("[id^='pending-cmd-']");
          if (pendingEl) {
            pendingEl.className = "step-entry " + (msg.data.success ? "success" : "failed");
            pendingEl.innerHTML =
              '<span class="step-icon"></span>' +
              '<span class="step-num">#' + msg.data.step + '</span>' +
              '<span class="step-action">' + escapeHtml(msg.data.action) + '</span>' +
              '<span class="step-msg">' + escapeHtml(msg.data.target || msg.data.message) + '</span>';
            pendingEl.removeAttribute("id");
            stepLog.scrollTop = stepLog.scrollHeight;
          } else {
            addStepEntry(
              msg.data.step,
              msg.data.action,
              msg.data.target || msg.data.message,
              msg.data.success ? "success" : "failed"
            );
          }
          // Show getInfo response as a detail block below the step
          if (msg.data.action === "getInfo" && msg.data.success && msg.data.message) {
            var infoEntry = document.createElement("div");
            infoEntry.className = "step-entry success";
            infoEntry.innerHTML = '<pre style="margin:0;padding:8px 12px;font-size:11px;white-space:pre-wrap;color:var(--vscode-foreground);background:var(--vscode-textBlockQuote-background);border-radius:4px;max-height:150px;overflow-y:auto;">' + escapeHtml(msg.data.message) + '</pre>';
            stepLog.appendChild(infoEntry);
            stepLog.scrollTop = stepLog.scrollHeight;
          }
          // Re-enable input in playground mode
          if (currentMode === "playground" && commandInFlight) {
            setPlaygroundBusy(false);
          }
          break;

        case "flow_step":
          clearSetupProgress();
          if (msg.data.kind === "yaml" && msg.data.status === "passed") {
            // Show YAML in a pre-formatted block
            var yamlEntry = document.createElement("div");
            yamlEntry.className = "step-entry success";
            yamlEntry.innerHTML = '<pre style="margin:0;padding:8px 12px;font-size:11px;white-space:pre-wrap;color:var(--vscode-foreground);background:var(--vscode-textBlockQuote-background);border-radius:4px;max-height:200px;overflow-y:auto;">' + escapeHtml(msg.data.target) + '</pre>';
            stepLog.appendChild(yamlEntry);
            stepLog.scrollTop = stepLog.scrollHeight;
          } else if (msg.data.kind === "export" && msg.data.status === "passed") {
            addStepEntry("export", "saved", msg.data.target, "success");
          } else {
            var flowStatus = msg.data.status === "passed" ? "success" : msg.data.status === "failed" ? "failed" : "running";
            var flowStepId = "flow-step-" + msg.data.step;
            addStepEntry(
              msg.data.step + "/" + msg.data.total,
              msg.data.kind,
              msg.data.target || "",
              flowStatus,
              flowStepId
            );
            // Show getInfo response as an expandable detail block
            if (msg.data.kind === "getInfo" && msg.data.status === "passed" && msg.data.message) {
              var infoEntry = document.createElement("div");
              infoEntry.className = "step-entry success";
              infoEntry.innerHTML = '<pre style="margin:0;padding:8px 12px;font-size:11px;white-space:pre-wrap;color:var(--vscode-foreground);background:var(--vscode-textBlockQuote-background);border-radius:4px;max-height:150px;overflow-y:auto;">' + escapeHtml(msg.data.message) + '</pre>';
              stepLog.appendChild(infoEntry);
              stepLog.scrollTop = stepLog.scrollHeight;
            }
          }
          break;

        case "screen":
          // Only use base64 screenshots as fallback when MJPEG isn't streaming
          if (msg.data.screenshot && mjpegStream.style.display === "none") {
            showDeviceScreen();
            mjpegStream.src = "data:image/png;base64," + msg.data.screenshot;
            mjpegStream.style.display = "";
          }
          break;

        case "goal_done":
          addStepEntry(
            "done",
            msg.data.success ? "passed" : "failed",
            msg.data.reason || msg.data.goal,
            msg.data.success ? "success" : "failed"
          );
          break;

        case "flow_done":
        case "done":
          setRunning(false);
          if (msg.data && !msg.data.success) {
            statusDot.className = "status-dot error";
          }
          // Reset device screen after a delay, but keep step log for review
          setTimeout(function() {
            statusDot.className = "status-dot";
            statusDot.style.animation = "";
            deviceName.textContent = "No device connected";
            platformBadge.style.display = "none";
            showIdleWelcome();
          }, 3000);
          break;

        case "hitl":
          hitlPrompt.textContent = msg.data.prompt;
          hitlOverlay.classList.add("active");
          hitlInput.focus();
          break;

        case "error":
          statusDot.className = "status-dot error";
          addStepEntry("!", "error", msg.data.message, "failed");
          if (currentMode === "playground" && commandInFlight) {
            setPlaygroundBusy(false);
          }
          setRunning(false);
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}
