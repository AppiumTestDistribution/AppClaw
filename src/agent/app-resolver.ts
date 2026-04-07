/**
 * App resolver — fetches installed apps from the device and resolves
 * app names to package IDs for direct launching.
 */

import type { MCPClient } from '../mcp/types.js';
import * as ui from '../ui/terminal.js';

export interface InstalledApp {
  packageName: string;
  label: string;
}

/** Well-known package names for common Android apps */
const WELL_KNOWN_ANDROID_APPS: Record<string, string> = {
  settings: 'com.android.settings',
  chrome: 'com.android.chrome',
  whatsapp: 'com.whatsapp',
  instagram: 'com.instagram.android',
  facebook: 'com.facebook.katana',
  messenger: 'com.facebook.orca',
  twitter: 'com.twitter.android',
  x: 'com.twitter.android',
  youtube: 'com.google.android.youtube',
  gmail: 'com.google.android.gm',
  maps: 'com.google.android.apps.maps',
  'google maps': 'com.google.android.apps.maps',
  calendar: 'com.google.android.calendar',
  camera: 'com.android.camera',
  phone: 'com.android.dialer',
  contacts: 'com.android.contacts',
  messages: 'com.google.android.apps.messaging',
  calculator: 'com.android.calculator2',
  clock: 'com.android.deskclock',
  files: 'com.google.android.apps.nbu.files',
  photos: 'com.google.android.apps.photos',
  spotify: 'com.spotify.music',
  telegram: 'org.telegram.messenger',
  slack: 'com.Slack',
  netflix: 'com.netflix.mediaclient',
  uber: 'com.ubercab',
  rapido: 'com.rapido.passenger',
  ola: 'com.olacabs.customer',
  swiggy: 'in.swiggy.android',
  zomato: 'com.application.zomato',
  paytm: 'net.one97.paytm',
  phonepe: 'com.phonepe.app',
  gpay: 'com.google.android.apps.nbu.paisa.user',
  amazon: 'in.amazon.mShop.android.shopping',
  flipkart: 'com.flipkart.android',
  snapchat: 'com.snapchat.android',
  linkedin: 'com.linkedin.android',
  truecaller: 'com.truecaller',
  makemytrip: 'com.makemytrip',
  booking: 'com.booking',
  airbnb: 'com.airbnb.android',
};

/** Well-known bundle IDs for common iOS apps */
const WELL_KNOWN_IOS_APPS: Record<string, string> = {
  settings: 'com.apple.Preferences',
  safari: 'com.apple.mobilesafari',
  chrome: 'com.google.chrome.ios',
  whatsapp: 'net.whatsapp.WhatsApp',
  instagram: 'com.burbn.instagram',
  facebook: 'com.facebook.Facebook',
  messenger: 'com.facebook.Messenger',
  twitter: 'com.atebits.Tweetie2',
  x: 'com.atebits.Tweetie2',
  youtube: 'com.google.ios.youtube',
  gmail: 'com.google.Gmail',
  maps: 'com.apple.Maps',
  'google maps': 'com.google.Maps',
  'apple maps': 'com.apple.Maps',
  calendar: 'com.apple.mobilecal',
  camera: 'com.apple.camera',
  phone: 'com.apple.mobilephone',
  contacts: 'com.apple.MobileAddressBook',
  messages: 'com.apple.MobileSMS',
  calculator: 'com.apple.calculator',
  clock: 'com.apple.mobiletimer',
  files: 'com.apple.DocumentsApp',
  photos: 'com.apple.mobileslideshow',
  music: 'com.apple.Music',
  spotify: 'com.spotify.client',
  telegram: 'ph.telegra.Telegraph',
  slack: 'com.tinyspeck.chatlyio',
  netflix: 'com.netflix.Netflix',
  uber: 'com.ubercab.UberClient',
  snapchat: 'com.toyopagroup.picaboo',
  linkedin: 'com.linkedin.LinkedIn',
  notes: 'com.apple.mobilenotes',
  reminders: 'com.apple.reminders',
  weather: 'com.apple.weather',
  mail: 'com.apple.mobilemail',
  'app store': 'com.apple.AppStore',
  podcasts: 'com.apple.podcasts',
  news: 'com.apple.news',
  health: 'com.apple.Health',
  wallet: 'com.apple.Passbook',
  'find my': 'com.apple.findmy',
  shortcuts: 'com.apple.shortcuts',
  airbnb: 'com.airbnb.app',
  amazon: 'com.amazon.Amazon',
};

export class AppResolver {
  private apps: InstalledApp[] = [];
  /** Well-known app names — always checked first, highest priority */
  private wellKnown: Map<string, string> = new Map();
  /** App labels and package segments — lower priority */
  private appsByName: Map<string, string> = new Map();
  /** All package name segments for fuzzy searching */
  private packageSegments: Array<{ segment: string; packageName: string }> = [];
  private initialized = false;
  private platform: 'android' | 'ios' = 'android';

