/**
 * Android UiAutomator2 XML → UIElement[] parser.
 * Parse Android UiAutomator2 page source XML from Appium into UIElement trees.
 */

import { XMLParser } from 'fast-xml-parser';
import type { UIElement } from './types.js';

export function parseAndroidPageSource(xmlContent: string): UIElement[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(xmlContent);
  } catch {
    console.warn('Warning: Error parsing Android XML. The screen might be loading.');
    return [];
  }

  const elements: UIElement[] = [];

  function walk(node: any, parentLabel: string, depth: number): void {
    if (!node || typeof node !== 'object') return;

    if (node['@_bounds']) {
      const isClickable = node['@_clickable'] === 'true';
      const isLongClickable = node['@_long-clickable'] === 'true';
      const isScrollable = node['@_scrollable'] === 'true';
      const isEnabled = node['@_enabled'] !== 'false';
      const isChecked = node['@_checked'] === 'true';
      const isFocused = node['@_focused'] === 'true';
      const isSelected = node['@_selected'] === 'true';

      const elementClass: string = node['@_class'] ?? '';
      const isEditable =
        elementClass.includes('EditText') ||
        elementClass.includes('AutoCompleteTextView') ||
        node['@_editable'] === 'true';

      const text: string = node['@_text'] ?? '';
      const desc: string = node['@_content-desc'] ?? '';
      const resourceId: string = node['@_resource-id'] ?? '';
      const hint: string = node['@_hint'] ?? '';

      const typeName = elementClass.split('.').pop() ?? '';
      const nodeLabel = text || desc || resourceId.split('/').pop() || typeName;

      const isInteractive = isClickable || isEditable || isLongClickable || isScrollable;
      const hasContent = !!(text || desc);

      if (isInteractive || hasContent) {
        const bounds: string = node['@_bounds'];
        try {
          const coords = bounds
            .replace('][', ',')
            .replace('[', '')
            .replace(']', '')
            .split(',')
            .map(Number);

          const [x1, y1, x2, y2] = coords;
          const width = x2 - x1;
          const height = y2 - y1;

          if (width > 0 && height > 0) {
            const centerX = Math.floor((x1 + x2) / 2);
            const centerY = Math.floor((y1 + y2) / 2);

            let suggestedAction: UIElement['action'];
            if (isEditable) suggestedAction = 'type';
            else if (isLongClickable && !isClickable) suggestedAction = 'longpress';
            else if (isScrollable && !isClickable) suggestedAction = 'scroll';
            else if (isClickable) suggestedAction = 'tap';
            else suggestedAction = 'read';

            elements.push({
              id: resourceId,
              accessibilityId: desc || resourceId.split('/').pop() || '',
              text: text || desc,
              type: typeName,
              bounds,
              center: [centerX, centerY],
              size: [width, height],
              clickable: isClickable,
              editable: isEditable,
              enabled: isEnabled,
              checked: isChecked,
              focused: isFocused,
              selected: isSelected,
              scrollable: isScrollable,
              longClickable: isLongClickable,
              hint,
              action: suggestedAction,
              parent: parentLabel,
              depth,
              platform: 'android',
            });
          }
        } catch {
          // Skip malformed bounds
        }
      }

      walkChildren(node, nodeLabel, depth + 1);
      return;
    }

    walkChildren(node, parentLabel, depth);
  }

  function walkChildren(node: any, parentLabel: string, depth: number): void {
    // Appium page source nests children directly as element type keys
    for (const key of Object.keys(node)) {
      if (key.startsWith('@_')) continue; // skip attributes
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) walk(item, parentLabel, depth);
      } else if (typeof child === 'object' && child !== null) {
        walk(child, parentLabel, depth);
      }
    }
  }

  walk(parsed, 'root', 0);
  return elements;
}
