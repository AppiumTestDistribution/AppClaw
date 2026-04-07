/**
 * Flows tree view — shows YAML flow files in the workspace.
 */

import * as vscode from 'vscode';
import * as path from 'path';

export class FlowsTreeProvider implements vscode.TreeDataProvider<FlowItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: FlowItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<FlowItem[]> {
    const files = await vscode.workspace.findFiles('**/*.{yaml,yml}', '**/node_modules/**', 100);

    // Filter to files that look like AppClaw flows (contain `steps:`)
    const flowFiles: FlowItem[] = [];

    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText(new vscode.Range(0, 0, 30, 0)); // read first 30 lines
        const isSuite = text.includes('flows:');
        const isFlow = text.includes('steps:');
        if (isSuite || isFlow) {
          flowFiles.push(new FlowItem(uri, isSuite));
        }
      } catch {
        // skip unreadable files
      }
    }

    if (flowFiles.length === 0) {
      const empty = new vscode.TreeItem('No flow files found');
      empty.description = 'Create a .yaml file with steps:';
      return [empty as any];
    }

    return flowFiles.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
  }
}

class FlowItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    isSuite = false
  ) {
    const relativePath = vscode.workspace.asRelativePath(uri);
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);

    this.description = path.dirname(relativePath);
    this.iconPath = new vscode.ThemeIcon(isSuite ? 'list-flat' : 'file');
    this.tooltip = relativePath + (isSuite ? ' (suite)' : '');
    this.contextValue = isSuite ? 'suiteFile' : 'flowFile';

    this.command = {
      command: 'vscode.open',
      title: 'Open Flow',
      arguments: [uri],
    };
  }
}
