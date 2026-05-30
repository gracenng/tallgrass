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

// In-memory tracking state (lost on service worker restart, recovered via alarm)
let tracking = null; // { tabId, domain, startTime }

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
  const data = await chrome.storage.local.get(DEFAULTS);
  return data;
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
  let liveTimeMs = data.timeSpentMs;
  if (tracking) {
    liveTimeMs += Date.now() - tracking.startTime;
  }

  if (data.isBlocked) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e03e3e" });
    chrome.action.setBadgeTextColor({ color: "#ffffff" });
    return;
  }

  if (tracking) {
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
    // Reset tracking start time so elapsed time from yesterday isn't charged
    // to today's budget on the next flushTracking() call.
    if (tracking) tracking.startTime = Date.now();
    return true;
  }
  return false;
}

// --- Blocking Rules (declarativeNetRequest) ---

// Redirect every open tab that is currently displaying a blocked domain.
// Called when blocking first fires (covers tabs in other windows, background
// tabs, and tabs the user was looking at but didn't trigger the active-tab
// redirect).
async function redirectAllBlockedTabs(blacklist) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      const hostname = getDomain(tab.url);
      if (hostname && isDomainBlacklisted(hostname, blacklist)) {
        chrome.tabs.update(tab.id, {
          url: chrome.runtime.getURL("blocked.html"),
        });
      }
    }
  } catch {
    // Tabs may have been closed
  }
}

async function applyBlockingRules(blacklist) {
  // Remove any existing rules first
  await removeBlockingRules();

  const rules = blacklist.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { extensionPath: "/blocked.html" },
    },
    condition: {
      urlFilter: "||" + domain,
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

async function flushTracking() {
  if (!tracking) return;

  const now = Date.now();
  const elapsed = now - tracking.startTime;
  tracking.startTime = now;

  if (elapsed <= 0) return;

  const data = await getData();
  const newTimeSpent = data.timeSpentMs + elapsed;

  await chrome.storage.local.set({ timeSpentMs: newTimeSpent });

  // Check if limit reached
  const limitMs = data.timeLimitMinutes * 60_000;
  if (newTimeSpent >= limitMs && !data.isBlocked) {
    await chrome.storage.local.set({ isBlocked: true });
    await applyBlockingRules(data.blacklist);
    tracking = null;

    // Redirect every open tab showing a blocked domain (covers multiple tabs,
    // multiple windows, and background tabs).
    await redirectAllBlockedTabs(data.blacklist);
  }
}

async function startTrackingIfNeeded() {
  await checkAndResetIfNewDay();

  const data = await getData();

  // Don't track if already blocked
  if (data.isBlocked) return;

  // Don't track if no blacklist
  if (data.blacklist.length === 0) return;

  let tab;
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    tab = activeTab;
  } catch {
    return;
  }

  if (!tab?.url) {
    await flushTracking();
    tracking = null;
    return;
  }

  const hostname = getDomain(tab.url);
  if (!hostname) {
    await flushTracking();
    tracking = null;
    return;
  }

  if (isDomainBlacklisted(hostname, data.blacklist)) {
    if (!tracking || tracking.tabId !== tab.id) {
      await flushTracking();
      tracking = { tabId: tab.id, domain: hostname, startTime: Date.now() };
    }
  } else {
    await flushTracking();
    tracking = null;
  }
}

// --- Event Listeners ---

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const data = await getData();
  if (data.isBlocked) {
    // Guard against switching to an already-loaded banned-site tab.
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      const hostname = getDomain(tab.url);
      if (hostname && isDomainBlacklisted(hostname, data.blacklist)) {
        chrome.tabs.update(activeInfo.tabId, {
          url: chrome.runtime.getURL("blocked.html"),
        });
      }
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
      // Guard against back/forward navigation and bfcache restores reaching a
      // banned domain. declarativeNetRequest covers new navigations, but bfcache
      // restores the page from memory without a network request, bypassing DNR.
      const hostname = getDomain(tab.url);
      if (hostname && isDomainBlacklisted(hostname, data.blacklist)) {
        chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL("blocked.html"),
        });
      }
      await updateBadge();
      return;
    }
    await startTrackingIfNeeded();
    await updateBadge();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tracking && tracking.tabId === tabId) {
    await flushTracking();
    tracking = null;
  }
  await updateBadge();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await flushTracking();
    tracking = null;
  } else {
    await startTrackingIfNeeded();
  }
  await updateBadge();
});

// Alarm heartbeat: flush time every minute (survives service worker restarts)
chrome.alarms.create("heartbeat", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "heartbeat") {
    await checkAndResetIfNewDay();
    await flushTracking();
    await startTrackingIfNeeded();
    await updateBadge();
  }
});

// --- Message Handler (for popup live updates) ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getStatus") {
    (async () => {
      await checkAndResetIfNewDay();
      const data = await getData();
      let liveTimeSpentMs = data.timeSpentMs;
      if (tracking) {
        liveTimeSpentMs += Date.now() - tracking.startTime;
      }

      // Check limit in real-time — trigger block immediately if exceeded
      const limitMs = data.timeLimitMinutes * 60_000;
      if (!data.isBlocked && liveTimeSpentMs >= limitMs) {
        await flushTracking();
        await updateBadge();
        const refreshed = await getData();
        sendResponse({
          timeSpentMs: limitMs,
          timeLimitMinutes: refreshed.timeLimitMinutes,
          blacklist: refreshed.blacklist,
          isBlocked: refreshed.isBlocked,
        });
        return;
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

// --- React to blacklist changes ---

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.blacklist) {
    const data = await getData();
    // Re-apply blocking rules if currently blocked so new list takes effect
    if (data.isBlocked) {
      await applyBlockingRules(data.blacklist);
    }
    await startTrackingIfNeeded();
    await updateBadge();
  }

  if (changes.timeLimitMinutes) {
    // Immediately flush and re-check so a limit decrease triggers blocking
    // without waiting for the next tab event or heartbeat alarm.
    await flushTracking();
    await startTrackingIfNeeded();
    await updateBadge();
  }
});

// On startup / install — ensure clean state
chrome.runtime.onStartup.addListener(async () => {
  await checkAndResetIfNewDay();
  const data = await getData();
  if (data.isBlocked) {
    await applyBlockingRules(data.blacklist);
  }
  await updateBadge();
});

chrome.runtime.onInstalled.addListener(async () => {
  await checkAndResetIfNewDay();
  const data = await getData();
  if (data.isBlocked) {
    await applyBlockingRules(data.blacklist);
  }
  await updateBadge();
});
