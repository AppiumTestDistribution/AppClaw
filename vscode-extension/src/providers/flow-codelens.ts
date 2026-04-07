/**
 * CodeLens provider for AppClaw YAML flow files.
 *
 * Adds "Run Flow" at the top and "Run Step" on each step line.
 * Supports both flat (steps:) and phased (setup:/steps:/assertions:) formats.
 */

import * as vscode from 'vscode';
import * as path from 'path';

/** Matches section keys that contain runnable steps */
const SECTION_KEY = /^\s*(setup|steps|assertions)\s*:/;

/** Matches any YAML list item that's a flow step */
const STEP_LINE = /^\s+-\s+\S/;

export class FlowCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const text = document.getText();
    const lenses: vscode.CodeLens[] = [];
    const topRange = new vscode.Range(0, 0, 0, 0);

    // ── Suite YAML (has `flows:` key) ───────────────────────────────
    if (/^\s*flows\s*:/m.test(text)) {
      lenses.push(
        new vscode.CodeLens(topRange, {
          title: '$(play) Run Suite',
          command: 'appclaw.runFlow',
          arguments: [document.uri],
        })
      );

      const suiteDir = path.dirname(document.uri.fsPath);
      for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i).text;
        const m = line.match(/^\s*-\s+(\S+\.ya?ml)\s*$/);
        if (m) {
          const flowPath = path.resolve(suiteDir, m[1]);
          const range = new vscode.Range(i, 0, i, 0);
          lenses.push(
            new vscode.CodeLens(range, {
              title: '$(play) Run',
              command: 'appclaw.runFlow',
              arguments: [vscode.Uri.file(flowPath)],
            })
          );
        }
      }
      return lenses;
    }

    // ── Flow YAML (has steps/setup/assertions) ──────────────────────
    if (!/^\s*(setup|steps|assertions)\s*:/m.test(text)) {
      return [];
    }

    // Top-of-file: Run entire flow
    lenses.push(
      new vscode.CodeLens(topRange, {
        title: '$(play) Run Flow',
        command: 'appclaw.runFlow',
        arguments: [document.uri],
      })
    );

    // Per-step CodeLens — find lines under setup:/steps:/assertions:
    let inSection = false;
    let currentSection = '';
    let stepIndex = 0;
    const sectionLabels: Record<string, string> = {
      setup: 'Setup',
      steps: 'Step',
      assertions: 'Assert',
    };

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;

      const sectionMatch = line.match(SECTION_KEY);
      if (sectionMatch) {
        inSection = true;
        currentSection = sectionMatch[1];
        // Add section header lens
        const range = new vscode.Range(i, 0, i, 0);
        const icon =
          currentSection === 'assertions'
            ? '$(beaker)'
            : currentSection === 'setup'
              ? '$(gear)'
              : '$(play)';
        lenses.push(
          new vscode.CodeLens(range, {
            title: `${icon} ${sectionLabels[currentSection]} Phase`,
            command: '',
          })
        );
        continue;
      }

      // Left-aligned non-empty line after a section means we've left it
      if (inSection && /^\S/.test(line) && line.trim() !== '') {
        inSection = false;
      }

      if (inSection && STEP_LINE.test(line)) {
        stepIndex++;
        const range = new vscode.Range(i, 0, i, 0);
        const prefix = sectionLabels[currentSection] || 'Step';
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(debug-start) ${prefix} ${stepIndex}`,
            command: 'appclaw.runFlowStep',
            arguments: [document.uri, stepIndex],
          })
        );
      }
    }

    return lenses;
  }
}
