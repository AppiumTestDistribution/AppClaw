/**
 * Human-in-the-loop module — pause the agent to ask the user for input.
 *
 * Used for:
 * - OTP/verification codes
 * - CAPTCHA solving
 * - Ambiguous choices ("Which John? John Smith or John Doe?")
 * - Confirmation before destructive actions ("Delete this? y/n")
 * - Login credentials
 */

import * as readline from 'readline';
import * as ui from '../ui/terminal.js';

export interface HITLRequest {
  type: 'otp' | 'captcha' | 'choice' | 'confirmation' | 'input';
  question: string;
  options?: string[];
  timeout?: number; // ms, 0 = no timeout
}

export interface HITLResponse {
  answered: boolean;
  answer: string;
  timedOut: boolean;
}

/** Prompt the user via CLI with optional timeout */
export async function askUser(request: HITLRequest): Promise<HITLResponse> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = ui.formatHITLPrompt(request.type, request.question, request.options);

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (request.timeout && request.timeout > 0) {
      timer = setTimeout(() => {
        rl.close();
        ui.printTimeout();
        resolve({ answered: false, answer: '', timedOut: true });
      }, request.timeout);
    }

    rl.question(prompt, (answer: string) => {
      if (timer) clearTimeout(timer);
      rl.close();

      const trimmed = answer.trim();

      // If options were given and user entered a number, map to option
      if (request.options && /^\d+$/.test(trimmed)) {
        const idx = parseInt(trimmed, 10) - 1;
        if (idx >= 0 && idx < request.options.length) {
          resolve({ answered: true, answer: request.options[idx], timedOut: false });
          return;
        }
      }

      resolve({ answered: !!trimmed, answer: trimmed, timedOut: false });
    });
  });
}

/** Detect if the LLM's ask_user action needs a specific HITL type */
export function classifyHITLRequest(question: string): HITLRequest {
  const lower = question.toLowerCase();

  if (lower.includes('otp') || lower.includes('verification code') || lower.includes('2fa')) {
    return { type: 'otp', question, timeout: 120_000 }; // 2 min for OTP
  }

  if (lower.includes('captcha')) {
    return { type: 'captcha', question, timeout: 60_000 };
  }

  if (lower.includes('which') || lower.includes('choose') || lower.includes('select')) {
    return { type: 'choice', question };
  }

  if (
    lower.includes('confirm') ||
    lower.includes('delete') ||
    lower.includes('proceed') ||
    lower.includes('sure')
  ) {
    return { type: 'confirmation', question, options: ['Yes', 'No'] };
  }

  return { type: 'input', question };
}
