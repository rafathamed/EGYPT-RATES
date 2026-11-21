# EGYPT RATES

A Windows 11 desktop floating widget for Egyptian USD and gold prices.

## Current status

This repository contains the initial Tauri 2 application scaffold and Windows CI workflow. **Live price adapters are not enabled yet.** The application intentionally displays an unavailable state instead of fabricated prices until the data sources and their permitted access methods are verified.

## Planned sources
- USD: National Bank of Egypt (NBE) published buy/sell rates.
- Gold: iSagha primary, Gold Trade Center fallback (subject to source availability and terms).

## Requirements
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

The GitHub Actions workflow builds Windows installers and uploads them as workflow artifacts.

## Data integrity
- Refresh polling is every 60 seconds.
- Polling does not imply that the source price itself changed.
- Each source must provide a verifiable update timestamp.
- Failed/stale sources must never be replaced with guessed or cached-as-current values.

## License
All rights reserved unless a separate license is added by the repository owner.
