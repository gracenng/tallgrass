// Tallgrass — Background Service Worker
// Tracks time on blacklisted sites and enforces daily limits.
// No network calls, no analytics, no data collection.

const DEFAULTS = {
  blacklist: [],
  timeLimitMinutes: 30,
  timeSpentMs: 0,
  lastResetDate: todayString(),
  isBlocked: false,
};

const BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");

// Longest stretch a single flush may charge. The heartbeat flushes every
// minute, so a bigger gap means the computer was asleep, not browsing.
const MAX_FLUSH_MS = 2 * 60_000;

// Tracking state: { tabId, domain, startTime } or null.
// Mirrored in storage.session so it survives service worker restarts (Chrome
// stops the worker after ~30s idle). storage.session is cleared when the
// extension is disabled or the browser restarts.
let tracking = null;
const ready = chrome.storage.session.get("tracking").then((r) => {
  tracking = r.tracking ?? null;
});

function setTracking(value) {
  tracking = value;
  return chrome.storage.session.set({ tracking: value });
}

function trackedElapsedMs() {
  if (!tracking) return 0;
  return Math.max(0, Math.min(Date.now() - tracking.startTime, MAX_FLUSH_MS));
}

// --- Helpers ---

function todayString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isDomainBlacklisted(hostname, blacklist) {
  return blacklist.some(
    (blocked) => hostname === blocked || hostname.endsWith("." + blocked)
  );
}

async function getData() {
  await ready;
  return chrome.storage.local.get(DEFAULTS);
}

function formatBadgeTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours + "h" + (remaining > 0 ? remaining : "");
}

async function updateBadge() {
  const data = await getData();

  if (data.isBlocked) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e03e3e" });
    chrome.action.setBadgeTextColor({ color: "#ffffff" });
    return;
  }

  if (tracking) {
    const liveTimeMs = data.timeSpentMs + trackedElapsedMs();
    const percent = liveTimeMs / (data.timeLimitMinutes * 60_000);
    let color;
    if (percent >= 0.75) {
      color = "#e03e3e"; // red
    } else if (percent >= 0.5) {
      color = "#f2994a"; // orange
    } else {
      color = "#2eaadc"; // blue
    }
    chrome.action.setBadgeText({ text: formatBadgeTime(liveTimeMs) });
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeTextColor({ color: "#ffffff" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// --- Daily Reset ---

async function checkAndResetIfNewDay() {
  const data = await getData();
  const today = todayString();
  if (data.lastResetDate !== today) {
    await chrome.storage.local.set({
      timeSpentMs: 0,
      lastResetDate: today,
      isBlocked: false,
    });
    await removeBlockingRules();
    // Don't charge time from before midnight to today's budget.
    if (tracking) await setTracking({ ...tracking, startTime: Date.now() });
    return true;
  }
  return false;
}

// --- Blocking ---

function redirectIfBlacklisted(tabId, url, blacklist) {
  const hostname = url && getDomain(url);
  if (hostname && isDomainBlacklisted(hostname, blacklist)) {
    chrome.tabs.update(tabId, { url: BLOCKED_PAGE }).catch(() => {});
  }
}

// Redirect every open tab showing a blocked domain: other windows, background
// tabs, and tabs opened while the extension was disabled.
async function redirectAllBlockedTabs(blacklist) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    redirectIfBlacklisted(tab.id, tab.url || tab.pendingUrl, blacklist);
  }
}

// Disabling the extension kills its pages, so block pages that were open turn
// into error pages. Reload them once the extension is back.
async function reloadBlockPages() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl || "";
    if (url.startsWith(BLOCKED_PAGE)) {
      chrome.tabs.update(tab.id, { url: BLOCKED_PAGE }).catch(() => {});
    }
  }
}

// "block" rather than "redirect": redirect needs host permissions, which this
// extension doesn't request. The request never reaches the site, and the tab
// listeners below then swap Chrome's error page for blocked.html.
async function applyBlockingRules(blacklist) {
  await removeBlockingRules();

  const rules = blacklist.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: "||" + domain + "^", // ^ so "x.com" doesn't match "x.company.com"
      resourceTypes: ["main_frame"],
    },
  }));

  if (rules.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
  }
}

async function removeBlockingRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const ids = existing.map((r) => r.id);
  if (ids.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ids,
    });
  }
}

// --- Time Tracking ---

// Flushes run one at a time so overlapping events can't both read the old
// timeSpentMs and drop each other's time.
let flushQueue = Promise.resolve();
function flushTracking() {
  flushQueue = flushQueue.then(doFlush, doFlush);
  return flushQueue;
}

