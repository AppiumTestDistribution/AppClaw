/** Unified UI element — normalized from both Android and iOS page source XML */
export interface UIElement {
  /** resource-id (Android) or name (iOS) */
  id: string;
  /** Accessibility ID for stable locating */
  accessibilityId: string;
  /** Visible text (text/content-desc on Android, label on iOS) */
  text: string;
  /** Element class name (e.g. "Button", "XCUIElementTypeButton") */
  type: string;
  /** Raw bounds string */
  bounds: string;
  /** Center coordinates [x, y] */
  center: [number, number];
  /** Element size [width, height] */
  size: [number, number];
  clickable: boolean;
  editable: boolean;
  enabled: boolean;
  checked: boolean;
  focused: boolean;
  selected: boolean;
  scrollable: boolean;
  longClickable: boolean;
  /** Hint/placeholder text */
  hint: string;
  /** Suggested action for the LLM */
  action: 'tap' | 'type' | 'longpress' | 'scroll' | 'read';
  /** Parent element label for context */
  parent: string;
  /** Depth in the element tree */
  depth: number;
  /** Source platform */
  platform: 'android' | 'ios';
}

/** Compact representation sent to the LLM — minimal tokens */
export interface CompactUIElement {
  text: string;
  id: string;
  center: [number, number];
  action: UIElement['action'];
  // Only included when non-default
  enabled?: false;
  /** true = ON, false = OFF (only shown for toggle/switch/checkbox elements) */
  checked?: boolean;
  focused?: true;
  hint?: string;
  editable?: true;
  scrollable?: true;
}

/** Full screen state from perception */
export interface ScreenState {
  /** @deprecated Legacy parsed elements — only populated when recorder is active */
  elements: UIElement[];
  /** @deprecated Legacy filtered elements — only populated when recorder is active */
  filtered: CompactUIElement[];
  /** Trimmed DOM XML — compact representation sent directly to LLM */
  dom: string;
  /** Total elements in the trimmed DOM */
  elementCount: number;
  /** Number of editable fields in the trimmed DOM (pre-computed by trimmer) */
  editableCount: number;
  screenshot?: string;
  platform: 'android' | 'ios';
  raw: string;
}
