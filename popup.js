// Tallgrass — Popup UI
// Manages blacklist, displays countdown, adjusts limits.
// All data lives in chrome.storage.local.

const DEFAULTS = {
  blacklist: [],
  timeLimitMinutes: 30,
  timeSpentMs: 0,
  isBlocked: false,
};

const LIMIT_STEP = 5; // minutes
const LIMIT_MIN = 5;
const LIMIT_MAX = 480;

// --- DOM refs ---

const timerValue = document.getElementById("timerValue");
const timerLabel = document.getElementById("timerLabel");
const blockedBanner = document.getElementById("blockedBanner");
const siteList = document.getElementById("siteList");
const siteCount = document.getElementById("siteCount");
const emptyState = document.getElementById("emptyState");
const domainInput = document.getElementById("domainInput");
const addBtn = document.getElementById("addBtn");
const addSiteRow = document.getElementById("addSiteRow");
const limitSection = document.getElementById("limitSection");
const limitValue = document.getElementById("limitValue");
const limitDown = document.getElementById("limitDown");
const limitUp = document.getElementById("limitUp");

// --- Formatting ---

function formatTimer(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(seconds);
  return minutes + ":" + pad(seconds);
}

// --- Render ---

async function render() {
  // Get live data from background (includes unflushed in-memory tracking time)
  let data;
  try {
    data = await chrome.runtime.sendMessage({ type: "getStatus" });
  } catch {
    data = await chrome.storage.local.get(DEFAULTS);
  }
  const { blacklist, timeLimitMinutes, timeSpentMs, isBlocked } = data;

  // Countdown: remaining = limit - spent
  const limitMs = timeLimitMinutes * 60_000;
  const remainingMs = Math.max(0, limitMs - Math.min(timeSpentMs, limitMs));
  const percent = limitMs > 0 ? 1 - remainingMs / limitMs : 1;

  timerValue.textContent = formatTimer(remainingMs);
  timerValue.classList.remove("warning", "danger");
  if (remainingMs <= 0) {
    timerValue.classList.add("danger");
    timerLabel.textContent = "time\u2019s up";
  } else if (percent >= 0.75) {
    timerValue.classList.add("warning");
    timerLabel.textContent = "remaining";
  } else {
    timerLabel.textContent = "remaining";
  }

  // Blocked state — locks site list and limit control
  if (isBlocked) {
    blockedBanner.classList.add("visible");
    addSiteRow.classList.add("disabled");
    limitSection.classList.add("disabled");
  } else {
    blockedBanner.classList.remove("visible");
    addSiteRow.classList.remove("disabled");
    limitSection.classList.remove("disabled");
  }
  siteCount.textContent = blacklist.length;
  siteList.innerHTML = "";

  if (blacklist.length === 0) {
    siteList.appendChild(emptyState.cloneNode(true));
  } else {
    blacklist.forEach((domain) => {
      const item = document.createElement("div");
      item.className = "site-item";

      const name = document.createElement("span");
      name.className = "site-name";
      name.textContent = domain;

      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "\u00d7";
      removeBtn.title = "Remove " + domain;
      if (isBlocked) {
        removeBtn.style.display = "none";
      } else {
        removeBtn.addEventListener("click", () => removeSite(domain));
      }

      item.appendChild(name);
      item.appendChild(removeBtn);
      siteList.appendChild(item);
    });
  }

  // Limit display
  limitValue.textContent = timeLimitMinutes + " min";
}

// --- Actions ---

function cleanDomain(input) {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/\/.*$/, "");
  domain = domain.replace(/^www\./, "");
  return domain;
}

function isValidDomain(domain) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    domain
  );
}

async function addSite() {
  const domain = cleanDomain(domainInput.value);
  if (!domain) return;

  if (!isValidDomain(domain)) {
    domainInput.style.borderColor = "#e03e3e";
    domainInput.style.boxShadow = "0 0 0 3px rgba(224, 62, 62, 0.12)";
    setTimeout(() => {
      domainInput.style.borderColor = "";
      domainInput.style.boxShadow = "";
    }, 1500);
    return;
  }

  const data = await chrome.storage.local.get(DEFAULTS);
  if (data.blacklist.includes(domain)) {
    domainInput.value = "";
    return;
  }

  data.blacklist.push(domain);
  await chrome.storage.local.set({ blacklist: data.blacklist });
  domainInput.value = "";
  render();
}

async function removeSite(domain) {
  const data = await chrome.storage.local.get(DEFAULTS);
  data.blacklist = data.blacklist.filter((d) => d !== domain);
  await chrome.storage.local.set({ blacklist: data.blacklist });
  render();
}

async function changeLimit(delta) {
  const data = await chrome.storage.local.get(DEFAULTS);
  const newLimit = Math.max(LIMIT_MIN, Math.min(LIMIT_MAX, data.timeLimitMinutes + delta));
  await chrome.storage.local.set({ timeLimitMinutes: newLimit });
  render();
}

// --- Event Listeners ---

addBtn.addEventListener("click", addSite);

domainInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

limitDown.addEventListener("click", () => changeLimit(-LIMIT_STEP));
limitUp.addEventListener("click", () => changeLimit(LIMIT_STEP));

// Initial render
render();

// Poll every second for live countdown while popup is open
setInterval(render, 1000);
