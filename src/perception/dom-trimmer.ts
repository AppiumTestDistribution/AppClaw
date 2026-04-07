/**
 * Lightweight DOM trimmer — converts verbose Appium page source XML
 * into a compact, flat XML representation for direct LLM consumption.
 *
 * Instead of parsing into intermediate UIElement objects, this produces
 * a minimal XML string that the LLM reads directly to pick locators.
 *
 * Typical compression: 50KB raw XML → 3-8KB trimmed (~800-2000 tokens).
 */

import { XMLParser } from 'fast-xml-parser';

interface TrimmedNode {
  tag: string;
  attrs: Record<string, string>;
  score: number;
}

/** Result of trimDOM — compact XML plus pre-computed element counts. */
export interface TrimDOMResult {
  xml: string;
  /** Total elements in the trimmed output */
  elementCount: number;
  /** Number of editable fields in the trimmed output */
  editableCount: number;
}

/**
 * Trim a raw Appium page source XML into compact, flat XML.
 * Returns a <screen> element containing only meaningful elements,
 * plus pre-computed element counts for downstream use.
 */
export function trimDOM(
  xmlContent: string,
  platform: 'android' | 'ios',
  maxElements: number = 80
): TrimDOMResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(xmlContent);
  } catch {
    return {
      xml: '<screen><!-- Failed to parse page source --></screen>',
      elementCount: 0,
      editableCount: 0,
    };
  }

  const nodes: TrimmedNode[] = [];

  if (platform === 'android') {
    walkAndroid(parsed, nodes);
  } else {
    walkIOS(parsed, nodes);
  }

  // Sort by relevance score and take top N
  nodes.sort((a, b) => b.score - a.score);
  const top = nodes.slice(0, maxElements);

  // Count element types for the screen summary annotation.
  // This gives the LLM instant awareness of screen complexity (~15 tokens)
  // without an extra LLM call — a lightweight "room label".
  const interactiveCount = top.filter(
    (n) =>
      n.attrs.clickable === 'true' || n.attrs.editable === 'true' || n.attrs.scrollable === 'true'
  ).length;
  const editableCount = top.filter((n) => n.attrs.editable === 'true').length;

  // Build compact XML with element numbering
  const lines = top.map((node, i) => {
    const attrs = Object.entries(node.attrs)
      .map(([k, v]) => `${k}="${escapeXml(v)}"`)
      .join(' ');
    return `<${node.tag} idx="${i + 1}" ${attrs}/>`;
  });

  return {
    xml: `<screen elements="${top.length}" interactive="${interactiveCount}" editable="${editableCount}">\n${lines.join('\n')}\n</screen>`,
    elementCount: top.length,
    editableCount,
  };
}

/**
 * Extract text values from trimmed DOM for screen diffing.
 * Uses the raw page source to avoid re-parsing.
 */
export function extractTexts(xmlContent: string): string[] {
  const texts: string[] = [];
  const textRegex = /(?:text|content-desc|label)="([^"]+)"/g;
  let match;
  while ((match = textRegex.exec(xmlContent)) !== null) {
    if (match[1].trim()) texts.push(match[1].trim());
  }
  return [...new Set(texts)];
}

// ─── Android walker ─────────────────────────────────────

function walkAndroid(node: any, result: TrimmedNode[], parentContext: string = ''): void {
  if (!node || typeof node !== 'object') return;

  if (node['@_bounds']) {
    const className: string = node['@_class'] ?? '';
    const tag = className.split('.').pop() || 'View';
    const text: string = node['@_text'] ?? '';
    const desc: string = node['@_content-desc'] ?? '';
    const resourceId: string = node['@_resource-id'] ?? '';
    const hint: string = node['@_hint'] ?? '';
    const bounds: string = node['@_bounds'];

    const clickable = node['@_clickable'] === 'true';
    const enabled = node['@_enabled'] !== 'false';
    const focused = node['@_focused'] === 'true';
    const scrollable = node['@_scrollable'] === 'true';
    const checked = node['@_checked'] === 'true';
    const editable =
      className.includes('EditText') ||
      className.includes('AutoCompleteTextView') ||
      node['@_editable'] === 'true';

    // Parse bounds to skip zero-size elements
    try {
      const coords = bounds
        .replace('][', ',')
        .replace('[', '')
        .replace(']', '')
        .split(',')
        .map(Number);
      const width = coords[2] - coords[0];
      const height = coords[3] - coords[1];
      if (width <= 0 || height <= 0) {
        walkChildrenAndroid(node, result, parentContext);
        return;
      }
    } catch {
      walkChildrenAndroid(node, result, parentContext);
      return;
    }

    // Determine context label to pass to children
    const ridShort = resourceId.includes('/') ? resourceId.split('/').pop()! : resourceId;
    const contextLabel = desc || ridShort || '';
    const childContext = contextLabel ? contextLabel.slice(0, 30) : parentContext;

    const isInteractive = clickable || editable || scrollable;
    const hasContent = !!(text || desc);

    if (isInteractive || hasContent) {
      // Score for prioritization (same logic as element-filter)
      let score = 0;
      if (enabled) score += 10;
      if (editable) score += 8;
      if (focused) score += 6;
      if (clickable) score += 5;
      if (text || desc) score += 3;
      if (resourceId || desc) score += 2;

      const attrs: Record<string, string> = {};
      if (text) attrs.text = text;
      if (resourceId) {
        attrs.rid = resourceId;
      }
      if (desc) attrs.desc = desc;
      if (hint) attrs.hint = hint;
      attrs.bounds = bounds;
      if (clickable) attrs.clickable = 'true';
      if (!enabled) attrs.enabled = 'false';
      if (focused) attrs.focused = 'true';
      if (scrollable) attrs.scrollable = 'true';
      if (checked) attrs.checked = 'true';
      if (editable) attrs.editable = 'true';
      // Add parent context for disambiguation
      if (parentContext && parentContext !== ridShort && parentContext !== desc) {
        attrs.in = parentContext;
      }

      result.push({ tag, attrs, score });
    }

    walkChildrenAndroid(node, result, childContext);
    return;
  }

  walkChildrenAndroid(node, result, parentContext);
}

