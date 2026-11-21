# EGYPT RATES

A Windows desktop floating widget for Egyptian USD and gold prices, built with Tauri 2, Rust, and TypeScript.

## Current implementation

- Windows 11-inspired Arabic interface.
- Floating, always-on-top frameless window with drag support and minimize control.
- Automatic refresh every 60 seconds.
- USD buy/sell quote read from BankLive's NBE rates page. BankLive links to NBE's official website and reports when its displayed NBE rates last changed. This is a **third-party mirror**, not an NBE-operated API, and the UI labels it transparently.
- Gold 24K/21K read from iSagha's published table, including its source update timestamp.
- Gold Trade Center is used as a fallback only when the corresponding iSagha quote is missing. Its buy/sell labels are normalized to the dealer-perspective convention used in the app.
- The app does not generate, interpolate, or substitute prices when a source cannot be read. Unavailable fields remain blank.

## Sources

- USD/NBE mirror: https://banklive.net/ar/currency-exchange-rates-in-national-bank-of-egypt
- iSagha: https://market.isagha.com/prices/
- Gold Trade Center fallback: https://app.gtc.com.eg/

Polling every minute means the app checks for changes every minute; it does not mean that the source itself changes its quote every minute. The displayed source timestamp is kept distinct from the app's last check time.

## Development requirements

- Node.js 22+
- Rust stable toolchain
- Windows 10/11 with WebView2

## Development

```powershell
npm install
npm run tauri dev
```

## Build

```powershell
npm run tauri build
```

GitHub Actions builds Windows installers and uploads the EXE/MSI files as workflow artifacts under the Actions run.

## License

All rights reserved unless a separate license is added by the repository owner.
