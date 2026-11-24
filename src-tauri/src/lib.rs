use chrono::Utc;
use regex::Regex;
use scraper::{Html, Selector};
use serde::Serialize;
use std::sync::OnceLock;
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
    sar: Quote,
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

// Reuse one connection pool for all scheduled/manual refreshes.
fn http_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(7))
            .pool_max_idle_per_host(4)
            .user_agent("EGYPT-RATES/0.2 (+Windows desktop rates widget)")
            .build()
            .ok()
    }).as_ref()
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

fn to_latin_digits(value: &str) -> String {
    value.chars().map(|character| match character {
        '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4',
        '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9',
        _ => character,
    }).collect()
}

async fn fetch_page(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

async fn fetch_isagha(client: &reqwest::Client) -> (Quote, Quote) {
    const SOURCE: &str = "iSagha";
    let unavailable_pair = || (unavailable(SOURCE), unavailable(SOURCE));
    let Some(html) = fetch_page(client, "https://market.isagha.com/prices/").await else {
        return unavailable_pair();
    };

    let document = Html::parse_document(&html);
    let text = page_text(&document);
    let updated_at = Regex::new(
        r"آخر\s+تحديث:\s*([0-9٠-٩]{1,2}\s+\p{L}+\s+[0-9٠-٩]{4}\s*-\s*[0-9٠-٩]{1,2}:[0-9٠-٩]{2}\s*[صم]?)",
    )
    .ok()
    .and_then(|re| re.captures(&text))
    .and_then(|captures| captures.get(1))
    .map(|value| to_latin_digits(value.as_str().trim()));

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

        // Source columns: trader sells to customer, then trader buys from customer.
        let customer_sell = parse_price(&cells[1], &number);
        let customer_buy = parse_price(&cells[3], &number);
        if let (Some(buy), Some(sell)) = (customer_buy, customer_sell) {
            if sell >= buy {
                *target = Some((buy, sell));
            }
        }
    }

    let quote = |value: Option<(f64, f64)>| match value {
        Some((buy, sell)) => available(SOURCE, buy, sell, updated_at.clone()),
        None => unavailable(SOURCE),
    };
    (quote(gold24), quote(gold21))
}

async fn fetch_nbe_usd(client: &reqwest::Client) -> Quote {
    // BankLive is a third-party mirror, not an NBE-operated API.
    const SOURCE: &str = "البنك الأهلي المصري (عبر BankLive)";
    let Some(html) = fetch_page(
        client,
        "https://banklive.net/ar/currency-exchange-rates-in-national-bank-of-egypt",
    ).await else {
        return unavailable(SOURCE);
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
    .map(|value| format!("آخر حركة بموقع البنك: {}", to_latin_digits(value.as_str())));

    for row in document.select(&row_selector) {
        let cells: Vec<String> = row
            .select(&cell_selector)
            .map(|cell| cell.text().collect::<String>().trim().to_string())
            .collect();
        if cells.len() < 3 {
            continue;
        }

        if cells[0].contains("USDEGP") || cells[0].contains("الدولار الأمريكي") {
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

async fn fetch_nbe_sar(client: &reqwest::Client) -> Quote {
    // BankLive is a third-party mirror, not an NBE-operated API.
    const SOURCE: &str = "البنك الأهلي المصري (عبر BankLive)";
    let Some(html) = fetch_page(
        client,
        "https://banklive.net/ar/currency-exchange-rates-in-national-bank-of-egypt",
    ).await else {
        return unavailable(SOURCE);
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
    .map(|value| format!("آخر حركة بموقع البنك: {}", to_latin_digits(value.as_str())));

    for row in document.select(&row_selector) {
        let cells: Vec<String> = row
            .select(&cell_selector)
            .map(|cell| cell.text().collect::<String>().trim().to_string())
            .collect();
        if cells.len() < 3 {
            continue;
        }

        if cells[0].contains("SAR") || cells[0].contains("الريال السعودي") || cells[0].contains("ريال سعودي") {
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

async fn fetch_gtc_fallback(client: &reqwest::Client) -> (Quote, Quote) {
    const SOURCE: &str = "Gold Trade Center (احتياطي)";
    let unavailable_pair = || (unavailable(SOURCE), unavailable(SOURCE));
    let Some(html) = fetch_page(client, "https://app.gtc.com.eg/").await else {
        return unavailable_pair();
    };

    let document = Html::parse_document(&html);
    let text = page_text(&document);
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
async fn refresh_rates() -> Rates {
    let checked_at = Utc::now().to_rfc3339();
    let Some(client) = http_client() else {
        return Rates {
            usd: unavailable("البنك الأهلي المصري (عبر BankLive)"),
            sar: unavailable("البنك الأهلي المصري (عبر BankLive)"),
            gold24: unavailable("iSagha"),
            gold21: unavailable("iSagha"),
            checked_at,
        };
    };

    // Fetch USD and iSagha concurrently; the UI remains responsive while the
    // network work runs, and the shared client reuses TLS connections.
    let (usd, sar, (mut gold24, mut gold21)) = futures::join!(
        fetch_nbe_usd(client),
        fetch_nbe_sar(client),
        fetch_isagha(client)
    );

    if gold24.buy.is_none() || gold21.buy.is_none() {
        let (fallback24, fallback21) = fetch_gtc_fallback(client).await;
        if gold24.buy.is_none() { gold24 = fallback24; }
        if gold21.buy.is_none() { gold21 = fallback21; }
    }

    Rates { usd, sar, gold24, gold21, checked_at }
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "إظهار EGYPT RATES", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "إنهاء التطبيق", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let icon = app.default_window_icon().cloned().expect("default app icon must be configured");

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
            hide_window,
            autostart_is_enabled,
            set_autostart_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running EGYPT RATES");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_grouped_amount() {
        let number = Regex::new(r"\d+(?:\.\d+)?").unwrap();
        assert_eq!(parse_price("1,234.50 EGP", &number), Some(1234.5));
    }

    #[test]
    fn rejects_zero_and_non_finite_amounts() {
        let number = Regex::new(r"\d+(?:\.\d+)?").unwrap();
        assert_eq!(parse_price("0 EGP", &number), None);
        assert_eq!(parse_price("NaN", &number), None);
    }
}