function walkChildrenAndroid(node: any, result: TrimmedNode[], parentContext: string = ''): void {
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walkAndroid(item, result, parentContext);
    } else if (typeof child === 'object' && child !== null) {
      walkAndroid(child, result, parentContext);
    }
  }
}

// ─── iOS walker ─────────────────────────────────────────

function walkIOS(node: any, result: TrimmedNode[], parentContext: string = ''): void {
  if (!node || typeof node !== 'object') return;

  const hasPosition = node['@_x'] !== undefined && node['@_y'] !== undefined;

  if (hasPosition) {
    const x = parseInt(node['@_x'] ?? '0', 10);
    const y = parseInt(node['@_y'] ?? '0', 10);
    const width = parseInt(node['@_width'] ?? '0', 10);
    const height = parseInt(node['@_height'] ?? '0', 10);

    if (width <= 0 || height <= 0) {
      walkChildrenIOS(node, result, parentContext);
      return;
    }

    const elementType: string = node['@_type'] ?? '';
    const tag = elementType.replace('XCUIElementType', '') || 'View';
    const label: string = node['@_label'] ?? '';
    const name: string = node['@_name'] ?? '';
    const value: string = node['@_value'] ?? '';
    const hint: string = node['@_placeholderValue'] ?? '';

    const isVisible = node['@_visible'] !== 'false';
    const isEnabled = node['@_enabled'] !== 'false';
    const isAccessible = node['@_accessible'] === 'true';
    const isFocused = node['@_hasFocus'] === 'true';
    const isSelected = node['@_selected'] === 'true';

    const editableTypes = ['TextField', 'SecureTextField', 'TextEditor', 'SearchField'];
    const editable = editableTypes.some((t) => tag.includes(t));
    const clickable =
      isAccessible ||
      ['Button', 'Cell', 'Link', 'Switch', 'Slider', 'Tab'].some((t) => tag.includes(t));
    const scrollable = ['ScrollView', 'Table', 'CollectionView'].some((t) => tag.includes(t));
    const checked = value === '1' && (tag === 'Switch' || tag === 'CheckBox');

    // Determine context label to pass to children
    const contextLabel = name || label || '';
    const childContext = contextLabel ? contextLabel.slice(0, 30) : parentContext;

    const displayText = label || name || value;
    const isInteractive = clickable || editable || scrollable;
    const hasContent = !!displayText;

    if ((isInteractive || hasContent) && isVisible) {
      let score = 0;
      if (isEnabled) score += 10;
      if (editable) score += 8;
      if (isFocused) score += 6;
      if (clickable) score += 5;
      if (displayText) score += 3;
      if (name) score += 2;

      const attrs: Record<string, string> = {};
      if (label) attrs.text = label;
      if (name) attrs.name = name;
      if (value && value !== label) attrs.value = value;
      if (hint) attrs.hint = hint;
      attrs.bounds = `[${x},${y}][${x + width},${y + height}]`;
      if (clickable) attrs.clickable = 'true';
      if (!isEnabled) attrs.enabled = 'false';
      if (isFocused) attrs.focused = 'true';
      if (scrollable) attrs.scrollable = 'true';
      if (checked) attrs.checked = 'true';
      if (editable) attrs.editable = 'true';
      if (isSelected) attrs.selected = 'true';
      // Add parent context for disambiguation
      if (parentContext && parentContext !== name && parentContext !== label) {
        attrs.in = parentContext;
      }

      result.push({ tag, attrs, score });
    }

    walkChildrenIOS(node, result, childContext);
    return;
  }

  walkChildrenIOS(node, result, parentContext);
}

function walkChildrenIOS(node: any, result: TrimmedNode[], parentContext: string = ''): void {
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walkIOS(item, result, parentContext);
    } else if (typeof child === 'object' && child !== null) {
      walkIOS(child, result, parentContext);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
