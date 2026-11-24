import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";

type Quote = {
  buy: number | null;
  sell: number | null;
  source: string;
  updatedAt: string | null;
  status: "available" | "unavailable" | "stale";
};
type Rates = { usd: Quote; sar: Quote; gold24: Quote; gold21: Quote; checkedAt: string };
type Preferences = { opacity: number; hue: number; alwaysOnTop: boolean };

const PREF_KEY = "egypt-rates.preferences.v1";
const defaultPreferences: Preferences = { opacity: 92, hue: 195, alwaysOnTop: true };
type WindowSize = { width: number; height: number };
const WINDOW_SIZE_KEY = "egypt-rates.window-size.v1";
const CALCULATOR_VALUES_KEY = "egypt-rates.calculator-values.v1";
type CalculatorKey = "usd" | "sar" | "gold24" | "gold21";
type CalculatorValues = Record<CalculatorKey, string>;
const DEFAULT_WINDOW_SIZE: WindowSize = { width: 420, height: 780 };
const WINDOW_SIZE_LIMITS = { minWidth: 350, maxWidth: 680, minHeight: 580, maxHeight: 1000 };
const currentWindow = getCurrentWindow();
let windowSizeSaveTimer: number | null = null;

function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null") as Partial<Preferences> | null;
    return {
      opacity: Math.min(98, Math.max(55, Number(stored?.opacity ?? defaultPreferences.opacity))),
      hue: Math.min(275, Math.max(175, Number(stored?.hue ?? defaultPreferences.hue))),
      alwaysOnTop: stored?.alwaysOnTop !== false
    };
  } catch {
    return { ...defaultPreferences };
  }
}

let preferences = loadPreferences();
let settingsOpen = false;
let autoStartEnabled: boolean | null = null;
let autoStartLoading = false;
let autoStartError = false;
let topmostLoading = false;
let updateChecking = false;
let updateInstalling = false;
let updateMessage = "Not checked yet";
let pendingUpdate: Awaited<ReturnType<typeof check>> = null;
let latestRates: Rates | null = null;
let lastCheckedAt: string | null = null;
let refreshError = false;
let refreshing = false;
let dragHandlerAttached = false;

const unavailable = (source: string): Quote => ({
  buy: null, sell: null, source, updatedAt: null, status: "unavailable"
});
const money = (value: number | null) => value === null
  ? "—"
  : new Intl.NumberFormat("en-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
function loadCalculatorValues(): CalculatorValues {
  try {
    const saved = JSON.parse(localStorage.getItem(CALCULATOR_VALUES_KEY) ?? "null") as Partial<CalculatorValues> | null;
    return {
      usd: typeof saved?.usd === "string" ? saved.usd : "",
      sar: typeof saved?.sar === "string" ? saved.sar : "",
      gold24: typeof saved?.gold24 === "string" ? saved.gold24 : "",
      gold21: typeof saved?.gold21 === "string" ? saved.gold21 : ""
    };
  } catch {
    return { usd: "", sar: "", gold24: "", gold21: "" };
  }
}
let calculatorValues = loadCalculatorValues();
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]!));

function applyPreferences() {
  document.documentElement.style.setProperty("--window-opacity", String(preferences.opacity / 100));
  document.documentElement.style.setProperty("--accent-hue", String(preferences.hue));
  document.documentElement.style.setProperty("--accent", `hsl(${preferences.hue} 82% 68%)`);
  document.documentElement.style.setProperty("--accent-soft", `hsl(${preferences.hue} 82% 68% / .14)`);
}

function savePreferences() {
  localStorage.setItem(PREF_KEY, JSON.stringify(preferences));
  applyPreferences();
}

function normalizeWindowSize(value: Partial<WindowSize> | null | undefined): WindowSize | null {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    width: Math.round(Math.min(WINDOW_SIZE_LIMITS.maxWidth, Math.max(WINDOW_SIZE_LIMITS.minWidth, width))),
    height: Math.round(Math.min(WINDOW_SIZE_LIMITS.maxHeight, Math.max(WINDOW_SIZE_LIMITS.minHeight, height)))
  };
}

function loadSavedWindowSize(): WindowSize | null {
  try {
    const saved = JSON.parse(localStorage.getItem(WINDOW_SIZE_KEY) ?? "null") as Partial<WindowSize> | null;
    return normalizeWindowSize(saved);
  } catch {
    return null;
  }
}

