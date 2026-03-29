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
  // Broad match: any Google API domain that could carry batchexecute traffic.
  // processAndPublish() rejects non-batchexecute responses in O(1) via prefix check,
  // so false-positives here are cheap.

  function isGoogleApiUrl(url) {
    try {
      const h = new URL(url, location.href).hostname;
      return h === 'search.google.com' || h.endsWith('.googleapis.com');
    } catch { return false; }
  }

  // ── batchexecute parser ───────────────────────────────────────────────────────

  // GSC timestamps: Unix-ms representing a date boundary (midnight or noon UTC,
  // or local midnight which may not be on a 12 h boundary).
  function isTimestampMs(v) {
    return (
      typeof v === 'number' &&
      v >= 1262304000000 && // 2010-01-01
      v <= 2208988800000    // 2040-01-01
    );
  }

  // GSC also encodes dates as [year, month, day] integer triples (observed in
  // batchexecute payloads, e.g. [2025,4,27]).  Months are 1-indexed.
  function isDateTriple(v) {
    return (
      Array.isArray(v) && v.length >= 3 &&
      typeof v[0] === 'number' && v[0] >= 2010 && v[0] <= 2040 &&
      typeof v[1] === 'number' && v[1] >= 1  && v[1] <= 12   &&
      typeof v[2] === 'number' && v[2] >= 1  && v[2] <= 31
    );
  }

  // Normalise either date representation to Unix-ms (UTC midnight).
  // Returns null if the value is neither.
  function toMs(v) {
    if (isTimestampMs(v)) return v;
    if (isDateTriple(v))  return Date.UTC(v[0], v[1] - 1, v[2]);
    return null;
  }

  // A "daily array": ≥7 sub-arrays each starting with a date value (Unix-ms OR
  // [year, month, day]), consecutive entries ~86 400 000 ms apart ± 2 h DST.
  function isDailyTsArray(arr) {
    if (!Array.isArray(arr) || arr.length < 7) return false;
    if (!Array.isArray(arr[0])) return false;
    const ms0 = toMs(arr[0][0]);
    if (ms0 === null) return false;
    const n = Math.min(arr.length, 5);
    for (let i = 1; i < n; i++) {
      if (!Array.isArray(arr[i])) return false;
      const msCur  = toMs(arr[i][0]);
      const msPrev = toMs(arr[i - 1][0]);
      if (msCur === null || msPrev === null) return false;
      const diff = msCur - msPrev;
      if (diff < 82800000 || diff > 90000000) return false; // 23 h – 25 h
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

  // Save original JSON.parse before any page code runs so processAndPublish
  // can bypass the wrapper below (avoiding re-entrancy on inner chunk parsing).
  const _origJsonParse = JSON.parse;

  function processAndPublish(text) {
    if (!text?.startsWith(")]}'\n")) {
      console.debug('[GSC-WF] processAndPublish: response missing batchexecute prefix — skipping');
      return;
    }
    console.debug('[GSC-WF] processAndPublish: received batchexecute response,', text.length, 'chars');

    const lines = text.slice(5).split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (!/^\d+$/.test(lines[i].trim())) continue;
      const next = lines[i + 1] ?? '';
      if (!next.trimStart().startsWith('[')) continue;

      try {
        const outer = _origJsonParse(next);
        if (!Array.isArray(outer)) continue;

        for (const item of outer) {
          if (!Array.isArray(item) || item[0] !== 'wrb.fr' || typeof item[2] !== 'string') continue;

          console.debug('[GSC-WF] processAndPublish: wrb.fr chunk found, rpcid=', item[1],
            '— payload preview:', item[2].substring(0, 120));

          const cands = [];
          collectDailyArrays(_origJsonParse(item[2]), 0, cands);
          if (!cands.length) {
            console.debug('[GSC-WF] processAndPublish: no daily-series candidates in this chunk (not daily view, or format mismatch)');
            continue;
          }
          console.debug('[GSC-WF] processAndPublish: daily candidates=', cands.length, 'longest=', Math.max(...cands.map(c => c.length)));

          // Longest candidate = the main daily performance series.
          const tsRows = cands.reduce((a, b) => b.length > a.length ? b : a);

          // Parse raw rows into clean, serialisable objects.
          const rows = [];
          for (const row of tsRows) {
            if (!Array.isArray(row)) continue;
            const ms = toMs(row[0]);
            if (ms === null) continue;
            const m = Array.isArray(row[1]) ? row[1] : [];
            rows.push({
              date:        new Date(ms).toISOString().slice(0, 10),
              clicks:      typeof m[0] === 'number' ? m[0] : 0,
              impressions: typeof m[1] === 'number' ? m[1] : 0,
              ctr:         typeof m[2] === 'number' ? m[2] : 0,
              position:    typeof m[3] === 'number' ? m[3] : 0,
            });
          }
          if (!rows.length) {
            console.debug('[GSC-WF] processAndPublish: candidates present but 0 rows passed isTimestampMs — check timestamp format');
            continue;
          }
          if (!isValidRows(rows)) continue;

          console.debug(`[GSC-WF] daily series extracted: ${rows.length} rows`);
          console.debug('[GSC-WF] first row sample:', JSON.stringify(tsRows[0]));

          // Publish to ISOLATED world (render_overlay.js listens to this event).
          window.dispatchEvent(new CustomEvent('gsc-wf-raw-series', {
            detail: { rows },
          }));
          return; // Stop after first valid wrb.fr chunk.
        }
      } catch { /* skip malformed chunks */ }
    }

    console.debug('[GSC-WF] processAndPublish: no daily series found in this batchexecute response');
  }

  // ── Candidate validation ──────────────────────────────────────────────────────
  // Search Console CTR is always a decimal fraction in [0, 1].
  // If the median CTR across a sample of rows is > 1.0, the array being parsed
  // is NOT the main performance series (it could be a filtered sub-series, a
  // position-distribution table, or a differently-formatted side dataset).
  // Rejecting these prevents us from displaying nonsensical metrics like 9903 %.

  function isValidRows(rows) {
    if (!rows.length) return false;
    const sample = rows.slice(0, Math.min(10, rows.length));
    const sorted = sample.map(r => r.ctr).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const ok = median <= 1.0;
    if (!ok) console.debug('[GSC-WF] isValidRows: median CTR =', median, '— rejecting (not decimal fraction)');
    return ok;
  }

  // ── JSON.parse interceptor ────────────────────────────────────────────────────
  // Catches the daily series regardless of transport mechanism (XHR body, fetch
  // body, inline script eval, dynamically-inserted <script>, etc.).
  // Uses _origJsonParse internally to avoid wrapper re-entrancy.
  // Reset _jsonSeriesDone on SPA navigation (see initEmbeddedScan).

  let _jsonSeriesDone = false;

  JSON.parse = function jsonParse(text, reviver) {
    const result = _origJsonParse(text, reviver);
    if (!_jsonSeriesDone && _enabled && typeof text === 'string' && text.length > 1000) {
      try {
        const cands = [];
        collectDailyArrays(result, 0, cands);
        if (cands.length) {
          const tsRows = cands.reduce((a, b) => b.length > a.length ? b : a);
          const rows = [];
          for (const row of tsRows) {
            if (!Array.isArray(row)) continue;
            const ms = toMs(row[0]);
            if (ms === null) continue;
            const m = Array.isArray(row[1]) ? row[1] : [];
            rows.push({
              date:        new Date(ms).toISOString().slice(0, 10),
              clicks:      typeof m[0] === 'number' ? m[0] : 0,
              impressions: typeof m[1] === 'number' ? m[1] : 0,
              ctr:         typeof m[2] === 'number' ? m[2] : 0,
              position:    typeof m[3] === 'number' ? m[3] : 0,
            });
          }
          if (!rows.length) {
            console.debug('[GSC-WF] JSON.parse: candidates but 0 valid rows');
          } else if (!isValidRows(rows)) {
            // CTR invalid — let the next JSON.parse call try a different candidate
          } else {
            _jsonSeriesDone = true;
            console.debug('[GSC-WF] JSON.parse: dispatching', rows.length, 'rows, text length:', text.length);
            console.debug('[GSC-WF] JSON.parse first row sample:', _origJsonParse(JSON.stringify(tsRows[0])));
            window.dispatchEvent(new CustomEvent('gsc-wf-raw-series', { detail: { rows } }));
          }
        }
      } catch {}
    }
    return result;
  };

  // ── Embedded data fallback ─────────────────────────────────────────────────────
  // GSC embeds the initial chart data in inline <script> tags (AF_initDataCallback
  // and similar Google patterns). This fallback runs when batchexecute responses
  // are too small to contain a daily series (typical on first page load).

  let _embeddedDone = false;

  function extractBalancedJson(str, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < str.length; i++) {
      if (esc) { esc = false; continue; }
      const c = str[i];
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        if (--depth === 0) {
          try { return JSON.parse(str.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  function tryExtractFromEmbedded() {
    if (_embeddedDone || !_enabled) return;
    console.debug('[GSC-WF] embedded fallback: scanning inline scripts');

    const scripts = document.querySelectorAll('script:not([src])');
    let candidateCount = 0;

    // ── Try extraction: look for `return [`, `= [`, and `([` openers ──────────
    for (const script of scripts) {
      const t = script.textContent;
      if (!t || t.length < 200) continue;
      candidateCount++;

      // Search multiple opener patterns, not just "return ["
      const OPENERS = ['return [', '= [', '([', ',[['];
      for (const opener of OPENERS) {
        let pos = 0;
        while (pos < t.length) {
          const idx = t.indexOf(opener, pos);
          if (idx === -1) break;
          pos = idx + 1;

          const bracketIdx = idx + opener.indexOf('[');
          const parsed = extractBalancedJson(t, bracketIdx);
          if (!parsed || !Array.isArray(parsed)) continue;

          const cands = [];
          collectDailyArrays(parsed, 0, cands);
          if (!cands.length) continue;

          console.debug('[GSC-WF] embedded data candidate found, opener:', JSON.stringify(opener), 'arrays:', cands.length);

          const tsRows = cands.reduce((a, b) => b.length > a.length ? b : a);
          const rows = [];
          for (const row of tsRows) {
            if (!Array.isArray(row)) continue;
            const ms = toMs(row[0]);
            if (ms === null) continue;
            const m = Array.isArray(row[1]) ? row[1] : [];
            rows.push({
              date:        new Date(ms).toISOString().slice(0, 10),
              clicks:      typeof m[0] === 'number' ? m[0] : 0,
              impressions: typeof m[1] === 'number' ? m[1] : 0,
              ctr:         typeof m[2] === 'number' ? m[2] : 0,
              position:    typeof m[3] === 'number' ? m[3] : 0,
            });
          }
          if (!rows.length || !isValidRows(rows)) continue;

          _embeddedDone = true;
          console.debug(`[GSC-WF] embedded daily series extracted: ${rows.length} rows`);
          window.dispatchEvent(new CustomEvent('gsc-wf-raw-series', { detail: { rows } }));
          return;
        }
      }
    }

    console.debug('[GSC-WF] embedded fallback failed:', candidateCount, 'scripts scanned, no daily series');
  }

  // ── DOM-embedded fallback (c-wiz / data-p / jsdata) ──────────────────────────
  // Last non-OAuth attempt: scan c-wiz elements and known Google DOM data-bearing
  // attributes in case the Performance section serialises its state into the DOM.
  // Logs attribute sizes so we can tell empirically whether this path has any data.

  let _domEmbeddedDone = false;

  function tryExtractFromDomEmbedded() {
    if (_domEmbeddedDone || !_enabled) return;
    console.debug('[GSC-WF] dom-embedded fallback: scanning c-wiz/data-p/jsdata');

    let checked = 0, longestAttr = 0, longestAttrName = '';
    const ATTR_NAMES = ['data-p', 'jsdata', 'data-initial-value', 'data-params', 'data-key'];
    const SELECTORS  = 'c-wiz, [data-p], [jsdata], [data-initial-value]';

    for (const el of document.querySelectorAll(SELECTORS)) {
      for (const attr of ATTR_NAMES) {
        const raw = el.getAttribute(attr);
        if (!raw || raw.length < 30) continue;

        if (raw.length > longestAttr) { longestAttr = raw.length; longestAttrName = attr; }
        checked++;

        // Try direct JSON.parse, then URL-decoded variant
        let parsed = null;
        for (const s of [raw, (() => { try { return decodeURIComponent(raw); } catch { return null; } })()]) {
          if (!s) continue;
          try { parsed = JSON.parse(s); break; } catch { /* not valid JSON */ }
        }
        if (!parsed || typeof parsed !== 'object') continue;

        const cands = [];
        collectDailyArrays(parsed, 0, cands);
        if (!cands.length) continue;

        console.debug('[GSC-WF] dom-embedded candidate found in', attr, ', arrays:', cands.length);

        const tsRows = cands.reduce((a, b) => b.length > a.length ? b : a);
        const rows = [];
        for (const row of tsRows) {
          if (!Array.isArray(row)) continue;
          const ms = toMs(row[0]);
          if (ms === null) continue;
          const m = Array.isArray(row[1]) ? row[1] : [];
          rows.push({
            date:        new Date(ms).toISOString().slice(0, 10),
            clicks:      typeof m[0] === 'number' ? m[0] : 0,
            impressions: typeof m[1] === 'number' ? m[1] : 0,
            ctr:         typeof m[2] === 'number' ? m[2] : 0,
            position:    typeof m[3] === 'number' ? m[3] : 0,
          });
        }
        if (!rows.length || !isValidRows(rows)) continue;

        _domEmbeddedDone = true;
        console.debug(`[GSC-WF] dom-embedded daily series extracted: ${rows.length} rows`);
        window.dispatchEvent(new CustomEvent('gsc-wf-raw-series', { detail: { rows } }));
        console.debug('[GSC-WF] raw-series event dispatched from dom-embedded fallback');
        return;
      }
    }

    // Report longest attribute found — key diagnostic: if max is <500 chars, it's
    // configuration/references only, not chart data. Chart data would be >50 KB.
    console.debug(
      '[GSC-WF] dom-embedded fallback failed: checked', checked, 'attributes,',
      longestAttr ? `longest was ${longestAttr} chars (${longestAttrName})` : 'no parseable attributes found'
    );
  }

  // Run once after DOM is ready; reset + re-scan on SPA navigation.
  // MAIN world hooks are authoritative: they share GSC's JS execution context.
  (function initEmbeddedScan() {
    function run() {
      setTimeout(tryExtractFromEmbedded,    800);
      setTimeout(tryExtractFromDomEmbedded, 1200); // slightly later so DOM is fully settled
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState    = function (...a) {
      origPush(...a);
      _embeddedDone = false; _domEmbeddedDone = false; _jsonSeriesDone = false;
      setTimeout(tryExtractFromEmbedded,    1500);
      setTimeout(tryExtractFromDomEmbedded, 1800);
    };
    history.replaceState = function (...a) {
      origReplace(...a);
      _embeddedDone = false; _domEmbeddedDone = false; _jsonSeriesDone = false;
      setTimeout(tryExtractFromEmbedded,    1500);
      setTimeout(tryExtractFromDomEmbedded, 1800);
    };
    window.addEventListener('popstate', () => {
      _embeddedDone = false; _domEmbeddedDone = false; _jsonSeriesDone = false;
      setTimeout(tryExtractFromEmbedded,    1500);
      setTimeout(tryExtractFromDomEmbedded, 1800);
    });
  })();

  // ── Worker interceptor ────────────────────────────────────────────────────────
  // GSC loads chart data inside a Web Worker whose fetch/XHR bypasses window wraps.
  // Intercept Worker creation to prepend our monitors, then forward batchexecute
  // responses back to the main thread via postMessage.

  (function interceptWorkers() {
    const OrigWorker = window.Worker;
    if (typeof OrigWorker !== 'function') return;

    // Preamble prepended to every non-module worker script.
    // Uses charCode checks to avoid string-escape issues across blob contexts.
    const PREAMBLE = `(function(){
  function _ib(t){return t&&t.charCodeAt(0)===41&&t.charCodeAt(1)===93&&t.charCodeAt(2)===125&&t.charCodeAt(3)===39;}
  function _rpt(t,u){if(_ib(t))self.postMessage({__gscwf:1,t:t,u:u.slice(0,200)});}
  var _gf=self.fetch.bind(self);
  self.fetch=async function(){var a=[].slice.call(arguments);var r=await _gf.apply(self,a);
    try{var u=a[0] instanceof Request?a[0].url:String(a[0]||'');
      if(/search\\.google\\.com|googleapis\\.com/.test(u))r.clone().text().then(function(t){_rpt(t,u);}).catch(function(){});}
    catch(e){}return r;};
  var _xo=XMLHttpRequest.prototype.open,_xs=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this.__wu=u;return _xo.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(){
    if(this.__wu&&/search\\.google\\.com|googleapis\\.com/.test(this.__wu)){
      (function(xhr,cu){xhr.addEventListener('load',function(){try{_rpt(xhr.responseText,cu);}catch(e){}});})(this,this.__wu);}
    return _xs.apply(this,arguments);};
})();\n`;

    window.Worker = function(scriptURL, options) {
      const isModule = options && options.type === 'module';
      let worker;
      try {
        if (isModule) throw new Error('module worker');
        const abs = new URL(String(scriptURL), location.href).href;
        const blob = new Blob(
          [PREAMBLE + 'importScripts(' + JSON.stringify(abs) + ');'],
          { type: 'text/javascript' }
        );
        const burl = URL.createObjectURL(blob);
        worker = new OrigWorker(burl, options);
        setTimeout(function(){ URL.revokeObjectURL(burl); }, 20000);
        console.debug('[GSC-WF] worker created with interceptor:', abs.substring(0, 120));
      } catch(e) {
        console.debug('[GSC-WF] worker fallback (no interceptor):', String(e.message).substring(0, 80));
        worker = new OrigWorker(scriptURL, options);
      }
      worker.addEventListener('message', function(e) {
        if (e.data && e.data.__gscwf === 1 && _enabled) {
          console.debug('[GSC-WF] worker: batchexecute', e.data.t.length + 'b', e.data.u);
          processAndPublish(e.data.t);
        }
      });
      return worker;
    };
    window.Worker.prototype = OrigWorker.prototype;
    console.debug('[GSC-WF] Worker constructor wrapped');
  })();

  // ── Fetch interceptor (passive — read only, no mutation) ──────────────────────
  // Captures ALL requests to Google API domains. Every URL + size is logged so we
  // can see the full network picture. processAndPublish() discards non-batchexecute.

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _fetch.apply(this, args);
    if (!_enabled) return response;
    const url = args[0] instanceof Request ? args[0].url : String(args[0] ?? '');
    if (isGoogleApiUrl(url)) {
      response.clone().text().then(t => {
        const label = t.startsWith(")]}'\n") ? 'fetch: batchexecute' : 'fetch: non-batch  ';
        console.debug(`[GSC-WF] ${label} ${t.length}b  ${url.substring(0, 140)}`);
        if (t.startsWith(")]}'\n")) processAndPublish(t);
      }).catch(() => {});
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
    if (this._gscWFUrl && isGoogleApiUrl(this._gscWFUrl)) {
      const capturedUrl = this._gscWFUrl;
      this.addEventListener('load', () => {
        if (!_enabled) return;
        const t = this.responseText;
        if (!t) return;
        const label = t.startsWith(")]}'\n") ? 'XHR: batchexecute' : 'XHR: non-batch  ';
        console.debug(`[GSC-WF] ${label} ${t.length}b  ${capturedUrl.substring(0, 140)}`);
        if (t.startsWith(")]}'\n")) try { processAndPublish(t); } catch {}
      });
    }
    return _xhrSend.apply(this, args);
  };

  console.debug('[GSC-WF] interceptors installed');
})();
