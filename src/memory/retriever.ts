/**
 * Episodic Memory — trajectory retriever.
 *
 * Queries the trajectory store and formats relevant past experience
 * as a compact prompt section (< 200 tokens) for LLM injection.
 */

import type { TrajectoryStore, TrajectoryQuery, TrajectoryMatch } from './types.js';
import { getEffectiveConfidence } from './store.js';
import { computeSemanticFingerprint } from './fingerprint.js';

/** Minimum combined score to include a match */
const MIN_SCORE = 0.25;

/**
 * Jaccard similarity between two sorted string arrays.
 * |A ∩ B| / |A ∪ B|
 */
function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Retrieve relevant past trajectories from the store.
 *
 * Scoring:
 * - 0.6 * screen label similarity (Jaccard on label sets)
 * - 0.4 * goal keyword overlap (Jaccard on keyword sets)
 * - weighted by effective confidence (time decay + reliability)
 */
export function retrieveTrajectories(
  store: TrajectoryStore,
  query: TrajectoryQuery
): TrajectoryMatch[] {
  const maxResults = query.maxResults ?? 3;
  const currentFingerprint = computeSemanticFingerprint(query.currentScreenLabels);

  const scored: TrajectoryMatch[] = [];

  for (const entry of store.entries) {
    // Hard filters: platform and app must match
    if (entry.platform !== query.platform) continue;
    if (entry.appId !== query.appId) continue;

    // Prefer same agent mode but don't exclude cross-mode matches
    const modeBonus = entry.agentMode === query.agentMode ? 1.0 : 0.7;

    // Screen similarity: exact fingerprint match = 1.0, else Jaccard on labels
    let screenSim: number;
    if (entry.screenFingerprint === currentFingerprint) {
      screenSim = 1.0;
    } else {
      screenSim = jaccard(entry.screenLabels, query.currentScreenLabels);
    }

    // Goal similarity: Jaccard on keywords
    const goalSim = jaccard(entry.goalKeywords, query.goalKeywords);

    // Combined score
    const rawScore = (0.6 * screenSim + 0.4 * goalSim) * modeBonus;
    const confidence = getEffectiveConfidence(entry);
    const finalScore = rawScore * confidence;

    if (finalScore >= MIN_SCORE) {
      scored.push({ entry, score: finalScore });
    }
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/**
 * Format retrieved trajectories into a compact prompt section.
 *
 * Keeps output under ~200 tokens. Adapts format based on agent mode.
 */
export function formatExperienceForPrompt(matches: TrajectoryMatch[]): string {
  if (matches.length === 0) return '';

  const lines: string[] = ['RELEVANT PAST EXPERIENCE (from previous successful runs):'];

  for (const { entry, score } of matches) {
    const ago = formatTimeAgo(entry.timestamp);
    const uses = entry.successCount > 1 ? ` (succeeded ${entry.successCount}x)` : '';

    if (entry.agentMode === 'vision') {
      // Vision mode: emphasize the description that worked
      if (entry.action.toolName === 'find_and_type') {
        lines.push(
          `- ${entry.action.toolName}: describe target as "${entry.action.selector}", ` +
            `text="${entry.action.text}"${uses} [${ago}]`
        );
      } else {
        lines.push(
          `- ${entry.action.toolName}: describe target as "${entry.action.selector}"${uses} [${ago}]`
        );
      }
    } else {
      // DOM mode: emphasize strategy + selector
      const strategy = entry.action.strategy ?? 'unknown';
      if (entry.action.toolName === 'find_and_type') {
        lines.push(
          `- ${entry.action.toolName}(${strategy}="${entry.action.selector}", ` +
            `text="${entry.action.text}")${uses} [${ago}]`
        );
      } else {
        lines.push(
          `- ${entry.action.toolName}(${strategy}="${entry.action.selector}")${uses} [${ago}]`
        );
      }
    }
  }

  lines.push('(These are hints — verify they still apply to the current screen before using.)');
  return lines.join('\n');
}

function formatTimeAgo(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