async function saveCurrentWindowSize() {
  try {
    const [physicalSize, scaleFactor] = await Promise.all([
      currentWindow.innerSize(),
      currentWindow.scaleFactor()
    ]);
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;
    const logicalSize = normalizeWindowSize({
      width: physicalSize.width / scaleFactor,
      height: physicalSize.height / scaleFactor
    });
    if (logicalSize) localStorage.setItem(WINDOW_SIZE_KEY, JSON.stringify(logicalSize));
  } catch {
    // A transient window event must never interrupt the rates interface.
  }
}

async function restoreAndWatchWindowSize() {
  const savedSize = loadSavedWindowSize();
  try {
    if (savedSize) {
      await currentWindow.setSize(new LogicalSize(savedSize.width, savedSize.height));
    }
  } catch {
    // The configured default size remains usable if restoring a stored size fails.
  }

  try {
    await currentWindow.onResized(() => {
      if (windowSizeSaveTimer !== null) window.clearTimeout(windowSizeSaveTimer);
      windowSizeSaveTimer = window.setTimeout(() => {
        windowSizeSaveTimer = null;
        void saveCurrentWindowSize();
      }, 220);
    });
  } catch {
    // Resize itself remains available even if persistence listeners cannot be attached.
  }
}

async function resizeWindowByStep(direction: -1 | 1) {
  try {
    const [physicalSize, scaleFactor] = await Promise.all([
      currentWindow.innerSize(),
      currentWindow.scaleFactor()
    ]);
    const nextSize = normalizeWindowSize({
      width: physicalSize.width / scaleFactor + direction * 40,
      height: physicalSize.height / scaleFactor + direction * 56
    });
    if (nextSize) await currentWindow.setSize(new LogicalSize(nextSize.width, nextSize.height));
  } catch {
    // Keep the interface responsive if the native resize request is unavailable.
  }
}

async function resetWindowSize() {
  try {
    await currentWindow.setSize(new LogicalSize(DEFAULT_WINDOW_SIZE.width, DEFAULT_WINDOW_SIZE.height));
  } catch {
    // No-op: the user can still resize from the window edges.
  }
}

async function applyAlwaysOnTop() {
  try { await currentWindow.setAlwaysOnTop(preferences.alwaysOnTop); } catch { /* Native window API may be unavailable in preview mode. */ }
}

function syncTopmostControl() {
  const button = document.querySelector<HTMLButtonElement>("#topmost-toggle");
  const state = document.querySelector<HTMLElement>("#topmost-state");
  if (!button || !state) return;
  button.setAttribute("aria-checked", String(preferences.alwaysOnTop));
  button.disabled = topmostLoading;
  state.textContent = topmostLoading ? "Applying setting…" : preferences.alwaysOnTop ? "Enabled — always on top" : "Disabled — follows window order";
}

async function toggleAlwaysOnTop() {
  if (topmostLoading) return;
  topmostLoading = true; syncTopmostControl();
  const previous = preferences.alwaysOnTop;
  preferences.alwaysOnTop = !previous;
  try {
    await currentWindow.setAlwaysOnTop(preferences.alwaysOnTop);
    savePreferences();
  } catch {
    preferences.alwaysOnTop = previous;
  } finally { topmostLoading = false; syncTopmostControl(); }
}

async function checkForUpdates() {
  if (updateChecking || updateInstalling) return;
  updateChecking = true;
  const button = document.querySelector<HTMLButtonElement>("#check-updates");
  const installButton = document.querySelector<HTMLButtonElement>("#install-update");
  const state = document.querySelector<HTMLElement>("#update-state");
  if (button) { button.disabled = true; button.textContent = "Checking…"; }
  if (installButton) installButton.hidden = true;
  if (state) state.textContent = "Checking for available updates…";

  try {
    const previousUpdate = pendingUpdate;
    pendingUpdate = null;
    await previousUpdate?.close().catch(() => undefined);
    pendingUpdate = await check();
    if (pendingUpdate) {
      updateMessage = `A new update is available: version ${pendingUpdate.version}`;
      if (pendingUpdate.body) updateMessage += `\n${pendingUpdate.body.slice(0, 360)}`;
    } else {
      updateMessage = "You're using the latest available version.";
    }
  } catch (error) {
    pendingUpdate = null;
    const detail = error instanceof Error ? error.message : String(error);
    updateMessage = `Could not check for updates. ${detail.slice(0, 180)}`;
  } finally {
    updateChecking = false;
    if (button) { button.disabled = false; button.textContent = "Check for updates"; }
    if (state) state.textContent = updateMessage;
    if (installButton) installButton.hidden = !pendingUpdate;
  }
}

