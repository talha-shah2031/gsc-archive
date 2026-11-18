# GSC Studio

A desktop Google Search Console dashboard built with Tauri, React, and TypeScript.

## Features

- Google Search Console–style interface
- Overview, Performance, and Sitemaps views
- Real Search Analytics metrics with click and impression trends
- Query, page, country, device, appearance, and date breakdowns
- CSV export
- Data-driven performance recommendations
- One-hour response cache
- Secure service-account import using Windows DPAPI encryption
- Responsive layout for smaller windows

## Security

Service-account credentials are imported through the app and never exposed to the frontend.

- Only the selected file path is passed from React to Rust.
- The file is validated and tested against Google before saving.
- Credentials are encrypted with Windows DPAPI, scoped to the current Windows user.
- The encrypted credential is stored in the Tauri application-data directory.
- Plaintext credential files are never stored by the app.

The legacy `.env.json` fallback is supported only for first-run migration and is excluded from version control.

## Development

```bash
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm tauri build
```

Windows installers are written to `src-tauri/target/release/bundle`.

## Releases

Pushing to `main` runs `.github/workflows/release.yml`, which:

1. Builds the React frontend and Rust backend
2. Produces the NSIS installer, MSI installer, and portable executable
3. Publishes them in a GitHub Release
