import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntimeSession, type AgentTarget } from 'appclaw/agent-runtime';
import { snapshotWithRefs } from './snapshot.js';
import type { Command, CommandResponse, TargetInput } from './types.js';

interface SessionState {
  runtime: AgentRuntimeSession;
  refs: Map<string, AgentTarget> | null;
}

export class AgentDaemonState {
  private readonly sessions = new Map<string, SessionState>();

  get sessionCount(): number {
    return this.sessions.size;
  }

  async execute(sessionName: string, command: Command): Promise<CommandResponse> {
    try {
      if (command.kind === 'list') {
        const sessions = [...this.sessions.keys()];
        return {
          ok: true,
          message: sessions.length ? sessions.join('\n') : 'No active sessions',
          data: { sessions },
        };
      }

      if (command.kind === 'open') {
        const previous = this.sessions.get(sessionName);
        if (previous) {
          await previous.runtime.close();
          this.sessions.delete(sessionName);
        }
        const runtime = await AgentRuntimeSession.open(command.options);
        this.sessions.set(sessionName, { runtime, refs: null });
        return {
          ok: true,
          session: sessionName,
          message: `Opened ${command.options.app} on ${command.options.platform}`,
          data: { sessionId: runtime.sessionId },
        };
      }

      if (command.kind === 'close') {
        const current = this.requireSession(sessionName);
        await current.runtime.close();
        this.sessions.delete(sessionName);
        return { ok: true, session: sessionName, message: `Closed session ${sessionName}` };
      }

      const current = this.requireSession(sessionName);

      if (command.kind === 'snapshot') {
        const snapshot = await current.runtime.snapshot(command.interactiveOnly);
        const formatted = snapshotWithRefs(snapshot);
        current.refs = formatted.refs;
        return {
          ok: true,
          session: sessionName,
          message: `Snapshot contains ${snapshot.elements.length} element(s)`,
          output: formatted.output,
          data: {
            platform: snapshot.platform,
            elements: snapshot.elements,
            refs: formatted.entries,
          },
        };
      }

      let response: CommandResponse;
      switch (command.kind) {
        case 'press':
          if (command.vision && !current.runtime.isVisionConfigured()) {
            return screenshotFallback(sessionName, current.runtime, command.vision, true);
          }
          response = result(
            sessionName,
            command.vision
              ? await current.runtime.visionPress(command.vision)
              : await current.runtime.press(resolveTarget(current, command.target))
          );
          break;
        case 'fill':
          response = result(
            sessionName,
            await current.runtime.fill(resolveTarget(current, command.target), command.text)
          );
          break;
        case 'longpress':
          response = result(
            sessionName,
            await current.runtime.longpress(
              resolveTarget(current, command.target),
              command.duration
            )
          );
          break;
        case 'swipe':
          response = result(
            sessionName,
            command.target
              ? await current.runtime.swipeElement(
                  resolveTarget(current, command.target),
                  command.direction
                )
              : await current.runtime.swipe(command.direction)
          );
          break;
        case 'key':
          response = result(sessionName, await current.runtime.pressKey(command.key));
          break;
        case 'getText':
          return result(
            sessionName,
            await current.runtime.getText(resolveTarget(current, command.target))
          );
        case 'getAttrs':
          return result(
            sessionName,
            await current.runtime.getAttrs(resolveTarget(current, command.target))
          );
        case 'getInfo':
          if (!current.runtime.isVisionConfigured()) {
            return screenshotFallback(sessionName, current.runtime, command.vision, false);
          }
          return result(sessionName, await current.runtime.visionInfo(command.vision));
        case 'isVisible':
          if (command.vision && !current.runtime.isVisionConfigured()) {
            return screenshotFallback(sessionName, current.runtime, command.vision, false);
          }
          return result(
            sessionName,
            command.vision
              ? await current.runtime.visionVisible(command.vision)
              : await current.runtime.isVisible(
                  command.target ? resolveTarget(current, command.target) : (command.text ?? '')
                )
          );
        case 'wait':
          return result(
            sessionName,
            await current.runtime.waitFor(
              command.condition,
              command.target ? resolveTarget(current, command.target) : (command.text ?? '')
            )
          );
        case 'screenshot':
          return result(sessionName, await current.runtime.saveScreenshot(command.path));
        default:
          return { ok: false, session: sessionName, message: 'Unsupported command' };
      }

      if (response.ok) current.refs = null;
      return response;
    } catch (error) {
      return {
        ok: false,
        session: sessionName,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async closeAll(): Promise<void> {
    const current = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(current.map(({ runtime }) => runtime.close()));
  }

  private requireSession(name: string): SessionState {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(
        `No active session "${name}". Run appclaw-agent --session ${name} open first.`
      );
    }
    return session;
  }
}

function resolveTarget(state: SessionState, target: TargetInput): AgentTarget {
  if ('ref' in target) {
    if (!state.refs) {
      throw new Error(
        `Reference ${target.ref} is stale. Run snapshot -i again before interacting.`
      );
    }
    const value = state.refs.get(target.ref);
    if (!value) throw new Error(`Unknown reference ${target.ref}. Run snapshot -i again.`);
    return value;
  }
  if ('selector' in target) return { selector: target.selector };
  if ('coordinates' in target) return { coordinates: target.coordinates };
  throw new Error('Text targets are supported only by visibility and wait commands');
}

async function screenshotFallback(
  session: string,
  runtime: AgentRuntimeSession,
  visualQuery: string,
  pressIntent: boolean
): Promise<CommandResponse> {
  const screenshotPath = join(tmpdir(), `appclaw-visual-${Date.now()}.png`);
  await runtime.saveScreenshot(screenshotPath);
  const action = pressIntent
    ? `Determine the coordinates of "${visualQuery}" from the screenshot, then use press <x,y> to tap it.`
    : `Read this image file and visually determine if "${visualQuery}" is present on screen.`;
  return {
    ok: true,
    session,
    message: `Vision not configured — screenshot captured for visual analysis. ${action}`,
    screenshotPath,
    visualQuery,
  };
}

function result(
  session: string,
  operation: { success: boolean; message: string; value?: unknown }
): CommandResponse {
  return {
    ok: operation.success,
    session,
    message: operation.message,
    ...(operation.value !== undefined && { data: operation.value }),
  };
}