async function installAvailableUpdate() {
  if (!pendingUpdate || updateInstalling) return;
  updateInstalling = true;
  const checkButton = document.querySelector<HTMLButtonElement>("#check-updates");
  const installButton = document.querySelector<HTMLButtonElement>("#install-update");
  const state = document.querySelector<HTMLElement>("#update-state");
  if (checkButton) checkButton.disabled = true;
  if (installButton) { installButton.disabled = true; installButton.textContent = "Downloading update…"; }
  if (state) state.textContent = "Downloading the update and verifying its digital signature…";

  try {
    let downloaded = 0;
    let contentLength: number | undefined;
    const update = pendingUpdate;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength;
        updateMessage = "Update download started…";
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        const percent = contentLength && contentLength > 0
          ? Math.min(100, Math.round((downloaded / contentLength) * 100))
          : null;
        updateMessage = percent === null
          ? "Downloading update…"
          : `Downloading update: ${percent}%`;
      } else if (event.event === "Finished") {
        updateMessage = "Download complete. Starting the update installer…";
      }
      if (state) state.textContent = updateMessage;
      if (installButton) installButton.textContent = updateMessage;
    }, { restartAfterInstall: true });

    pendingUpdate = null;
    updateMessage = "The update has been handed off to the Windows installer. The app will close to complete installation.";
    if (state) state.textContent = updateMessage;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    updateMessage = `Update installation failed: ${detail.slice(0, 180)}`;
    if (state) state.textContent = updateMessage;
    try { await pendingUpdate?.close(); } catch { /* Release the update handle if possible. */ }
    pendingUpdate = null;
    if (installButton) installButton.hidden = true;
  } finally {
    updateInstalling = false;
    if (checkButton) checkButton.disabled = false;
    if (installButton && !installButton.hidden) {
      installButton.disabled = false;
      installButton.textContent = "Retry update download";
    }
  }
}

function syncAutoStartControl() {
  const button = document.querySelector<HTMLButtonElement>("#autostart-toggle");
  const state = document.querySelector<HTMLElement>("#autostart-state");
  if (!button || !state) return;

  if (autoStartLoading) {
    state.textContent = "Checking…";
    button.setAttribute("aria-checked", "false");
    button.disabled = true;
  } else if (autoStartEnabled === null) {
    state.textContent = autoStartError ? "Unable to check — click to retry" : "Checking status…";
    button.setAttribute("aria-checked", "false");
    button.disabled = false;
  } else {
    state.textContent = autoStartEnabled ? "Enabled" : "Disabled";
    button.setAttribute("aria-checked", String(autoStartEnabled));
    button.disabled = false;
  }
}

async function loadAutoStartState(force = false) {
  if (autoStartLoading || (autoStartEnabled !== null && !force)) return;
  autoStartLoading = true;
  syncAutoStartControl();
  try {
    autoStartEnabled = await invoke<boolean>("autostart_is_enabled");
    autoStartError = false;
  } catch {
    autoStartEnabled = null;
    autoStartError = true;
  } finally {
    autoStartLoading = false;
    syncAutoStartControl();
  }
}

async function toggleAutoStart() {
  if (autoStartEnabled === null) {
    await loadAutoStartState(true);
    return;
  }
  const button = document.querySelector<HTMLButtonElement>("#autostart-toggle");
  if (button) button.disabled = true;
  try {
    autoStartEnabled = await invoke<boolean>("set_autostart_enabled", { enabled: !autoStartEnabled });
    autoStartError = false;
  } catch {
    autoStartError = true;
  } finally {
    syncAutoStartControl();
  }
}

function purchaseTotal(id: CalculatorKey, buy: number | null): number | null {
  const rawQuantity = calculatorValues[id].trim();
  if (buy === null || rawQuantity === "") return null;
  const quantity = Number(rawQuantity);
  return Number.isFinite(quantity) && quantity >= 0 ? buy * quantity : null;
}

