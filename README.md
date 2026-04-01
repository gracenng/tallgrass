# Tallgrass

A simple, privacy-respecting Chrome extension that helps you limit time on distracting websites.

No analytics. No tracking. No network calls. No dependencies. Every line of code is readable and auditable.

## How it works

1. Add distracting domains to your blacklist (e.g. `twitter.com`, `reddit.com`)
2. Set a daily time limit (default: 30 minutes)
3. Tallgrass tracks time spent on those sites and shows a live timer in the popup and a badge on the extension icon
4. When the limit is reached, all blacklisted sites are blocked until midnight — no bypass, no exceptions
5. The blacklist and time limit controls are locked while blocked so you can't cheat

All data stays in `chrome.storage.local` on your machine. Nothing leaves the browser.

## Installing

1. Clone this repo
2. Open `chrome://extensions` in Chrome (or any Chromium browser)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder
5. Pin the Tallgrass icon in your toolbar

## File structure

```
tallgrass/
├── manifest.json      Extension manifest (Manifest V3)
├── background.js      Service worker — time tracking, blocking, daily reset
├── popup.html         Popup shell
├── popup.css          Popup styles
├── popup.js           Popup logic — blacklist CRUD, timer display, limit control
├── blocked.html       Block page shell
├── blocked.css        Block page styles
├── blocked.js         Block page logic — time spent display, midnight countdown
└── icons/
    ├── icon16.png     Toolbar icon
    ├── icon48.png     Extensions page icon
    └── icon128.png    Chrome Web Store icon
```

### manifest.json

Declares the extension for Chrome. Manifest V3. Permissions used:

- **storage** — save blacklist, time data, and blocked state locally
- **tabs** — read the active tab's URL to know when you're on a blacklisted site
- **alarms** — 1-minute heartbeat to flush tracked time (survives service worker restarts)
- **declarativeNetRequest** — redirect blacklisted domains to the block page when the limit is hit
- **host_permissions (`<all_urls>`)** — required by declarativeNetRequest to intercept any domain

### background.js

The core engine. Runs as a service worker with no persistent state beyond `chrome.storage.local`.

- **Time tracking**: listens to tab activation, tab URL changes, and window focus events. When the active tab is on a blacklisted domain, it records a start timestamp in memory. Time is flushed to storage on tab switches, window blur, and a 1-minute alarm heartbeat.
- **Domain matching**: checks if a tab's hostname matches or is a subdomain of any blacklisted domain (e.g. blocking `twitter.com` also blocks `mobile.twitter.com`).
- **Blocking**: when accumulated time hits the limit, applies `declarativeNetRequest` redirect rules for every blacklisted domain and redirects the current tab to `blocked.html`.
- **Daily reset**: compares `lastResetDate` to today on every event. On a new day, resets time to zero, clears the blocked state, and removes all redirect rules.
- **Badge**: shows elapsed time on the extension icon when on a tracked site. Color shifts from blue to orange (50%) to red (75%).
- **Message handler**: responds to `getStatus` messages from the popup with real-time data (stored time + unflushed in-memory elapsed), and triggers an immediate block if the limit is exceeded.

### popup.html / popup.css / popup.js

The extension popup (360px wide). Shows:

- A live ticking timer (`MM:SS / limit`) that polls the background every second
- The blacklist with add/remove controls
- A daily limit adjuster (5–480 minutes, in 5-minute steps)

When blocked, the timer turns red, a banner appears, and all controls are disabled.

### blocked.html / blocked.css / blocked.js

The full-page block screen shown when the time limit is reached (via declarativeNetRequest redirect). Shows:

- A calm message
- Total time spent today
- Countdown to midnight when access resets

Updates the countdown every minute. No links, no escape hatches.

### icons/

Simple green circle PNGs at 16, 48, and 128 pixels.

## Privacy

This extension makes zero network requests. You can verify by inspecting the service worker in `chrome://extensions` — open DevTools on the background script and check the Network tab. The source is intentionally small (~300 lines of JS total) so anyone can audit it.
