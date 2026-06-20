/**
 * Ink theme — color palette, symbols and action icons for the TUI.
 *
 * Structure ported from the kane-cli-ux-sim reference, recolored to AppClaw's
 * brand (#FC8EAC flamingo pink / #9CC6F5 step-blue) so the Ink UI matches the
 * existing plain-console theme in terminal.ts.
 */

export const COLORS = {
  brand: '#FC8EAC', // primary / focus (AppClaw flamingo pink)
  step: '#9CC6F5', // step accent (blue)
  cyan: '#00d4ff',
  green: '#22C55E',
  greenDim: '#2d8a4e',
  yellow: '#f0c040',
  red: '#ef4444',
  redDim: '#a33',
  label: '#9CA3AF',
  dimmed: '#666666',
  muted: '#444444',
  white: '#e6e6e6',
} as const;

/** Status → color, for step rows and the status bar. */
export const statusColors: Record<string, string> = {
  done: COLORS.green,
  passed: COLORS.green,
  failed: COLORS.red,
  running: COLORS.brand,
  starting: COLORS.cyan,
  pending: COLORS.dimmed,
  stopped: COLORS.dimmed,
};

/** Action type → glyph shown on a completed step row. */
export const ACTION_ICONS: Record<string, string> = {
  click: '●',
  type: '⊞',
  scroll: '↕',
  swipe: '↕',
  drag: '↔',
  navigate: '→',
  launch: '↗',
  analyze: '◎',
  assert: '◈',
  select: '▼',
  press_key: '↵',
  back: '‹',
  home: '⌂',
  wait: '…',
  tool_call: '⚡',
  done: '✓',
} as const;

export function getActionIcon(actionType?: string): string {
  return actionType ? (ACTION_ICONS[actionType] ?? '●') : '●';
}

/**
 * Map an agent tool name to an action type (for the icon + label).
 * Mirrors the verb mapping in terminal.ts `printStep`.
 */
export function toolToActionType(toolName: string): string {
  switch (toolName) {
    case 'find_and_click':
    case 'tap':
      return 'click';
    case 'find_and_type':
    case 'type':
      return 'type';
    case 'find_and_long_press':
      return 'click';
    case 'swipe':
    case 'scrollAssert':
      return 'scroll';
    case 'drag':
      return 'drag';
    case 'launch_app':
    case 'openApp':
      return 'launch';
    case 'go_back':
      return 'back';
    case 'go_home':
      return 'home';
    case 'press_enter':
    case 'enter':
      return 'press_key';
    case 'done':
      return 'done';
    case 'assert':
      return 'assert';
    default:
      return toolName.startsWith('appium_') ? 'tool_call' : 'navigate';
  }
}

/** Short verb word for a tool, shown as the step label. */
export function toolToVerb(toolName: string): string {
  switch (toolName) {
    case 'find_and_click':
      return 'tap';
    case 'find_and_type':
      return 'type';
    case 'find_and_long_press':
      return 'long-press';
    case 'launch_app':
      return 'launch';
    case 'go_back':
      return 'back';
    case 'go_home':
      return 'home';
    case 'press_enter':
      return 'enter';
    case 'done':
      return 'done';
    default:
      return toolName;
  }
}

export const symbols = {
  check: '✓',
  cross: '✗',
  warning: '⚠',
  diamond: '◆',
  circle: '●',
  circleEmpty: '○',
  arrow: '→',
  arrowDown: '↳',
  ellipsis: '…',
  dot: '·',
  pipe: '│',
  bar: '┃',
  prompt: '❯',
} as const;
