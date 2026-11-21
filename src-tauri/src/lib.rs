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

fn available(source: &str, buy: f64, sell: f64) -> Quote {
    Quote {
        buy: Some(buy),
        sell: Some(sell),
        source: source.to_string(),
        // iSagha exposes its own update label on the page; until its localized
        // timestamp is parsed reliably, do not misrepresent fetch time as source time.
        updated_at: None,
        status: "available",
    }
}

fn parse_price(value: &str, number: &Regex) -> Option<f64> {
    let normalized = value.replace(',', "");
    number.find(&normalized)?.as_str().parse::<f64>().ok()
}

fn fetch_isagha() -> (Quote, Quote) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("EGYPT-RATES/0.1 (desktop rates viewer)")
        .build()
    {
        Ok(client) => client,
        Err(_) => return (unavailable("iSagha"), unavailable("iSagha")),
    };

    let response = match client.get("https://market.isagha.com/prices/").send() {
        Ok(response) if response.status().is_success() => response,
        _ => return (unavailable("iSagha"), unavailable("iSagha")),
    };

    let html = match response.text() {
        Ok(html) => html,
        Err(_) => return (unavailable("iSagha"), unavailable("iSagha")),
    };

    let document = Html::parse_document(&html);
    let row_selector = match Selector::parse("table tr") {
        Ok(selector) => selector,
        Err(_) => return (unavailable("iSagha"), unavailable("iSagha")),
    };
    let cell_selector = match Selector::parse("th, td") {
        Ok(selector) => selector,
        Err(_) => return (unavailable("iSagha"), unavailable("iSagha")),
    };
    let number = match Regex::new(r"\d+(?:\.\d+)?") {
        Ok(regex) => regex,
        Err(_) => return (unavailable("iSagha"), unavailable("iSagha")),
    };

    let mut gold24 = None;
    let mut gold21 = None;

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
            Some(&mut gold24)
        } else if karat.contains("21") {
            Some(&mut gold21)
        } else {
            None
        };

        if let Some(slot) = target {
            // iSagha table order: karat, trader sell, sell spread, trader buy.
            let sell = parse_price(&cells[1], &number);
            let buy = parse_price(&cells[3], &number);
            if let (Some(buy), Some(sell)) = (buy, sell) {
                if buy > 0.0 && sell > 0.0 {
                    *slot = Some((buy, sell));
                }
            }
        }
    }

    let quote = |value: Option<(f64, f64)>| match value {
        Some((buy, sell)) => available("iSagha", buy, sell),
        None => unavailable("iSagha"),
    };

    (quote(gold24), quote(gold21))
}

#[tauri::command]
fn refresh_rates() -> Rates {
    let (gold24, gold21) = fetch_isagha();

    // No public, documented NBE machine-readable endpoint has been verified yet.
    // Keep USD unavailable rather than silently substituting another bank's rate.
    Rates {
        usd: unavailable("البنك الأهلي المصري"),
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
