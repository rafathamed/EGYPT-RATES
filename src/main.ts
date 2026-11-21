import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Quote = { buy: number | null; sell: number | null; source: string; updatedAt: string | null; status: "available" | "unavailable" | "stale" };
type Rates = { usd: Quote; gold24: Quote; gold21: Quote; checkedAt: string };

const unavailable = (source: string): Quote => ({ buy: null, sell: null, source, updatedAt: null, status: "unavailable" });
const money = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

function render(rates: Rates | null, error = false) {
  const root = document.querySelector<HTMLDivElement>("#root")!;
  const cards = [
    ["الدولار الأمريكي", "USD / EGP", rates?.usd ?? unavailable("البنك الأهلي المصري")],
    ["الذهب عيار 24", "24K / EGP", rates?.gold24 ?? unavailable("iSagha")],
    ["الذهب عيار 21", "21K / EGP", rates?.gold21 ?? unavailable("iSagha")]
  ] as const;

  root.innerHTML = `
    <main class="shell">
      <header class="topbar"><div><span class="eyebrow">EGYPT RATES</span><h1>أسعار السوق المصري</h1></div><div class="actions"><button id="refresh" title="تحديث">⟳</button><button id="minimize" title="تصغير">−</button></div></header>
      <section class="cards">
        ${cards.map(([title, symbol, q]) => `<article class="card"><div class="card-head"><div><h2>${title}</h2><span class="symbol">${symbol}</span></div><span class="dot ${q.status}"></span></div><div class="prices"><div><small>شراء</small><strong>${money(q.buy)}</strong></div><div><small>بيع</small><strong>${money(q.sell)}</strong></div></div><footer><span>${escapeHtml(q.source)}</span><span>${q.status === "available" ? "متاح" : q.status === "stale" ? "بيانات قديمة" : "غير متاح"}</span></footer><div class="source-update">${q.updatedAt ? "تحديث المصدر: " + escapeHtml(q.updatedAt) : "توقيت تحديث المصدر غير متاح"}</div></article>`).join("")}
      </section>
      <div class="status"><span>${error ? "تعذر الاتصال بمصدر الأسعار" : "البيانات تُعرض مع توضيح مصدرها"}</span><span>آخر فحص: ${rates ? new Date(rates.checkedAt).toLocaleTimeString("ar-EG") : "—"}</span></div>
    </main>`;
  document.querySelector("#refresh")?.addEventListener("click", refresh);
  document.querySelector(".topbar")?.addEventListener("mousedown", (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  });
  document.querySelector("#minimize")?.addEventListener("click", () => invoke("minimize_window").catch(() => undefined));
}

async function refresh() {
  try {
    const data = await invoke<Rates>("refresh_rates");
    render(data);
  } catch {
    render(null, true);
  }
}
render(null);
void refresh();
window.setInterval(() => void refresh(), 60_000);
