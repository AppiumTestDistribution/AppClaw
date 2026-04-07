/**
 * Stuck-loop detection for the AppClaw agent loop.
 * Detects repeated actions / no-progress screens and suggests recovery hints.
 *
 * Detects: repeated actions, unchanged screens, navigation drift.
 * Returns context-aware recovery hints.
 */

export interface StuckDetector {
  recordAction(action: string, screenHash: string): void;
  isStuck(goal?: string): boolean;
  getRecoveryHint(goal: string): string;
  /** Get a DOM-aware recovery hint that identifies untried interactive elements */
  getDOMRecoveryHint(goal: string, currentDom: string, triedSelectors: string[]): string;
  getStuckCount(): number;
  reset(): void;
}

export function createStuckDetector(windowSize: number = 8): StuckDetector {
  const recentActions: string[] = [];
  const recentHashes: string[] = [];
  let unchangedCount = 0;
  let stuckCount = 0;

  return {
    recordAction(action: string, screenHash: string) {
      if (recentHashes.length > 0 && recentHashes[recentHashes.length - 1] === screenHash) {
        unchangedCount++;
      } else {
        unchangedCount = 0;
      }

      recentActions.push(action);
      recentHashes.push(screenHash);
      if (recentActions.length > windowSize) recentActions.shift();
      if (recentHashes.length > windowSize) recentHashes.shift();
    },

    isStuck(goal?: string): boolean {
      if (recentActions.length < 3) return false;

      // Check 1: All recent actions are identical
      const last3 = recentActions.slice(-3);
      const allSameAction = last3.every((a) => a === last3[0]);

      // Check 2: Screen hasn't changed for 3+ steps
      const allSameHash = unchangedCount >= 3;

      // Check 3: Same action appears 3+ times in window
      const freq = new Map<string, number>();
      for (const a of recentActions) freq.set(a, (freq.get(a) ?? 0) + 1);
      const maxFreq = Math.max(...freq.values());
      const highRepetition = maxFreq >= 3;

      // Check 4: Screen oscillating between 2 states (e.g., toggling on/off)
      let oscillating = false;
      if (recentHashes.length >= 4) {
        const last4 = recentHashes.slice(-4);
        oscillating = last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1];
      }

      // ── Scroll exemption ──────────────────────────────
      // When the goal involves scrolling to find content, repeated scroll/swipe
      // actions are expected — not a stuck loop. Only flag as stuck if the
      // screen is ALSO unchanged (scroll had zero visual effect).
      if (goal && !oscillating) {
        const isScrollGoal =
          /scroll|find|search|look\s+for|locate|swipe.*until|until.*(?:see|find|visible)/i.test(
            goal
          );
        const allScrollActions = last3.every(
          (a) =>
            a.startsWith('scroll') ||
            a.startsWith('swipe') ||
            a.includes('appium_scroll') ||
            a.includes('appium_swipe')
        );

        if (isScrollGoal && allScrollActions && !allSameHash) {
          // Scrolling is making progress (screen changes between scrolls) — not stuck
          return false;
        }
      }

      const stuck = allSameAction || allSameHash || highRepetition || oscillating;
      if (stuck) stuckCount++;
      return stuck;
    },

    getRecoveryHint(goal: string): string {
      // Check for oscillation (toggling back and forth)
      let isOscillating = false;
      if (recentHashes.length >= 4) {
        const last4 = recentHashes.slice(-4);
        isOscillating = last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1];
      }

      if (isOscillating) {
        return (
          'CRITICAL — OSCILLATION DETECTED: The screen is toggling between TWO states because you keep tapping the same element. ' +
          'This means the FIRST tap SUCCEEDED (it changed the state), and each subsequent tap UNDOES it. ' +
          'Your goal "' +
          goal +
          '" was ALREADY ACHIEVED on the first tap. ' +
          'You MUST call "done" NOW. Do NOT tap anything else — you are undoing your own work.'
        );
      }

      // After 2+ stuck detections, push toward a different approach
      if (stuckCount >= 2) {
        const lowerGoal = goal.toLowerCase();
        const isToggleGoal = /toggle|switch|turn\s+(on|off)|enable|disable/i.test(lowerGoal);
        const isOverlayGoal =
          /dismiss|autocomplete|suggestion|dropdown|confirm|handle|overlay|popup/i.test(lowerGoal);

        if (isOverlayGoal) {
          return (
            'CRITICAL: You have been stuck for multiple rounds trying to handle an overlay or unexpected UI state.\n' +
            'STOP repeating the same action. Your current approach is WRONG.\n\n' +
            'RE-EXAMINE THE DOM CAREFULLY. Look for elements you have NOT tried yet:\n' +
            "- Look for confirmation buttons (text/desc containing 'Done', 'OK', 'Add', 'Confirm', 'Select', 'Apply')\n" +
            "- Look for list items in a dropdown — they often have different text/desc than what you've been clicking\n" +
            '- Try pressing ENTER key via appium_mobile_press_key\n' +
            '- Try tapping a DIFFERENT field or area of the screen\n\n' +
            "The element you need is IN the DOM — you just haven't found it yet. Read EVERY element and pick one you haven't tried."
          );
        }

        if (isToggleGoal) {
          return (
            'CRITICAL: You have been stuck for multiple rounds repeating the same action. ' +
            'STOP and think: your goal was "' +
            goal +
            '". ' +
            'The goal is VERY LIKELY ALREADY ACHIEVED. The action you keep repeating probably succeeded on the first try. ' +
            'You MUST call "done" NOW with a reason explaining the goal was completed. ' +
            'Do NOT tap, scroll, or interact again — call "done" immediately.'
          );
        }

        return (
          'CRITICAL: You have been stuck for multiple rounds repeating the same action on "' +
          goal +
          '".\n' +
          'STOP — your current approach is NOT working. You must try something COMPLETELY DIFFERENT.\n\n' +
          "1. RE-READ THE DOM — look for interactive elements you haven't tried yet\n" +
          '2. If you see a suggestion/autocomplete/dropdown, look for the specific item to TAP (not the text you typed)\n' +
          '3. Try pressing ENTER key to confirm input\n' +
          '4. Try tapping a different field or area of the screen\n' +
          '5. If the goal really IS already achieved, call "done"\n\n' +
          "DO NOT repeat any action you've already tried."
        );
      }

      let hint =
        'STUCK DETECTED: You are repeating the same action. STOP — your current approach is NOT working.\n\n' +
        'IMPORTANT: Before trying anything else, ask yourself: "Is the goal ALREADY achieved?" ' +
        'If you tapped a toggle/switch/button and the screen shows the expected state, call "done" immediately.\n\n';

      const failingActions = recentActions.slice(-3);
      const isTapping = failingActions.some(
        (a) => a.includes('click') || a.includes('tap') || a.includes('find_element')
      );

      if (isTapping) {
        // Check if goal involves toggling/switching
        const lowerGoal = goal.toLowerCase();
        const isToggleGoal = /toggle|switch|turn\s+(on|off)|enable|disable/i.test(lowerGoal);

        if (isToggleGoal) {
          hint +=
            'You are tapping repeatedly on what appears to be a toggle action. ' +
            'The toggle LIKELY ALREADY SUCCEEDED on your first tap. Tapping again UNDOES the toggle! ' +
            'Call "done" NOW — the goal is achieved.\n\n';
        } else {
          hint +=
            'Your tap actions are having NO EFFECT. Likely causes:\n' +
            '- The action ALREADY SUCCEEDED silently — call "done" if the goal is complete.\n' +
            '- The element is not actually interactive — try a different element.\n' +
            '- Try a different locator strategy (accessibility id, xpath, or id).\n\n';
        }
      }

      const isTyping = failingActions.some((a) => a.includes('set_value') || a.includes('type'));
      if (isTyping) {
        hint +=
          'Your type actions are having NO EFFECT on the screen. Likely causes:\n' +
          "- You are targeting the WRONG element — look at DOM for elements with editable='true' (EditText) and use their desc or rid as locator.\n" +
          '- The field may need to be clicked first with appium_click before typing.\n' +
          '- Make sure you found the actual EditText, not a label/container near it.\n' +
          "- For Jetpack Compose/custom UI: the input may be a View with a long desc (e.g. 'Enter Drop location Input Field...') — click it first; the next screen may show the real editable field or a different UI to tap.\n" +
          "- If there's a search/autocomplete field, type a shorter query and look for suggestions to tap.\n\n";
      }

      const isScrolling = failingActions.some(
        (a) => a.startsWith('scroll') || a.startsWith('swipe')
      );
      if (isScrolling) {
        hint +=
          'Scrolling is having no effect — you may be at the end of scrollable content. ' +
          "Try interacting with visible elements or use 'go_back'.\n\n";
      }

      hint += 'If the goal is NOT yet achieved, try a COMPLETELY different approach.';

      return hint;
    },

    getDOMRecoveryHint(_goal: string, currentDom: string, triedSelectors: string[]): string {
      // Extract all interactive elements from the DOM
      const clickableElements: string[] = [];
      const elementRegex = /<(\w+)\s+([^>]*?)\/?>/g;
      let match;

      while ((match = elementRegex.exec(currentDom)) !== null) {
        const attrs = match[2];
        const isClickable = attrs.includes('clickable="true"') || attrs.includes('editable="true"');
        if (!isClickable) continue;

        // Extract identifying attributes
        const textMatch = attrs.match(/text="([^"]+)"/);
        const descMatch = attrs.match(/desc="([^"]+)"/);
        const ridMatch = attrs.match(/rid="([^"]+)"/);
        const boundsMatch = attrs.match(/bounds="([^"]+)"/);
        const identifier = textMatch?.[1] || descMatch?.[1] || ridMatch?.[1] || '';
        if (!identifier || identifier.length <= 1) continue;

        // Check if this element has been tried
        const alreadyTried = triedSelectors.some(
          (s) => identifier.includes(s) || s.includes(identifier)
        );

        if (!alreadyTried) {
          const desc = [
            match[1],
            textMatch ? `text="${textMatch[1]}"` : '',
            descMatch ? `desc="${descMatch[1]}"` : '',
            ridMatch ? `rid="${ridMatch[1]}"` : '',
            boundsMatch ? `bounds="${boundsMatch[1]}"` : '',
          ]
            .filter(Boolean)
            .join(' ');
          clickableElements.push(desc);
        }
      }

      if (clickableElements.length === 0) {
        return 'No untried interactive elements found in DOM. Try pressing ENTER, go_back, or tapping coordinates directly.';
      }

      return (
        'UNTRIED INTERACTIVE ELEMENTS in the current DOM (you have NOT tried these yet):\n' +
        clickableElements
          .slice(0, 10)
          .map((e, i) => `  ${i + 1}. ${e}`)
          .join('\n') +
        '\n\nTry one of these elements instead of repeating what already failed.'
      );
    },

    getStuckCount(): number {
      return stuckCount;
    },

    reset() {
      recentActions.length = 0;
      recentHashes.length = 0;
      unchangedCount = 0;
      stuckCount = 0;
    },
  };
}
