/**
 * Types for the Explorer Agent — PRD-driven flow generator.
 */

/** Extracted information from a PRD / use case description */
export interface PRDAnalysis {
  appName: string;
  appId?: string;
  platform: 'android' | 'ios' | 'unknown';
  features: AppFeature[];
  userJourneys: UserJourney[];
  reasoning: string;
}

export interface AppFeature {
  name: string;
  description: string;
  /** Key UI elements expected for this feature */
  expectedElements: string[];
}

export interface UserJourney {
  name: string;
  description: string;
  /** Ordered high-level steps */
  steps: string[];
  /** Priority: higher = more important to test */
  priority: 'high' | 'medium' | 'low';
}

/** A screen discovered during device crawling */
export interface CrawledScreen {
  id: string;
  /** Trimmed DOM snapshot */
  dom: string;
  /** Screenshot base64 (optional) */
  screenshot?: string;
  /** Tappable elements found on this screen */
  tappableElements: TappableElement[];
  /** Text content visible on screen */
  visibleTexts: string[];
  /** How we got to this screen */
  reachedVia?: { fromScreen: string; action: string };
}

export interface TappableElement {
  label: string;
  type: 'button' | 'link' | 'input' | 'tab' | 'icon' | 'other';
  bounds?: string;
}

/** Graph of screens and transitions discovered by the crawler */
export interface ScreenGraph {
  screens: CrawledScreen[];
  transitions: ScreenTransition[];
}

export interface ScreenTransition {
  fromScreen: string;
  toScreen: string;
  action: string;
  element: string;
}

/** A generated YAML flow */
export interface GeneratedFlow {
  name: string;
  description: string;
  yamlContent: string;
  journey: string;
}

/** Explorer agent configuration */
export interface ExplorerConfig {
  prd: string;
  numFlows: number;
  outputDir: string;
  /** Whether to crawl the device (requires MCP connection) */
  crawl: boolean;
  /** Max screens to explore during crawling */
  maxScreens: number;
  /** Max depth for screen exploration */
  maxDepth: number;
}
