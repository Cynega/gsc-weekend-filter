// injected.js — MAIN world content script
// Single responsibility: intercept batchexecute responses, extract the daily
// performance series, and publish clean row objects via a CustomEvent.
//
// Does NOT: filter data, render UI, mutate Google's response payload.

(function () {
  'use strict';

  console.debug('[GSC-WF] injected.js loaded');

  // Track enabled state so we skip processing when the extension is off.
  // Config arrives from content_script.js (ISOLATED world) via CustomEvent.
  let _enabled = true;
  window.addEventListener('gsc-filter-config', (e) => {
    _enabled = e.detail?.enabled !== false;
  });

  // ── URL guard ─────────────────────────────────────────────────────────────────

  function isGSCBatchUrl(url) {
    try {
      const u = new URL(url, location.href);
      return (
        u.hostname === 'search.google.com' &&
        u.pathname.toLowerCase().includes('batchexecute')
      );
    } catch { return false; }
  }

  // ── batchexecute parser ───────────────────────────────────────────────────────

  // GSC timestamps: Unix-ms at noon UTC → divisible by 43 200 000 (12 h).
  function isTimestampMs(v) {
    return (
      typeof v === 'number' &&
      v >= 1262304000000 && // 2010-01-01
      v <= 2208988800000 && // 2040-01-01
      v % 43200000 === 0
    );
  }

  // A "daily ts array": ≥7 sub-arrays each starting with a noon-UTC timestamp,
  // consecutive entries exactly 86 400 000 ms (one day) apart.
  function isDailyTsArray(arr) {
    if (!Array.isArray(arr) || arr.length < 7) return false;
    if (!Array.isArray(arr[0]) || !isTimestampMs(arr[0][0])) return false;
    const n = Math.min(arr.length, 5);
    for (let i = 1; i < n; i++) {
      if (!Array.isArray(arr[i]) || !isTimestampMs(arr[i][0])) return false;
      if (arr[i][0] - arr[i - 1][0] !== 86400000) return false;
    }
    return true;
  }

  function collectDailyArrays(obj, depth, out) {
    if (depth > 15 || obj === null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      if (isDailyTsArray(obj)) { out.push(obj); return; }
      obj.forEach(x => collectDailyArrays(x, depth + 1, out));
    } else {
      Object.values(obj).forEach(v => collectDailyArrays(v, depth + 1, out));
    }
  }

  function processAndPublish(text) {
    if (!text?.startsWith(")]}'\n")) return;

    const lines = text.slice(5).split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (!/^\d+$/.test(lines[i].trim())) continue;
      const next = lines[i + 1] ?? '';
      if (!next.trimStart().startsWith('[')) continue;

      try {
        const outer = JSON.parse(next);
        if (!Array.isArray(outer)) continue;

        for (const item of outer) {
          if (!Array.isArray(item) || item[0] !== 'wrb.fr' || typeof item[2] !== 'string') continue;

          const cands = [];
          collectDailyArrays(JSON.parse(item[2]), 0, cands);
          if (!cands.length) continue;

          // Longest candidate = the main daily performance series.
          const tsRows = cands.reduce((a, b) => b.length > a.length ? b : a);

          // Parse raw rows into clean, serialisable objects.
          const rows = [];
          for (const row of tsRows) {
            if (!Array.isArray(row) || !isTimestampMs(row[0])) continue;
            const m = Array.isArray(row[1]) ? row[1] : [];
            rows.push({
              date:        new Date(row[0]).toISOString().slice(0, 10),
              clicks:      typeof m[0] === 'number' ? m[0] : 0,
              impressions: typeof m[1] === 'number' ? m[1] : 0,
              ctr:         typeof m[2] === 'number' ? m[2] : 0,
              position:    typeof m[3] === 'number' ? m[3] : 0,
            });
          }
          if (!rows.length) continue;

          console.debug(`[GSC-WF] daily series extracted: ${rows.length} rows`);

          // Publish to ISOLATED world (render_overlay.js listens to this event).
          window.dispatchEvent(new CustomEvent('gsc-wf-raw-series', {
            detail: { rows },
          }));
          return; // Stop after first valid wrb.fr chunk.
        }
      } catch { /* skip malformed chunks */ }
    }
  }

  // ── Fetch interceptor (passive — read only, no mutation) ──────────────────────

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _fetch.apply(this, args);
    if (!_enabled) return response;
    const url = args[0] instanceof Request ? args[0].url : String(args[0] ?? '');
    if (isGSCBatchUrl(url)) {
      response.clone().text().then(t => processAndPublish(t)).catch(() => {});
    }
    return response; // Always return the original, unmodified response.
  };

  // ── XHR interceptor (passive — read only, no mutation) ────────────────────────

  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._gscWFUrl = url;
    return _xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this._gscWFUrl && isGSCBatchUrl(this._gscWFUrl)) {
      this.addEventListener('load', () => {
        if (_enabled) try { processAndPublish(this.responseText); } catch { }
      });
    }
    return _xhrSend.apply(this, args);
  };

  console.debug('[GSC-WF] interceptors installed');
})();
