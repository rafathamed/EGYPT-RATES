use chrono::Utc;
use regex::Regex;
use scraper::{Html, Selector};
use serde::Serialize;
use std::time::Duration;
use tauri::{menu::{Menu, MenuItem}, Manager, WindowEvent};
use tauri::tray::TrayIconBuilder;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Quote {
    buy: Option<f64>,
    sell: Option<f64>,
    source: String,
    updated_at: Option<String>,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Rates {
    usd: Quote,
    gold24: Quote,
    gold21: Quote,
    checked_at: String,
}

fn unavailable(source: &str) -> Quote {
    Quote {
        buy: None,
        sell: None,
        source: source.to_string(),
        updated_at: None,
        status: "unavailable",
    }
}

fn available(source: &str, buy: f64, sell: f64, updated_at: Option<String>) -> Quote {
    Quote {
        buy: Some(buy),
        sell: Some(sell),
        source: source.to_string(),
        updated_at,
        status: "available",
    }
}

fn http_client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("EGYPT-RATES/0.1 (+desktop rates viewer)")
        .build()
        .ok()
}

fn parse_price(value: &str, number: &Regex) -> Option<f64> {
    let normalized = value.replace(',', "");
    let amount = number.find(&normalized)?.as_str().parse::<f64>().ok()?;
    (amount > 0.0 && amount.is_finite()).then_some(amount)
}