async function doFlush() {
  await checkAndResetIfNewDay();

  const elapsed = trackedElapsedMs();
  if (tracking) await setTracking({ ...tracking, startTime: Date.now() });

  const data = await getData();
  if (data.isBlocked) return;

  const newTimeSpent = data.timeSpentMs + elapsed;
  if (elapsed > 0) {
    await chrome.storage.local.set({ timeSpentMs: newTimeSpent });
  }

  // Checked even when nothing is being tracked, so a lowered limit blocks
  // right away.
  const limitMs = data.timeLimitMinutes * 60_000;
  if (newTimeSpent >= limitMs && data.blacklist.length > 0) {
    await chrome.storage.local.set({ isBlocked: true });
    await setTracking(null);
    await applyBlockingRules(data.blacklist);
    await redirectAllBlockedTabs(data.blacklist);
  }
}

async function startTrackingIfNeeded() {
  await flushTracking();

  const data = await getData();
  if (data.isBlocked || data.blacklist.length === 0) {
    if (tracking) await setTracking(null);
    return;
  }

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    return;
  }

  const hostname = tab?.url ? getDomain(tab.url) : null;
  if (hostname && isDomainBlacklisted(hostname, data.blacklist)) {
    if (!tracking || tracking.tabId !== tab.id) {
      await setTracking({ tabId: tab.id, domain: hostname, startTime: Date.now() });
    }
  } else if (tracking) {
    await setTracking(null);
  }
}

// --- Event Listeners ---

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const data = await getData();
  if (data.isBlocked) {
    // Guard against switching to an already-loaded banned-site tab.
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      redirectIfBlacklisted(tab.id, tab.url, data.blacklist);
    } catch {
      // Tab may have been closed
    }
    await updateBadge();
    return;
  }
  await startTrackingIfNeeded();
  await updateBadge();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    const data = await getData();
    if (data.isBlocked) {
      // Swaps the declarativeNetRequest error page for blocked.html, and
      // catches back/forward cache restores, which make no network request.
      redirectIfBlacklisted(tabId, tab.url, data.blacklist);
      await updateBadge();
      return;
    }
    await startTrackingIfNeeded();
    await updateBadge();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (tracking && tracking.tabId === tabId) {
    await flushTracking();
    await setTracking(null);
  }
  await updateBadge();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await flushTracking();
    await setTracking(null);
  } else {
    await startTrackingIfNeeded();
  }
  await updateBadge();
});

// Alarm heartbeat: flush time every minute. Only created if missing, since
// re-creating it on every worker start would keep pushing the next tick back.
chrome.alarms.get("heartbeat").then((alarm) => {
  if (!alarm) chrome.alarms.create("heartbeat", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "heartbeat") {
    await startTrackingIfNeeded();
    await updateBadge();
  }
});

// --- Message Handler (for popup live updates) ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getStatus") {
    (async () => {
      await checkAndResetIfNewDay();
      let data = await getData();
      let liveTimeSpentMs = data.timeSpentMs + trackedElapsedMs();

      // Trigger the block immediately once the limit is hit.
      const limitMs = data.timeLimitMinutes * 60_000;
      if (!data.isBlocked && liveTimeSpentMs >= limitMs) {
        await flushTracking();
        await updateBadge();
        data = await getData();
        liveTimeSpentMs = Math.max(data.timeSpentMs, limitMs);
      }

      sendResponse({
        timeSpentMs: liveTimeSpentMs,
        timeLimitMinutes: data.timeLimitMinutes,
        blacklist: data.blacklist,
        isBlocked: data.isBlocked,
      });
    })();
    return true;
  }
});

// --- React to settings changes ---

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;

  if (changes.blacklist) {
    const data = await getData();
    // Re-apply blocking rules if currently blocked so new list takes effect
    if (data.isBlocked) {
      await applyBlockingRules(data.blacklist);
      await redirectAllBlockedTabs(data.blacklist);
    }
  }

  if (changes.blacklist || changes.timeLimitMinutes) {
    await startTrackingIfNeeded();
    await updateBadge();
  }
});

// --- Startup ---

// Runs every time the service worker starts. onStartup/onInstalled don't fire
// when the extension is re-enabled in chrome://extensions, and tabs opened
// while it was disabled fire no events, so state is restored here.
async function init() {
  await ready;
  // storage.session is empty after a re-enable or browser restart.
  const { active } = await chrome.storage.session.get("active");
  await chrome.storage.session.set({ active: true });

  await checkAndResetIfNewDay();
  const data = await getData();
  if (data.isBlocked) {
    if (!active) {
      await applyBlockingRules(data.blacklist);
      await reloadBlockPages();
    }
    await redirectAllBlockedTabs(data.blacklist);
  } else {
    await startTrackingIfNeeded();
  }
  await updateBadge();
}

init();