function calculationPanel(id: CalculatorKey, quote: Quote) {
  const isGold = id === "gold24" || id === "gold21";
  const itemName = id === "usd" ? "US Dollar" : id === "sar" ? "Saudi Riyal" : id === "gold24" ? "24K Gold" : "21K Gold";
  return `
    <div class="purchase-calculator">
      <div class="calculator-heading">
        <label for="${id}-quantity">${isGold ? "Gold Value Calculator" : "Purchase Calculator"}</label>
        <span>${isGold ? "Gold buying price × grams" : "Buying price × quantity"}</span>
      </div>
      <div class="calculator-row">
        <input
          id="${id}-quantity"
          class="calculator-input"
          type="number"
          inputmode="decimal"
          min="0"
          step="any"
          dir="ltr"
          autocomplete="off"
          aria-label="${isGold ? "Number of grams" : "Quantity"} ${itemName} for total calculation"
          placeholder="${isGold ? "Enter grams" : "Enter quantity"}"
          value="${escapeHtml(calculatorValues[id])}"
        />
        <div class="calculator-output" aria-live="polite">
          <span>Total (EGP)</span>
          <strong id="${id}-total">${money(purchaseTotal(id, quote.buy))}</strong>
        </div>
      </div>
    </div>`;
}

function quoteCard(title: string, symbol: string, quote: Quote, id: CalculatorKey) {
  const statusText = quote.status === "available"
    ? "Available"
    : quote.status === "stale" ? "Stale data" : "Unavailable";
  return `
    <article class="rate-card" data-card="${id}">
      <div class="card-heading">
        <div><span class="card-symbol">${symbol}</span><h2>${title}</h2></div>
        <span class="source-state ${quote.status}"><i></i>${statusText}</span>
      </div>
      <div class="quote-values">
        <div class="quote-value"><span>Buy</span><strong>${money(quote.buy)}</strong></div>
        <div class="quote-divider"></div>
        <div class="quote-value"><span>Sell</span><strong>${money(quote.sell)}</strong></div>
      </div>
      ${calculationPanel(id, quote)}
      <div class="card-footer">
        <span class="source-name">${escapeHtml(quote.source)}</span>
        <span class="source-time">${quote.updatedAt ? "Source updated: " + escapeHtml(quote.updatedAt) : "Source time unavailable"}</span>
      </div>
    </article>`;
}

