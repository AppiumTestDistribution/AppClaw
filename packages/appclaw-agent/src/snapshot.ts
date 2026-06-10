import type { AgentSnapshot, AgentTarget } from 'appclaw/agent-runtime';
import type { SnapshotRef } from './types.js';

export function snapshotWithRefs(snapshot: AgentSnapshot): {
  refs: Map<string, AgentTarget>;
  entries: SnapshotRef[];
  output: string;
} {
  const refs = new Map<string, AgentTarget>();
  const entries: SnapshotRef[] = [];
  const lines = snapshot.elements.map((element, index) => {
    const ref = `@e${index + 1}`;
    const target: AgentTarget = element.selector
      ? { selector: element.selector }
      : { coordinates: element.center };
    refs.set(ref, target);
    entries.push({ ref, target });
    const label = element.text ? ` "${element.text}"` : '';
    const id = element.id
      ? ` id="${element.id}"`
      : element.accessibilityId
        ? ` accessibility="${element.accessibilityId}"`
        : '';
    const state = element.enabled ? '' : ' disabled';
    return `${ref} [${element.type || element.action}]${label}${id}${state}`;
  });
  return {
    refs,
    entries,
    output: lines.length ? lines.join('\n') : '(no matching elements on screen)',
  };
}
