use chrono::Utc;
use regex::Regex;
use scraper::{Html, Selector};
use serde::Serialize;
use std::time::Duration;

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

#[tauri::command]
fn refresh_rates() -> Rates {
    let usd = fetch_nbe_usd();
    let (gold24, gold21) = fetch_isagha();

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![refresh_rates, minimize_window])
        .run(tauri::generate_context!())
        .expect("error while running EGYPT RATES");
}
