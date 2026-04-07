/**
 * History tree view — shows recent AppClaw executions.
 */

import * as vscode from 'vscode';

export interface HistoryEntry {
  goal: string;
  success: boolean;
  steps: number;
  timestamp: Date;
  duration?: number;
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private entries: HistoryEntry[] = [];

  addEntry(entry: HistoryEntry): void {
    this.entries.unshift(entry); // newest first
    if (this.entries.length > 50) {
      this.entries.pop();
    }
    this._onDidChange.fire();
  }

  getTreeItem(element: HistoryItem): vscode.TreeItem {
    return element;
  }

  getChildren(): HistoryItem[] {
    if (this.entries.length === 0) {
      const empty = new vscode.TreeItem('No runs yet');
      empty.description = 'Run a goal to see history';
      return [empty as any];
    }

    return this.entries.map((e) => new HistoryItem(e));
  }
}

class HistoryItem extends vscode.TreeItem {
  constructor(entry: HistoryEntry) {
    super(entry.goal, vscode.TreeItemCollapsibleState.None);

    const icon = entry.success ? 'pass' : 'error';
    const statusText = entry.success ? 'Passed' : 'Failed';
    const time = entry.timestamp.toLocaleTimeString();

    this.description = `${statusText} · ${entry.steps} steps · ${time}`;
    this.iconPath = new vscode.ThemeIcon(
      icon,
      entry.success
        ? new vscode.ThemeColor('testing.iconPassed')
        : new vscode.ThemeColor('testing.iconFailed')
    );
    this.tooltip = `${entry.goal}\n${statusText} in ${entry.steps} steps\n${entry.timestamp.toLocaleString()}`;
  }
}
