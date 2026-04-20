/**
 * AppGuide — per-app knowledge injected into the agent's context.
 *
 * Built-in guides live in this file (keyed by package name / bundle ID).
 * Custom guides live in .appclaw/guides/<appId>.md — they take priority over built-ins,
 * so users can override or extend any guide without touching source code.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface AppGuide {
  name: string;
  content: string;
}

const GUIDES: Record<string, AppGuide> = {
  // ── Gmail ─────────────────────────────────────────────────────────────
  'com.google.android.gm': {
    name: 'Gmail',
    content: `## Gmail Navigation
- Hamburger menu (top-left) → folders (Inbox, Sent, Drafts, Trash, All Mail)
- Compose button: floating pencil/+ button at bottom-right
- Swipe right on an email → Archive; swipe left → Delete

## Searching
- Tap the search bar at the top; supports filters:
  from:sender@example.com | to:user@example.com | subject:keyword | has:attachment | is:unread

## Common Actions
- Archive: swipe right on the email row
- Delete: swipe left on the email row
- Select multiple: long-press an email to enter selection mode
- Star: tap the star icon next to the email
- Mark read/unread: long-press → select → tap the envelope icon

## Composing
- Tap the floating compose button (bottom-right pencil icon)
- Fill To / Subject / Body; attach via paperclip icon; send via paper-plane icon (top-right)

## Tips
- Primary / Social / Promotions tabs separate email categories
- Labels and filters are in Settings → account → Filters and Blocked Addresses`,
  },

  'com.google.gmail': {
    name: 'Gmail (iOS)',
    content: `## Gmail Navigation (iOS)
- Tap the three-line menu (top-left) for folders
- Compose: red pencil button bottom-right
- Swipe left on an email for Archive / Trash options

## Searching
- Search bar at top; same filters: from: to: subject: has:attachment is:unread

## Composing
- Tap the pencil button (bottom-right)
- Add recipients, subject, body; attach via paperclip; send via paper-plane icon`,
  },

  // ── YouTube ───────────────────────────────────────────────────────────
  'com.google.android.youtube': {
    name: 'YouTube',
    content: `## YouTube Navigation
- Bottom nav: Home | Shorts | + (upload) | Subscriptions | Library
- Search: magnifying-glass icon (top-right)
- Tap a video thumbnail to play; double-tap left/right to seek ±10 s

## Searching
- Tap the search icon → type query → press Enter or tap the search icon again
- Filter results: tap "Filters" after searching

## Common Actions
- Like: thumbs-up under the video
- Subscribe: red Subscribe button under/beside the channel name
- Save to playlist: tap ⋮ menu on a video → Save to playlist
- Share: tap the Share button under the video

## Playback
- Full screen: rotate device or tap the expand icon (bottom-right of player)
- Quality: tap ⋮ inside player → Quality
- Captions: tap CC icon inside player`,
  },

  'com.google.ios.youtube': {
    name: 'YouTube (iOS)',
    content: `## YouTube Navigation (iOS)
- Bottom nav: Home | Shorts | + | Subscriptions | Library
- Search: tap the search icon (top-right)
- Tap a thumbnail to play; double-tap sides to seek

## Common Actions
- Like: thumbs-up below video
- Subscribe: Subscribe button next to channel name
- Save: tap ⋮ on a video → Save to playlist`,
  },

  // ── WhatsApp ──────────────────────────────────────────────────────────
  'com.whatsapp': {
    name: 'WhatsApp',
    content: `## WhatsApp Navigation
- Bottom tabs: Chats | Updates | Communities | Calls
- New chat: floating pencil/message icon (bottom-right)
- Search: magnifying-glass icon at the top of Chats

## Messaging
- Open a chat → type in the message bar at the bottom → send via arrow icon
- Attach media: paperclip icon next to message bar
- Voice note: long-press the microphone icon
- Emoji/stickers: smiley face icon on the left of message bar

## Common Actions
- Star a message: long-press message → star icon
- Forward: long-press message → forward arrow
- Delete: long-press message → trash icon
- Group info: tap the group name at the top of the chat`,
  },

  'net.whatsapp.WhatsApp': {
    name: 'WhatsApp (iOS)',
    content: `## WhatsApp Navigation (iOS)
- Bottom tabs: Chats | Updates | Communities | Calls
- New chat: pencil icon (top-right)
- Search: pull down on Chats list

## Messaging
- Open chat → message bar → send with arrow
- Attach: + icon to the left of the message bar`,
  },

  // ── Chrome ────────────────────────────────────────────────────────────
  'com.android.chrome': {
    name: 'Chrome',
    content: `## Chrome Navigation
- Address bar at the top: tap to type a URL or search query, then press Enter
- Back/forward: use device back button or long-press back for history
- Tabs: square icon (top-right) shows open tabs; tap + to open a new tab
- Menu: three-dot icon (top-right) for bookmarks, history, settings, etc.

## Common Actions
- Bookmark: three-dot menu → Bookmark (star) or tap the star in the address bar
- Share: three-dot menu → Share
- Find in page: three-dot menu → Find in page
- Refresh: circular arrow in the address bar (or pull down on the page)
- Incognito tab: three-dot menu → New Incognito Tab`,
  },

  'com.google.chrome': {
    name: 'Chrome (iOS)',
    content: `## Chrome Navigation (iOS)
- Address bar at top: tap → type URL or search → Go
- Tabs: tab count button (bottom-right)
- Three-dot menu (bottom-right) for bookmarks, history, settings`,
  },

  // ── Settings ──────────────────────────────────────────────────────────
  'com.android.settings': {
    name: 'Android Settings',
    content: `## Settings Navigation
- Use the search bar at the top to find any setting by keyword
- Main sections: Network & internet | Connected devices | Apps | Battery | Display | Sound | Storage | Security | Privacy | Location | Accounts | Accessibility | System

## Common Paths
- Wi-Fi: Network & internet → Internet
- Bluetooth: Connected devices → Connection preferences → Bluetooth
- Notification settings: Notifications (top-level or via Apps → app name)
- App permissions: Apps → (app name) → Permissions
- Developer options: System → Developer options (enable via Build number tap ×7)`,
  },

  'com.apple.Preferences': {
    name: 'iOS Settings',
    content: `## iOS Settings Navigation
- Search bar at the top of the settings list — fastest way to find any setting
- Main sections: Wi-Fi | Bluetooth | Cellular | Notifications | Sounds | Focus | Screen Time | General | Display | Accessibility | Privacy & Security | App Store | Wallet | Passwords | (installed apps at the bottom)

## Common Paths
- Wi-Fi: Settings → Wi-Fi → toggle or select network
- Bluetooth: Settings → Bluetooth
- App notifications: Settings → Notifications → (app name)
- Location services: Settings → Privacy & Security → Location Services
- Battery: Settings → Battery`,
  },
};

/**
 * Returns the AppGuide content for the given app ID, or undefined if none found.
 *
 * Resolution order:
 *   1. .appclaw/guides/<appId>.md  (user custom — wins over built-ins)
 *   2. Built-in GUIDES map
 */
export function loadAppGuide(appId: string): string | undefined {
  if (!appId) return undefined;

  // 1. User custom guide
  const customPath = join(process.cwd(), '.appclaw', 'guides', `${appId}.md`);
  if (existsSync(customPath)) {
    const content = readFileSync(customPath, 'utf-8').trim();
    if (content) return `APP_GUIDE (${appId}):\n${content}`;
  }

  // 2. Built-in guide
  const guide = GUIDES[appId];
  if (!guide) return undefined;
  return `APP_GUIDE (${guide.name}):\n${guide.content}`;
}

/** Returns true if an AppGuide exists for the given app ID (built-in or custom). */
export function hasAppGuide(appId: string): boolean {
  if (!appId) return false;
  const customPath = join(process.cwd(), '.appclaw', 'guides', `${appId}.md`);
  return existsSync(customPath) || appId in GUIDES;
}
