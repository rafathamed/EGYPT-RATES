use chrono::Utc;
use serde::Serialize;

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

#[tauri::command]
fn refresh_rates() -> Rates {
    // Deliberately fail closed until source adapters are verified and implemented.
    Rates {
        usd: unavailable("البنك الأهلي المصري"),
        gold24: unavailable("iSagha"),
        gold21: unavailable("iSagha"),
        checked_at: Utc::now().to_rfc3339(),
    }
}

#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![refresh_rates, hide_window])
        .run(tauri::generate_context!())
        .expect("error while running EGYPT RATES");
}
