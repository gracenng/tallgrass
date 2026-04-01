// Blocked page — shows time spent and countdown to midnight reset.

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return totalMinutes + "m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours + "h " + minutes + "m";
}

function formatCountdown(ms) {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return hours + "h " + minutes + "m";
  return minutes + "m";
}

function msUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight - now;
}

async function render() {
  const data = await chrome.storage.local.get({
    timeSpentMs: 0,
  });

  document.getElementById("timeSpent").textContent = formatDuration(
    data.timeSpentMs
  );
  document.getElementById("resetIn").textContent = formatCountdown(
    msUntilMidnight()
  );
}

render();

// Update countdown every minute
setInterval(() => {
  document.getElementById("resetIn").textContent = formatCountdown(
    msUntilMidnight()
  );
}, 60_000);
