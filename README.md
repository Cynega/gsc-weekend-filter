# GSC Weekend Filter

GSC Weekend Filter is a Chrome extension that adds a **Business Days View** to Google Search Console performance reports.

It helps reduce chart noise caused by weekends and, optionally, holidays, so weekday trends are easier to analyze.

## Why this extension exists

For many websites — especially in SEO, publishing, content, and news — weekend behavior can make performance charts harder to interpret.

This extension was built to make Google Search Console trend analysis clearer by filtering out weekends and optional holiday dates from the chart view.

## What it does

- Adds a **Business Days View** panel inside Google Search Console Performance reports
- Removes Saturdays and/or Sundays from the chart
- Optionally excludes public holidays (configurable by country)
- Shows KPI cards and an interactive chart with hover tooltips
- Shows what percentage of clicks and impressions happen on business days vs. the full period
- Export filtered data as **CSV** (ready for Excel or Google Sheets)
- Export the chart as a high-resolution **PNG** (ready for reports or slides)
- Stores all preferences locally in the browser — no account or login required

## Chrome Web Store

[Install GSC Weekend Filter from the Chrome Web Store](https://chromewebstore.google.com/detail/gsc-weekend-filter/hdjdffnogjmadiaacpkmpbfehadamenk)

## Current behavior

The extension works inside Google Search Console Performance reports.

**Note:** after changing the date range in GSC, a page reload is required to refresh the Business Days View. This is a known limitation of how Google Search Console manages its internal page state.

## How it works

The extension runs two content scripts in parallel:

- **MAIN world** (`injected.js`): intercepts Google's `batchexecute` API responses (via `fetch`, `XHR`, `JSON.parse`, and `Worker` wrappers) to extract the daily performance series. It also patches `history.pushState` and `history.replaceState` to detect SPA navigations and notify the isolated world.

- **ISOLATED world** (`content_script.js`, `render_overlay.js`): receives the extracted data via `CustomEvent`, filters it according to user preferences, and renders the Business Days View panel directly above the native GSC chart using a `MutationObserver` to survive GSC's SPA re-renders.

Holiday data is fetched from [Nager.Date](https://date.nager.at/) when holiday filtering is enabled, and cached in `chrome.storage.local` for 30 days.

## Privacy Policy

[Privacy Policy (GitHub Pages)](https://cynega.github.io/gsc-weekend-filter/privacy-policy/)

Also available in this repository: [PRIVACY.md](./PRIVACY.md)

## Repository structure

```
manifest.json        – extension manifest (MV3)
background.js        – service worker: holiday API fetching and caching
content_script.js    – isolated world bootstrap: config bridge between popup and injected.js
injected.js          – main world: network interception and data extraction
render_overlay.js    – isolated world: filtering, rendering, MutationObserver
popup/               – popup UI (HTML, CSS, JS)
icons/               – extension icons (16, 48, 128 px)
docs/                – GitHub Pages files (public privacy policy)
extension/           – pre-packaged ZIP ready for Chrome Web Store upload
generate_icons.js    – dev utility to generate icons from source
```

## Local development

1. Clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select this project folder
6. Open Google Search Console and test the extension in a Performance report

## Publishing an update

Code changes in this repository do **not** update the live Chrome Web Store version automatically.

To publish an update:

1. Modify and test locally with **Load unpacked**
2. Bump the version number in `manifest.json`
3. Create a new ZIP (exclude `.git/`, `.DS_Store`, `generate_icons.js`, and other dev files)
4. Upload the ZIP in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
5. Submit for review

## Contact

[https://emilianoarnaez.com/](https://emilianoarnaez.com/)