function render() {
  const root = document.querySelector<HTMLDivElement>("#root")!;
  const focusedCalculator = document.activeElement instanceof HTMLInputElement
    && ["usd-quantity", "sar-quantity", "gold24-quantity", "gold21-quantity"].includes(document.activeElement.id)
    ? document.activeElement.id
    : null;
  const rates = latestRates;
  const usd = rates?.usd ?? unavailable("National Bank of Egypt");
  const sar = rates?.sar ?? unavailable("National Bank of Egypt");
  const gold24 = rates?.gold24 ?? unavailable("iSagha");
  const gold21 = rates?.gold21 ?? unavailable("iSagha");
  const checked = lastCheckedAt ? new Date(lastCheckedAt).toLocaleTimeString("en-EG", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  root.innerHTML = `
    <main class="window-shell">
      <div class="resize-handle resize-n" data-resize="North" aria-hidden="true"></div>
      <div class="resize-handle resize-s" data-resize="South" aria-hidden="true"></div>
      <div class="resize-handle resize-e" data-resize="East" aria-hidden="true"></div>
      <div class="resize-handle resize-w" data-resize="West" aria-hidden="true"></div>
      <div class="resize-handle resize-ne" data-resize="NorthEast" aria-hidden="true"></div>
      <div class="resize-handle resize-nw" data-resize="NorthWest" aria-hidden="true"></div>
      <div class="resize-handle resize-se" data-resize="SouthEast" aria-hidden="true"></div>
      <div class="resize-handle resize-sw" data-resize="SouthWest" aria-hidden="true"></div>
      <header class="window-header">
        <div class="brand">
          <img src="/app-mark.ico" alt="" class="brand-mark"/>
          <div class="brand-copy"><span class="eyebrow">EGYPT RATES</span><h1>Egyptian Market Rates</h1><span class="brand-subtitle">Live currency and gold tracking</span></div>
        </div>
        <div class="header-actions">
          <button id="settings-button" class="icon-button ${settingsOpen ? "active" : ""}" aria-label="Settings" title="Settings">⚙</button>
          <button id="hide-button" class="icon-button close-button" aria-label="Hide to system tray" title="Hide to system tray">×</button>
        </div>
      </header>

      <div class="section-caption"><span>Current Rates</span><span class="live-mark"><i></i>Auto refresh</span></div>
      <section class="rates-list">
        ${quoteCard("US Dollar", "USD / EGP", usd, "usd")}
        ${quoteCard("Saudi Riyal", "SAR / EGP", sar, "sar")}
        ${quoteCard("24K Gold", "24K / EGP", gold24, "gold24")}
        ${quoteCard("21K Gold", "21K / EGP", gold21, "gold21")}
      </section>

      <footer class="app-footer">
        <div class="footer-info"><span class="footer-dot ${refreshError ? "warning" : ""}"></span><span>${refreshError ? "Some data could not be updated" : refreshing ? "Refreshing rates…" : "Last checked " + checked}</span></div>
        <button id="refresh-button" class="refresh-button ${refreshing ? "busy" : ""}" ${refreshing ? "disabled" : ""}><span class="refresh-glyph">↻</span><span>${refreshing ? "Refreshing" : "Refresh Now"}</span></button>
      </footer>

      <section id="settings-panel" class="settings-panel ${settingsOpen ? "open" : ""}" aria-hidden="${!settingsOpen}">
        <div class="settings-heading"><div><span class="eyebrow">PERSONALIZE</span><h2>Appearance Settings</h2></div><button id="settings-close" class="panel-close" aria-label="Close settings">×</button></div>
        <div class="setting-block size-setting">
          <div class="setting-label"><span>Window Size</span><span class="size-hint">Adjust the size or drag the edges</span></div>
          <div class="size-controls">
            <button id="size-down" class="size-control" type="button" title="Shrink window">− Smaller</button>
            <button id="size-up" class="size-control" type="button" title="Enlarge window">＋ Larger</button>
            <button id="size-reset" class="size-control reset" type="button" title="Restore default size">Default</button>
          </div>
        </div>
        <div class="setting-block">
          <div class="setting-label"><span>Window Transparency</span><output id="opacity-value">${preferences.opacity}%</output></div>
          <input id="opacity-slider" class="range-control opacity-range" type="range" min="55" max="98" step="1" value="${preferences.opacity}" aria-label="Window Transparency"/>
          <div class="range-hints"><span>More transparent</span><span>More opaque</span></div>
        </div>
        <div class="setting-block">
          <div class="setting-label"><span>Accent Color</span><span class="color-preview"></span></div>
          <input id="color-slider" class="range-control color-range" type="range" min="175" max="275" step="1" value="${preferences.hue}" aria-label="Choose accent color"/>
          <div class="color-presets">
            <button class="color-preset cyan" data-hue="190" aria-label="Cyan"></button>
            <button class="color-preset blue" data-hue="215" aria-label="Blue"></button>
            <button class="color-preset indigo" data-hue="238" aria-label="Indigo"></button>
            <button class="color-preset violet" data-hue="270" aria-label="Violet"></button>
          </div>
        </div>
        <div class="settings-divider"></div>
        <div class="startup-row">
          <div class="startup-copy"><strong>Always on Top</strong><span>Keep the rates window above other windows</span></div>
          <button id="topmost-toggle" class="switch" role="switch" aria-checked="${preferences.alwaysOnTop}" aria-label="Always on Top"><span></span></button>
        </div>
        <div class="startup-state" id="topmost-state">${preferences.alwaysOnTop ? "Enabled — always on top" : "Disabled — follows window order"}</div>
        <div class="settings-divider"></div>
        <div class="startup-row">
          <div class="startup-copy"><strong>Launch at Startup</strong><span>Automatically open the app when you sign in</span></div>
          <button id="autostart-toggle" class="switch" role="switch" aria-checked="false" aria-label="Launch at Startup"><span></span></button>
        </div>
        <div class="startup-state" id="autostart-state">Checking status…</div>
        <div class="settings-divider"></div>
        <div class="updates-block">
          <div class="startup-copy"><strong>App Updates</strong><span>Current version 0.2.6 — download and install updates from within the app</span></div>
          <button id="check-updates" class="size-control" type="button">Check for updates</button>
          <div class="startup-state update-state" id="update-state">Not checked yet</div>
          <button id="install-update" class="refresh-button" type="button" hidden>Download and Install Update</button>
        </div>
        <div class="settings-note">Appearance and always-on-top settings are saved on this device. The app icon may appear in the hidden icons menu, depending on your Windows taskbar settings.</div>
      </section>

      <div class="window-glow"></div>
    </main>`;

  applyPreferences();
  document.querySelector("#settings-button")?.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    render();
  });
  document.querySelector("#settings-close")?.addEventListener("click", () => {
    settingsOpen = false;
    render();
  });
  document.querySelector("#hide-button")?.addEventListener("click", () => {
    void invoke("hide_window").catch(() => undefined);
  });
  document.querySelector("#refresh-button")?.addEventListener("click", () => void refresh());
  (["usd", "sar", "gold24", "gold21"] as const).forEach((id) => {
    const input = document.querySelector<HTMLInputElement>(`#${id}-quantity`);
    input?.addEventListener("input", () => {
      calculatorValues[id] = input.value;
      try {
        localStorage.setItem(CALCULATOR_VALUES_KEY, JSON.stringify(calculatorValues));
      } catch {
        // The live calculation remains available even if local storage is unavailable.
      }
      const quote = latestRates?.[id] ?? unavailable("National Bank of Egypt");
      const output = document.querySelector<HTMLElement>(`#${id}-total`);
      if (output) output.textContent = money(purchaseTotal(id, quote.buy));
    });
  });
  document.querySelector("#opacity-slider")?.addEventListener("input", (event) => {
    preferences.opacity = Number((event.currentTarget as HTMLInputElement).value);
    const output = document.querySelector<HTMLOutputElement>("#opacity-value");
    if (output) output.value = `${preferences.opacity}%`;
    savePreferences();
  });
  document.querySelector("#color-slider")?.addEventListener("input", (event) => {
    preferences.hue = Number((event.currentTarget as HTMLInputElement).value);
    savePreferences();
  });
  document.querySelectorAll<HTMLButtonElement>(".color-preset").forEach((button) => {
    button.addEventListener("click", () => {
      preferences.hue = Number(button.dataset.hue);
      const slider = document.querySelector<HTMLInputElement>("#color-slider");
      if (slider) slider.value = String(preferences.hue);
      savePreferences();
    });
  });
  document.querySelector("#size-down")?.addEventListener("click", () => void resizeWindowByStep(-1));
  document.querySelector("#size-up")?.addEventListener("click", () => void resizeWindowByStep(1));
  document.querySelector("#size-reset")?.addEventListener("click", () => void resetWindowSize());
  document.querySelector("#autostart-toggle")?.addEventListener("click", () => void toggleAutoStart());
  document.querySelector("#topmost-toggle")?.addEventListener("click", () => void toggleAlwaysOnTop());
  document.querySelector("#check-updates")?.addEventListener("click", () => void checkForUpdates());
  document.querySelector("#install-update")?.addEventListener("click", () => void installAvailableUpdate());

  if (focusedCalculator) {
    document.querySelector<HTMLInputElement>(`#${focusedCalculator}`)?.focus({ preventScroll: true });
  }

  if (settingsOpen) {
    syncTopmostControl();
    syncAutoStartControl();
    void loadAutoStartState();
  }
  syncRefreshButton();
}

