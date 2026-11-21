# EGYPT RATES

A Windows 11-inspired vertical floating widget for Egyptian USD and gold prices, built with Tauri 2, Rust, and TypeScript.

## Current features

- Portrait, frameless, always-on-top window, draggable from non-control areas.
- Hidden from the Windows taskbar; the tray icon offers Show and Quit actions. Windows decides whether that icon is displayed directly or inside its hidden-icons overflow.
- Refresh button with a busy state and duplicate-request protection; automatic polling every 60 seconds.
- Settings panel with saved window transparency, hue/color slider, preset color swatches, and Windows startup toggle.
- USD rates from BankLive's NBE rates page, clearly labelled as a third-party mirror and not an NBE-operated API.
- 24K/21K gold from iSagha, with Gold Trade Center as fallback when the corresponding iSagha quote is unavailable.
- Asynchronous concurrent source fetching and a shared HTTP connection pool to keep the UI responsive.
- No fabricated fallback values. Missing source data remains unavailable.
- In-app update checks and signed Windows update installation (available in updater-enabled builds).

## Development

Requirements: Node.js 22+, Rust stable, and WebView2 on Windows.

```powershell
npm install
npm run tauri:dev
```

The `tauri:dev` and `tauri:build` scripts generate all Windows icon sizes from `src-tauri/icons/icon.svg` before launching/building Tauri.

```powershell
npm run build
npm run tauri:build
```

## Release and updater

Windows release builds are produced by the GitHub Actions workflow. The updater-enabled build requires the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`; the corresponding public key is configured in `src-tauri/tauri.conf.json`. Never commit or publish the private signing key. The workflow signs the updater bundles and publishes the installer files together with `latest.json`.

The first updater-enabled release must be installed manually over an older build that does not contain the updater plugin. Subsequent compatible releases can be checked, downloaded, signature-verified, and installed from inside the application.

## Sources

- USD/NBE mirror: https://banklive.net/ar/currency-exchange-rates-in-national-bank-of-egypt
- iSagha: https://market.isagha.com/prices/
- Gold Trade Center fallback: https://app.gtc.com.eg/

Polling every minute means the app checks every minute; it does not imply that the source changes its quote every minute. Source time is kept distinct from the app's last check time.

## License

All rights reserved unless a separate license is added by the repository owner.
