import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Quote = {
  buy: number | null;
  sell: number | null;
  source: string;
  updatedAt: string | null;
  status: "available" | "unavailable" | "stale";
};
type Rates = { usd: Quote; gold24: Quote; gold21: Quote; checkedAt: string };
type Preferences = { opacity: number; hue: number };

const PREF_KEY = "egypt-rates.preferences.v1";
const defaultPreferences: Preferences = { opacity: 92, hue: 195 };

function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null") as Partial<Preferences> | null;
    return {
      opacity: Math.min(98, Math.max(55, Number(stored?.opacity ?? defaultPreferences.opacity))),
      hue: Math.min(275, Math.max(175, Number(stored?.hue ?? defaultPreferences.hue)))
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
  : new Intl.NumberFormat("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
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

function syncAutoStartControl() {
  const button = document.querySelector<HTMLButtonElement>("#autostart-toggle");
  const state = document.querySelector<HTMLElement>("#autostart-state");
  if (!button || !state) return;

  if (autoStartLoading) {
    state.textContent = "جارٍ التحقق…";
    button.setAttribute("aria-checked", "false");
    button.disabled = true;
  } else if (autoStartEnabled === null) {
    state.textContent = autoStartError ? "تعذر التحقق — اضغط لإعادة المحاولة" : "التحقق من الحالة…";
    button.setAttribute("aria-checked", "false");
    button.disabled = false;
  } else {
    state.textContent = autoStartEnabled ? "مفعّل" : "متوقف";
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

function quoteCard(title: string, symbol: string, quote: Quote, id: string) {
  const statusText = quote.status === "available"
    ? "متاح"
    : quote.status === "stale" ? "بيانات قديمة" : "غير متاح";
  return `
    <article class="rate-card" data-card="${id}">
      <div class="card-heading">
        <div><span class="card-symbol">${symbol}</span><h2>${title}</h2></div>
        <span class="source-state ${quote.status}"><i></i>${statusText}</span>
      </div>
      <div class="quote-values">
        <div class="quote-value"><span>شراء</span><strong>${money(quote.buy)}</strong></div>
        <div class="quote-divider"></div>
        <div class="quote-value"><span>بيع</span><strong>${money(quote.sell)}</strong></div>
      </div>
      <div class="card-footer">
        <span class="source-name">${escapeHtml(quote.source)}</span>
        <span class="source-time">${quote.updatedAt ? "تحديث المصدر: " + escapeHtml(quote.updatedAt) : "توقيت المصدر غير متاح"}</span>
      </div>
    </article>`;
}

function render() {
  const root = document.querySelector<HTMLDivElement>("#root")!;
  const rates = latestRates;
  const usd = rates?.usd ?? unavailable("البنك الأهلي المصري");
  const gold24 = rates?.gold24 ?? unavailable("iSagha");
  const gold21 = rates?.gold21 ?? unavailable("iSagha");
  const checked = lastCheckedAt ? new Date(lastCheckedAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  root.innerHTML = `
    <main class="window-shell">
      <header class="window-header">
        <div class="brand">
          <img src="/app-mark.svg" alt="" class="brand-mark"/>
          <div class="brand-copy"><span class="eyebrow">EGYPT RATES</span><h1>أسعار السوق المصري</h1><span class="brand-subtitle">متابعة مباشرة للعملات والذهب</span></div>
        </div>
        <div class="header-actions">
          <button id="settings-button" class="icon-button ${settingsOpen ? "active" : ""}" aria-label="الإعدادات" title="الإعدادات">⚙</button>
          <button id="hide-button" class="icon-button close-button" aria-label="إخفاء إلى منطقة الإشعارات" title="إخفاء إلى منطقة الإشعارات">×</button>
        </div>
      </header>

      <div class="section-caption"><span>الأسعار الحالية</span><span class="live-mark"><i></i>متابعة تلقائية</span></div>
      <section class="rates-list">
        ${quoteCard("الدولار الأمريكي", "USD / EGP", usd, "usd")}
        ${quoteCard("الذهب عيار 24", "24K / EGP", gold24, "gold24")}
        ${quoteCard("الذهب عيار 21", "21K / EGP", gold21, "gold21")}
      </section>

      <footer class="app-footer">
        <div class="footer-info"><span class="footer-dot ${refreshError ? "warning" : ""}"></span><span>${refreshError ? "تعذر تحديث بعض البيانات" : refreshing ? "جارٍ تحديث الأسعار…" : "آخر فحص " + checked}</span></div>
        <button id="refresh-button" class="refresh-button ${refreshing ? "busy" : ""}" ${refreshing ? "disabled" : ""}><span class="refresh-glyph">↻</span><span>${refreshing ? "جارٍ التحديث" : "تحديث الآن"}</span></button>
      </footer>

      <section id="settings-panel" class="settings-panel ${settingsOpen ? "open" : ""}" aria-hidden="${!settingsOpen}">
        <div class="settings-heading"><div><span class="eyebrow">PERSONALIZE</span><h2>إعدادات المظهر</h2></div><button id="settings-close" class="panel-close" aria-label="إغلاق الإعدادات">×</button></div>
        <div class="setting-block">
          <div class="setting-label"><span>شفافية النافذة</span><output id="opacity-value">${preferences.opacity}%</output></div>
          <input id="opacity-slider" class="range-control opacity-range" type="range" min="55" max="98" step="1" value="${preferences.opacity}" aria-label="شفافية النافذة"/>
          <div class="range-hints"><span>أكثر شفافية</span><span>أكثر وضوحاً</span></div>
        </div>
        <div class="setting-block">
          <div class="setting-label"><span>لون الواجهة</span><span class="color-preview"></span></div>
          <input id="color-slider" class="range-control color-range" type="range" min="175" max="275" step="1" value="${preferences.hue}" aria-label="اختيار لون الواجهة"/>
          <div class="color-presets">
            <button class="color-preset cyan" data-hue="190" aria-label="سماوي"></button>
            <button class="color-preset blue" data-hue="215" aria-label="أزرق"></button>
            <button class="color-preset indigo" data-hue="238" aria-label="نيلي"></button>
            <button class="color-preset violet" data-hue="270" aria-label="بنفسجي"></button>
          </div>
        </div>
        <div class="settings-divider"></div>
        <div class="startup-row">
          <div class="startup-copy"><strong>التشغيل مع Windows</strong><span>فتح التطبيق تلقائياً عند تسجيل الدخول</span></div>
          <button id="autostart-toggle" class="switch" role="switch" aria-checked="false" aria-label="التشغيل مع Windows"><span></span></button>
        </div>
        <div class="startup-state" id="autostart-state">التحقق من الحالة…</div>
        <div class="settings-note">تُحفظ إعدادات المظهر على هذا الجهاز. قد يظهر رمز التطبيق في قائمة الأيقونات المخفية وفق إعدادات شريط مهام Windows.</div>
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
  document.querySelector("#autostart-toggle")?.addEventListener("click", () => void toggleAutoStart());

  if (settingsOpen) {
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
  if (label) label.textContent = refreshing ? "جارٍ التحديث" : "تحديث الآن";
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  syncRefreshButton();
  try {
    latestRates = await invoke<Rates>("refresh_rates");
    refreshError = false;
  } catch {
    refreshError = true;
    if (latestRates) {
      for (const quote of [latestRates.usd, latestRates.gold24, latestRates.gold21]) {
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
    if (!target || target.closest("button, input, textarea, select, a, label, [data-no-drag]")) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  });
}

enableAnywhereDragging();
render();
void refresh();
window.setInterval(() => {
  if (!settingsOpen) void refresh();
}, 60_000);
