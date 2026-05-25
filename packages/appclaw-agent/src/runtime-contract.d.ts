declare module 'appclaw/agent-runtime' {
  export type Platform = 'android' | 'ios';
  export type DeviceType = 'simulator' | 'real';

  export interface AgentOpenOptions {
    app: string;
    platform: Platform;
    deviceType?: DeviceType;
    device?: string;
    udid?: string;
  }

  export type AgentSelector =
    | { kind: 'id'; value: string }
    | { kind: 'accessibility'; value: string }
    | { kind: 'text'; value: string };

  export interface AgentTarget {
    selector?: AgentSelector;
    coordinates?: [number, number];
  }

  export interface AgentElement {
    type: string;
    text: string;
    id: string;
    accessibilityId: string;
    center: [number, number];
    bounds: string;
    action: 'tap' | 'type' | 'longpress' | 'scroll' | 'read';
    enabled: boolean;
    checked: boolean;
    focused: boolean;
    selector?: AgentSelector;
  }

  export interface AgentSnapshot {
    platform: Platform;
    elements: AgentElement[];
  }

  export interface AgentActionResult {
    success: boolean;
    message: string;
    value?: unknown;
  }

  export class AgentRuntimeSession {
    readonly sessionId: string;
    static open(options: AgentOpenOptions): Promise<AgentRuntimeSession>;
    close(): Promise<void>;
    snapshot(interactiveOnly?: boolean, maxElements?: number): Promise<AgentSnapshot>;
    press(target: AgentTarget): Promise<AgentActionResult>;
    fill(target: AgentTarget, text: string): Promise<AgentActionResult>;
    longpress(target: AgentTarget, duration?: number): Promise<AgentActionResult>;
    swipe(direction: 'up' | 'down' | 'left' | 'right'): Promise<AgentActionResult>;
    swipeElement(target: AgentTarget, direction: 'up' | 'down' | 'left' | 'right'): Promise<AgentActionResult>;
    pressKey(key: 'BACK' | 'HOME' | 'ENTER'): Promise<AgentActionResult>;
    getText(target: AgentTarget): Promise<AgentActionResult>;
    getAttrs(target: AgentTarget): Promise<AgentActionResult>;
    isVisible(target: AgentTarget | string): Promise<AgentActionResult>;
    waitFor(
      condition: 'visible' | 'gone',
      target: AgentTarget | string,
      timeoutMs?: number
    ): Promise<AgentActionResult>;
    isVisionConfigured(): boolean;
    saveScreenshot(path: string): Promise<AgentActionResult>;
    visionPress(description: string): Promise<AgentActionResult>;
    visionVisible(description: string): Promise<AgentActionResult>;
    visionInfo(description: string): Promise<AgentActionResult>;
  }
}