  /** Fetch installed apps from device and build lookup */
  async initialize(mcp: MCPClient, platform?: 'android' | 'ios'): Promise<void> {
    if (platform) this.platform = platform;

    // Populate well-known apps first (always available, even if device fetch fails)
    const wellKnownApps = this.platform === 'ios' ? WELL_KNOWN_IOS_APPS : WELL_KNOWN_ANDROID_APPS;
    for (const [name, pkg] of Object.entries(wellKnownApps)) {
      this.wellKnown.set(name.toLowerCase(), pkg);
    }

    try {
      const result = await mcp.callTool('appium_list_apps', {});
      const text = result.content?.map((c: any) => c.text ?? '').join('\n') ?? '';

      this.apps = parseAppList(text);

      // Build name → packageName lookup from device data
      for (const app of this.apps) {
        if (app.label && app.label !== app.packageName) {
          this.appsByName.set(app.label.toLowerCase(), app.packageName);
        }

        // Index all meaningful segments of the package name
        const segments = app.packageName.split('.');
        for (const seg of segments) {
          if (
            seg.length >= 3 &&
            !['com', 'org', 'net', 'android', 'app', 'sec', 'google', 'samsung'].includes(seg)
          ) {
            this.appsByName.set(seg.toLowerCase(), app.packageName);
            this.packageSegments.push({ segment: seg.toLowerCase(), packageName: app.packageName });
          }
        }
      }

      this.initialized = true;
      ui.printSetupOk(`Device connected (${this.apps.length} apps)`);
    } catch (err) {
      ui.printWarning(`Could not fetch app list: ${err}`);
      this.initialized = true;
    }
  }

  /** Resolve an app name to its package ID */
  resolve(name: string): string | null {
    const lower = name.toLowerCase().trim();
    const withS = lower.endsWith('s') ? lower.slice(0, -1) : lower + 's';

    // 1. Well-known apps (highest priority — exact match)
    if (this.wellKnown.has(lower)) {
      return this.wellKnown.get(lower)!;
    }
    // 1b. Well-known plural/singular variant (setting→settings, contact→contacts)
    if (this.wellKnown.has(withS)) {
      return this.wellKnown.get(withS)!;
    }

    // 2. Device app labels and segments (exact match)
    if (this.appsByName.has(lower)) {
      return this.appsByName.get(lower)!;
    }
    // 2b. Plural/singular variant
    if (this.appsByName.has(withS)) {
      return this.appsByName.get(withS)!;
    }

    // 3. Check if input is already a package name
    if (lower.includes('.') && lower.split('.').length >= 2) {
      // Verify it exists in installed apps
      const exists = this.apps.some((a) => a.packageName.toLowerCase() === lower);
      if (exists) return lower;
      return lower; // trust user even if not in list
    }

    // 4. Segment prefix/includes match
    // "vodqa" should match segment "vodqareactnative" (starts with "vodqa")
    for (const { segment, packageName } of this.packageSegments) {
      if (segment.startsWith(lower) || lower.startsWith(segment)) {
        return packageName;
      }
    }

    // 5. Substring match on segments (for partial names)
    // Only if search term is 4+ chars to avoid false positives
    if (lower.length >= 4) {
      for (const { segment, packageName } of this.packageSegments) {
        if (segment.includes(lower)) {
          return packageName;
        }
      }
    }

    return null;
  }

  /** Get compact app list string for LLM context */
  getAppListForContext(): string {
    if (this.apps.length === 0) {
      return 'App list not available. Use well-known package names.';
    }
    // Filter to user-facing apps (exclude system/overlay packages)
    const userApps = this.apps.filter((a) => {
      const pkg = a.packageName;
      return (
        !pkg.includes('overlay') &&
        !pkg.includes('systemui') &&
        !pkg.includes('provider') &&
        !pkg.includes('internal') &&
        !pkg.startsWith('android.') &&
        !pkg.includes('.SMT.') &&
        !pkg.includes('navbar')
      );
    });
    return userApps
      .slice(0, 60)
      .map((a) => a.packageName)
      .join(', ');
  }
}

function parseAppList(text: string): InstalledApp[] {
  const apps: InstalledApp[] = [];

  // Try to extract JSON — handle "Installed apps: [...]" prefix
  const jsonStart = text.indexOf('[');
  const jsonEnd = text.lastIndexOf(']');
  if (jsonStart !== -1 && jsonEnd !== -1) {
    try {
      const parsed = JSON.parse(text.substring(jsonStart, jsonEnd + 1));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const pkg = item.packageName || item.package || item.appPackage || '';
          const label = item.label || item.appName || item.name || '';
          if (pkg) {
            apps.push({ packageName: pkg, label });
          }
        }
        return apps;
      }
    } catch {
      // Not valid JSON
    }
  }

  // Fallback: parse text format
  const lines = text.split('\n');
  for (const line of lines) {
    const pkgMatch = line.match(/([a-zA-Z][a-zA-Z0-9_.]*\.[a-zA-Z][a-zA-Z0-9_.]+)/);
    if (pkgMatch) {
      const pkg = pkgMatch[1];
      const label = line
        .replace(pkg, '')
        .replace(/[:\-|]/g, '')
        .trim();
      apps.push({ packageName: pkg, label: label || pkg });
    }
  }

  return apps;
}
