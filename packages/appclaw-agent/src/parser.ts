import type { AgentSelector } from 'appclaw/agent-runtime';
import { resolve } from 'node:path';
import type { ParsedInvocation, TargetInput } from './types.js';

export function parseInvocation(argv: string[]): ParsedInvocation {
  const args = [...argv];
  let session = 'default';
  let json = false;

  for (let i = 0; i < args.length; ) {
    if (args[i] === '--session') {
      session = required(args[i + 1], '--session requires a name');
      args.splice(i, 2);
    } else if (args[i] === '--json') {
      json = true;
      args.splice(i, 1);
    } else {
      i++;
    }
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === 'help') {
    return { session, json, local: 'help' };
  }
  if (args[0] === '--version' || args[0] === 'version') {
    return { session, json, local: 'version' };
  }

  const name = args.shift()!;
  if (name === 'session' && args[0] === 'list') return { session, json, command: { kind: 'list' } };
  if (name === 'open') {
    const app = required(args.shift(), 'open requires an app id');
    const platform = option(args, '--platform');
    if (platform !== 'android' && platform !== 'ios') {
      throw new Error('open requires --platform android|ios');
    }
    const rawDeviceType = option(args, '--device-type');
    if (rawDeviceType && rawDeviceType !== 'simulator' && rawDeviceType !== 'real') {
      throw new Error('--device-type must be simulator or real');
    }
    return {
      session,
      json,
      command: {
        kind: 'open',
        options: {
          app,
          platform,
          ...(rawDeviceType && { deviceType: rawDeviceType as 'simulator' | 'real' }),
          ...(option(args, '--device') && { device: option(args, '--device')! }),
          ...(option(args, '--udid') && { udid: option(args, '--udid')! }),
        },
      },
    };
  }
  if (name === 'snapshot') {
    if (args.includes('--vision')) {
      throw new Error(
        '--vision is not supported on snapshot. Use "is visible --vision" or "get info --vision" for visual checks, or "screenshot <path>" to capture and analyze the screen.'
      );
    }
    return { session, json, command: { kind: 'snapshot', interactiveOnly: args.includes('-i') } };
  }
  if (name === 'press') {
    const vision = option(args, '--vision');
    return {
      session,
      json,
      command: vision
        ? { kind: 'press', target: { text: vision }, vision }
        : { kind: 'press', target: parseTarget(required(args[0], 'press requires a target')) },
    };
  }
  if (name === 'fill') {
    return {
      session,
      json,
      command: {
        kind: 'fill',
        target: parseTarget(required(args[0], 'fill requires a target')),
        text: required(args[1], 'fill requires text'),
      },
    };
  }
  if (name === 'longpress') {
    const duration = args[1] ? Number(args[1]) : undefined;
    if (duration !== undefined && !Number.isFinite(duration))
      throw new Error('duration must be numeric');
    return {
      session,
      json,
      command: {
        kind: 'longpress',
        target: parseTarget(required(args[0], 'longpress requires a target')),
        ...(duration !== undefined && { duration }),
      },
    };
  }
  if (name === 'swipe' || name === 'scroll') {
    const DIRECTIONS = ['up', 'down', 'left', 'right'];
    // swipe <target> <direction>  — element-scoped scroll
    if (args.length >= 2 && DIRECTIONS.includes(args[1])) {
      return {
        session,
        json,
        command: {
          kind: 'swipe',
          target: parseTarget(args[0]),
          direction: args[1] as 'up' | 'down' | 'left' | 'right',
        },
      };
    }
    // swipe <direction>  — full-screen swipe
    const direction = args[0];
    if (!DIRECTIONS.includes(direction)) {
      throw new Error(`${name} requires up|down|left|right, or <target> up|down|left|right`);
    }
    return { session, json, command: { kind: 'swipe', direction: direction as any } };
  }
  if (name === 'back' || name === 'home' || name === 'enter') {
    return { session, json, command: { kind: 'key', key: name.toUpperCase() as any } };
  }
  if (name === 'get' && args[0] === 'info') {
    const vision = option(args, '--vision');
    if (!vision) throw new Error('get info requires --vision "<description>"');
    return { session, json, command: { kind: 'getInfo', vision } };
  }
  if (name === 'get' && (args[0] === 'text' || args[0] === 'attrs')) {
    const target = parseTarget(required(args[1], `get ${args[0]} requires a target`));
    return {
      session,
      json,
      command: args[0] === 'text' ? { kind: 'getText', target } : { kind: 'getAttrs', target },
    };
  }
  if (name === 'is' && args[0] === 'visible') {
    const vision = option(args, '--vision');
    if (vision) return { session, json, command: { kind: 'isVisible', vision } };
    const target = required(args[1], 'is visible requires a target or --vision');
    return { session, json, command: visibleCommand(target) };
  }
  if (name === 'wait' && (args[0] === 'visible' || args[0] === 'gone')) {
    const target = required(args[1], `wait ${args[0]} requires a target`);
    const parsed = parseTargetOrText(target);
    return {
      session,
      json,
      command: { kind: 'wait', condition: args[0], ...parsed },
    };
  }
  if (name === 'screenshot') {
    return {
      session,
      json,
      command: {
        kind: 'screenshot',
        path: resolve(required(args[0], 'screenshot requires a path')),
      },
    };
  }
  if (name === 'close') return { session, json, command: { kind: 'close' } };

  throw new Error(`Unknown command: ${name}. Run appclaw-agent help workflow.`);
}

export function parseTarget(value: string): TargetInput {
  if (/^@e\d+$/.test(value)) return { ref: value };
  const selector = parseSelector(value);
  if (selector) return { selector };
  const coords = /^(\d+),(\d+)$/.exec(value);
  if (coords) return { coordinates: [Number(coords[1]), Number(coords[2])] };
  throw new Error(
    `Invalid target "${value}". Use @e1, id="...", accessibility="...", text="...", or x,y.`
  );
}

function parseTargetOrText(value: string): { target?: TargetInput; text?: string } {
  try {
    return { target: parseTarget(value) };
  } catch {
    return { text: value };
  }
}

function visibleCommand(value: string) {
  const parsed = parseTargetOrText(value);
  return { kind: 'isVisible' as const, ...parsed };
}

function parseSelector(value: string): AgentSelector | undefined {
  const match = /^(id|accessibility|text)="([\s\S]*)"$/.exec(value);
  if (!match) return undefined;
  return { kind: match[1] as AgentSelector['kind'], value: match[2] };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return required(args[index + 1], `${name} requires a value`);
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}
