/**
 * Devices tree view — shows connected Android/iOS devices.
 */

import * as vscode from 'vscode';
import { execSync } from 'child_process';

interface DeviceInfo {
  id: string;
  name: string;
  platform: 'android' | 'ios';
  state: string;
}

export class DevicesTreeProvider implements vscode.TreeDataProvider<DeviceItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private devices: DeviceInfo[] = [];

  refresh(): void {
    this.devices = [...this.getAndroidDevices(), ...this.getIOSDevices()];
    this._onDidChange.fire();
  }

  getTreeItem(element: DeviceItem): vscode.TreeItem {
    return element;
  }

  getChildren(): DeviceItem[] {
    if (this.devices.length === 0) {
      this.refresh();
    }

    if (this.devices.length === 0) {
      const empty = new DeviceItem('No devices found', '', 'none', 'offline');
      empty.description = 'Connect a device or start an emulator';
      return [empty];
    }

    return this.devices.map((d) => new DeviceItem(d.name, d.id, d.platform, d.state));
  }

  private getAndroidDevices(): DeviceInfo[] {
    try {
      const output = execSync('adb devices -l', {
        timeout: 5000,
        encoding: 'utf-8',
      });
      const lines = output.split('\n').slice(1); // skip header
      const devices: DeviceInfo[] = [];

      for (const line of lines) {
        const match = line.match(/^(\S+)\s+device\s+(.*)/);
        if (match) {
          const id = match[1];
          const props = match[2] || '';
          const modelMatch = props.match(/model:(\S+)/);
          const name = modelMatch ? modelMatch[1].replace(/_/g, ' ') : id;
          devices.push({
            id,
            name,
            platform: 'android',
            state: 'device',
          });
        }
      }
      return devices;
    } catch {
      return [];
    }
  }

  private getIOSDevices(): DeviceInfo[] {
    if (process.platform !== 'darwin') {
      return [];
    }

    try {
      const output = execSync('xcrun simctl list devices available -j', {
        timeout: 5000,
        encoding: 'utf-8',
      });
      const data = JSON.parse(output);
      const devices: DeviceInfo[] = [];

      for (const [runtime, devs] of Object.entries(data.devices as Record<string, any[]>)) {
        if (!runtime.includes('iOS')) {
          continue;
        }
        for (const dev of devs) {
          if (dev.state === 'Booted') {
            devices.push({
              id: dev.udid,
              name: dev.name,
              platform: 'ios',
              state: 'Booted',
            });
          }
        }
      }
      return devices;
    } catch {
      return [];
    }
  }
}

class DeviceItem extends vscode.TreeItem {
  constructor(
    public readonly deviceName: string,
    public readonly deviceId: string,
    public readonly platform: string,
    public readonly state: string
  ) {
    super(deviceName, vscode.TreeItemCollapsibleState.None);

    const icon = platform === 'ios' ? 'device-mobile' : 'device-mobile';
    const platformLabel = platform === 'ios' ? 'iOS' : 'Android';

    this.description = `${platformLabel} · ${deviceId}`;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = `${deviceName}\n${platformLabel} · ${deviceId}\nState: ${state}`;
    this.contextValue = 'device';
  }
}