fn page_text(document: &Html) -> String {
    document
        .root_element()
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn fetch_isagha() -> (Quote, Quote) {
    let unavailable_pair = || (unavailable("iSagha"), unavailable("iSagha"));
    let Some(client) = http_client() else {
        return unavailable_pair();
    };

    let html = match client.get("https://market.isagha.com/prices/").send() {
        Ok(response) if response.status().is_success() => match response.text() {
            Ok(html) => html,
            Err(_) => return unavailable_pair(),
        },
        _ => return unavailable_pair(),
    };

    let document = Html::parse_document(&html);
    let text = page_text(&document);
    let updated_at = Regex::new(
        r"آخر\s+تحديث:\s*([0-9٠-٩]{1,2}\s+\p{L}+\s+[0-9٠-٩]{4}\s*-\s*[0-9٠-٩]{1,2}:[0-9٠-٩]{2}\s*[صم]?)",
    )
    .ok()
    .and_then(|re| re.captures(&text))
    .and_then(|captures| captures.get(1))
    .map(|value| value.as_str().trim().to_string());

    let Ok(row_selector) = Selector::parse("table tr") else {
        return unavailable_pair();
    };
    let Ok(cell_selector) = Selector::parse("th, td") else {
        return unavailable_pair();
    };
    let Ok(number) = Regex::new(r"\d+(?:\.\d+)?") else {
        return unavailable_pair();
    };

    let mut gold24: Option<(f64, f64)> = None;
    let mut gold21: Option<(f64, f64)> = None;

    for row in document.select(&row_selector) {
        let cells: Vec<String> = row
            .select(&cell_selector)
            .map(|cell| cell.text().collect::<String>().trim().to_string())
            .collect();

        if cells.len() < 4 {
            continue;
        }

        let karat = cells[0].replace(' ', "");
        let target = if karat.contains("24") {
            &mut gold24
        } else if karat.contains("21") {
            &mut gold21
        } else {
            continue;
        };

        // iSagha labels these columns from the trader's perspective:
        // Sell = trader sells to customer; Buy = trader buys from customer.
        let customer_sell = parse_price(&cells[1], &number);
        let customer_buy = parse_price(&cells[3], &number);
        if let (Some(buy), Some(sell)) = (customer_buy, customer_sell) {
            // Reject impossible or malformed rows rather than display a shifted column.
            if sell >= buy {
                *target = Some((buy, sell));
            }
        }
    }

    let quote = |value: Option<(f64, f64)>| match value {
        Some((buy, sell)) => available("iSagha", buy, sell, updated_at.clone()),
        None => unavailable("iSagha"),
    };

    (quote(gold24), quote(gold21))
}

fn fetch_nbe_usd() -> Quote {
    // BankLive links to NBE's official website and reports when NBE's displayed
    // rates last moved. This is a transparent mirror, not an NBE-operated API.
    const SOURCE: &str = "البنك الأهلي المصري (عبر BankLive)";
    let Some(client) = http_client() else {
        return unavailable(SOURCE);
    };

    let html = match client
        .get("https://banklive.net/ar/currency-exchange-rates-in-national-bank-of-egypt")
        .send()
    {
        Ok(response) if response.status().is_success() => match response.text() {
            Ok(html) => html,
            Err(_) => return unavailable(SOURCE),
        },
        _ => return unavailable(SOURCE),
    };

    let document = Html::parse_document(&html);
    let text = page_text(&document);
    let Ok(row_selector) = Selector::parse("table tr") else {
        return unavailable(SOURCE);
    };
    let Ok(cell_selector) = Selector::parse("th, td") else {
        return unavailable(SOURCE);
    };
    let Ok(number) = Regex::new(r"\d+(?:\.\d+)?") else {
        return unavailable(SOURCE);
    };

    let source_update = Regex::new(
        r"في\s+(منذ\s+[0-9٠-٩]+\s+(?:دقيقة|دقائق|ساعة|ساعات|يوم|أيام))",
    )
    .ok()
    .and_then(|re| re.captures(&text))
    .and_then(|captures| captures.get(1))
    .map(|value| format!("آخر حركة بموقع البنك: {}", value.as_str()));

    for row in document.select(&row_selector) {
        let cells: Vec<String> = row
            .select(&cell_selector)
            .map(|cell| cell.text().collect::<String>().trim().to_string())
            .collect();

        if cells.len() < 3 {
            continue;
        }

        let currency = &cells[0];
        if currency.contains("USDEGP") || currency.contains("الدولار الأمريكي") {
            let buy = parse_price(&cells[1], &number);
            let sell = parse_price(&cells[2], &number);
            if let (Some(buy), Some(sell)) = (buy, sell) {
                if sell >= buy {
                    return available(SOURCE, buy, sell, source_update);
                }
            }
        }
    }

    unavailable(SOURCE)
}


fn fetch_gtc_fallback() -> (Quote, Quote) {
    const SOURCE: &str = "Gold Trade Center (احتياطي)";
    let unavailable_pair = || (unavailable(SOURCE), unavailable(SOURCE));
    let Some(client) = http_client() else {
        return unavailable_pair();
    };

    let html = match client.get("https://app.gtc.com.eg/").send() {
        Ok(response) if response.status().is_success() => match response.text() {
            Ok(html) => html,
            Err(_) => return unavailable_pair(),
        },
        _ => return unavailable_pair(),
    };

    let document = Html::parse_document(&html);
    let text = page_text(&document);

    // GTC uses customer-perspective labels. Normalize them to the same
    // dealer-perspective convention used by iSagha before displaying.
    let parse_karat = |karat: &str| -> Option<(f64, f64)> {
        let pattern = format!(
            r"(?i)Au\s+LOCAL\s+Gold\s+{}\s+Sell\s+([0-9,]+(?:\.[0-9]+)?)\s*EGP\s*(?:·|&middot;|&#xB7;)\s*Buy\s+([0-9,]+(?:\.[0-9]+)?)\s*EGP",
            karat
        );
        let re = Regex::new(&pattern).ok()?;
        let capture = re.captures(&text)?;
        let customer_sell = capture.get(1)?.as_str().replace(',', "").parse::<f64>().ok()?;
        let customer_buy = capture.get(2)?.as_str().replace(',', "").parse::<f64>().ok()?;
        if customer_sell > 0.0 && customer_buy >= customer_sell {
            Some((customer_sell, customer_buy))
        } else {
            None
        }
    };

    let quote = |value: Option<(f64, f64)>| match value {
        Some((dealer_buy, dealer_sell)) => available(SOURCE, dealer_buy, dealer_sell, None),
        None => unavailable(SOURCE),
    };

    (quote(parse_karat("24")), quote(parse_karat("21")))
}

#[tauri::command]
fn refresh_rates() -> Rates {
    let usd = fetch_nbe_usd();
    let (mut gold24, mut gold21) = fetch_isagha();
    if gold24.buy.is_none() || gold21.buy.is_none() {
        let (fallback24, fallback21) = fetch_gtc_fallback();
        if gold24.buy.is_none() { gold24 = fallback24; }
        if gold21.buy.is_none() { gold21 = fallback21; }
    }

    Rates {
        usd,
        gold24,
        gold21,
        checked_at: Utc::now().to_rfc3339(),
    }
}

#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    manager.is_enabled().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let show_item = MenuItem::with_id(
                app,
                "show",
                "إظهار EGYPT RATES",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "إنهاء التطبيق",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("default app icon must be configured");

            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            refresh_rates,
            minimize_window,
            hide_window,
            autostart_is_enabled,
            set_autostart_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running EGYPT RATES");
}