function syncRefreshButton() {
  const button = document.querySelector<HTMLButtonElement>("#refresh-button");
  if (!button) return;
  button.disabled = refreshing;
  button.classList.toggle("busy", refreshing);
  const label = button.querySelector("span:last-child");
  if (label) label.textContent = refreshing ? "Refreshing" : "Refresh Now";
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  syncRefreshButton();
  try {
    const freshRates = await invoke<Rates>("refresh_rates");
    if (latestRates) {
      for (const key of ["usd", "sar", "gold24", "gold21"] as const) {
        const fresh = freshRates[key];
        const previous = latestRates[key];
        if (fresh.buy === null && fresh.sell === null && (previous.buy !== null || previous.sell !== null)) {
          freshRates[key] = { ...previous, status: "stale" };
        }
      }
    }
    latestRates = freshRates;
    refreshError = false;
  } catch {
    refreshError = true;
    if (latestRates) {
      for (const quote of [latestRates.usd, latestRates.sar, latestRates.gold24, latestRates.gold21]) {
        if (quote.buy !== null || quote.sell !== null) quote.status = "stale";
      }
    }
  } finally {
    refreshing = false;
    lastCheckedAt = new Date().toISOString();
    render();
  }
}

function enableAnywhereDragging() {
  if (dragHandlerAttached) return;
  dragHandlerAttached = true;
  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const resizeHandle = target.closest<HTMLElement>("[data-resize]");
    if (resizeHandle?.dataset.resize) {
      event.preventDefault();
      const direction = resizeHandle.dataset.resize as Parameters<typeof currentWindow.startResizeDragging>[0];
      void currentWindow.startResizeDragging(direction).catch(() => undefined);
      return;
    }

    if (target.closest("button, input, textarea, select, a, label, [data-no-drag]")) return;
    void currentWindow.startDragging().catch(() => undefined);
  });
}

void applyAlwaysOnTop();
void restoreAndWatchWindowSize();
enableAnywhereDragging();
render();
void refresh();
window.setInterval(() => {
  if (!settingsOpen) void refresh();
}, 60_000);
