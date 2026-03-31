// render_overlay.js — ISOLATED world content script
// Responsibilities: render Business Days View panel, SVG chart with hover tooltip,
// survive GSC SPA rerenders.  Does NOT patch Google's native UI.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────────

  const PANEL_ID     = 'gsc-wf-panel';
  const MOUNT_ROW_ID = 'gsc-wf-mount-row';
  const STYLES_ID    = 'gsc-wf-styles';
  const NOTICE_ID    = 'gsc-wf-notice';

  // SVG viewport (shared between buildChartSVG and attachChartHover)
  const W=900, H=260, ML=68, MR=68, MT=22, MB=44;
  const PW = W - ML - MR;  // 764  — plot width
  const PH = H - MT - MB;  // 194  — plot height

  const CLR = { clicks: '#4285f4', impressions: '#34a853' };

  // ── State (module-level, no globals on window) ────────────────────────────────

  let _cfg = {
    enabled: true, hideSaturday: true, hideSunday: true,
    hideHolidays: false, country: 'ES', holidays: {},
  };
  let _rawRows       = null;  // latest rows from injected.js
  let _filtered      = null;  // buildFiltered() result
  let _nativeEl      = null;  // outer GSC performance section reference
  let _nativeHidden  = false;
  let _lastSig       = '';
  let _renderTimer   = null;
  let _renderActive  = false;
  let _pendingRender = false;
  let _loggedWait    = false;
  let _retryCount    = 0;
  let _retryTimer    = null;  // separate from _renderTimer — NOT cancelled by scheduleRender
  let _routeChangedAt = 0;    // timestamp of last route change with no data yet
  let _noticeTimer   = null;  // timer before showing the floating reload notice
  const MAX_RETRIES  = 60;    // 60 × 2 s = 2 min of retries after panel loss

  // ── Floating reload notice ────────────────────────────────────────────────────
  // Shown when the panel disappears after a date range change and can't be
  // re-mounted. Uses position:fixed so it's always visible regardless of DOM.

  function showReloadNotice() {
    if (!_cfg.enabled || document.getElementById(NOTICE_ID)) return;
    const el = document.createElement('div');
    el.id = NOTICE_ID;
    el.setAttribute('data-gsc-wf-owned', '1');
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:#1a73e8;color:#fff;' +
      'font-family:Google Sans,Roboto,Arial,sans-serif;font-size:13px;' +
      'padding:9px 16px;display:flex;align-items:center;gap:10px;' +
      'box-shadow:0 2px 6px rgba(0,0,0,.3)';
    el.innerHTML =
      '<span style="flex:1"><strong>Business Days View</strong> — date range changed — ' +
      '<a href="" onclick="location.reload();return false" ' +
      'style="color:#fff;font-weight:600;text-decoration:underline">reload page</a> to update</span>' +
      '<button onclick="document.getElementById(\'' + NOTICE_ID + '\').remove()" ' +
      'style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;' +
      'padding:0 4px;line-height:1;opacity:.8">×</button>';
    document.body.appendChild(el);
    console.debug('[GSC-WF] reload notice shown');
  }

  function hideReloadNotice() {
    document.getElementById(NOTICE_ID)?.remove();
    if (_noticeTimer) { clearTimeout(_noticeTimer); _noticeTimer = null; }
  }

  // Schedule the notice after a delay — cancelled if data arrives first.
  function scheduleNotice(delaySec) {
    if (_noticeTimer) return; // already scheduled
    _noticeTimer = setTimeout(() => {
      _noticeTimer = null;
      if (!_filtered) showReloadNotice();
    }, delaySec * 1000);
  }

  // ── Event listeners ───────────────────────────────────────────────────────────

  window.addEventListener('gsc-filter-config', (e) => {
    _cfg = { ..._cfg, ...e.detail };
    if (!_cfg.enabled) { disablePanel(); return; }
    if (_rawRows) {
      _filtered = buildFiltered(_rawRows, _cfg);
      scheduleRender('config-change');
    }
  });

  window.addEventListener('gsc-wf-raw-series', (e) => {
    console.debug('[GSC-WF] raw-series event received, rows:', e.detail?.rows?.length ?? 0);
    const rows = e.detail?.rows;
    if (!Array.isArray(rows) || !rows.length) return;
    _rawRows        = rows;
    _filtered       = buildFiltered(rows, _cfg);
    _retryCount     = 0;
    _loggedWait     = false;
    _routeChangedAt = 0;
    hideReloadNotice();
    console.debug(`[GSC-WF] filtered series built: ${_filtered.shownDays} business days of ${_filtered.totalDays}`);
    // If the panel isn't in the DOM yet, discard any pending retry timer so the
    // scheduleRender below triggers a fresh, immediate mount attempt rather than
    // waiting for the old timer to fire.
    if (!document.getElementById(PANEL_ID)) {
      clearTimeout(_retryTimer); _retryTimer = null;
    }
    scheduleRender('data-change');
  });

  // ── Data model ────────────────────────────────────────────────────────────────

  function buildFiltered(rawRows, cfg) {
    const holidays = (cfg.holidays || {})[cfg.country || 'ES'] || [];
    const rows = rawRows.map(row => {
      const dow       = new Date(row.date + 'T12:00:00Z').getUTCDay();
      const isWeekend = (cfg.hideSaturday && dow === 6) || (cfg.hideSunday && dow === 0);
      const isHoliday = cfg.hideHolidays && holidays.includes(row.date);
      const isFiltered = cfg.enabled && (isWeekend || isHoliday);
      return { ...row, isWeekend, isHoliday, isBusinessDay: !isFiltered };
    });
    const biz = cfg.enabled ? rows.filter(r => r.isBusinessDay) : rows;
    return {
      rows, businessDays: biz,
      shownDays:        biz.length,
      totalDays:        rows.length,
      totalClicks:      biz.reduce((s, r) => s + r.clicks,      0),
      totalImpressions: biz.reduce((s, r) => s + r.impressions, 0),
      avgCTR:           biz.length ? biz.reduce((s, r) => s + r.ctr,      0) / biz.length : 0,
      avgPosition:      biz.length ? biz.reduce((s, r) => s + r.position, 0) / biz.length : 0,
    };
  }

  // ── Formatting ────────────────────────────────────────────────────────────────

  const _f1  = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const _f0  = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  function fmtCount(v) {
    if (v >= 1e9) return _f1.format(v / 1e9)  + '\u00a0B';
    if (v >= 1e6) return _f1.format(v / 1e6)  + '\u00a0M';
    if (v >= 1e3) return _f1.format(v / 1e3)  + '\u00a0K';
    return _f0.format(v);
  }
  function fmtCtr(v)  { return _f1.format(v * 100) + '\u00a0%'; }
  function fmtPos(v)  { return _f1.format(v); }
  function fmtAxis(n) {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return n.toFixed(0);
  }
  function fmtXDate(d) {        // short X-axis label
    return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  }
  function fmtTipDate(d) {      // tooltip header (includes weekday)
    return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // ── SVG chart ─────────────────────────────────────────────────────────────────
  // Builds static chart SVG + hover infrastructure elements (hidden by default).
  // IDs use "gsc-wf-" prefix; all interactive elements carry pointer-events="none"
  // except the transparent capture rect which sits on top.

  function buildChartSVG(biz) {
    if (!biz?.length) {
      return '<p style="text-align:center;color:#80868b;padding:30px 0;margin:0">Not enough data.</p>';
    }

    const n   = biz.length;
    const xOf = i => n === 1 ? ML + PW / 2 : ML + (i / (n - 1)) * PW;

    const maxC = Math.max(...biz.map(d => d.clicks),      1) * 1.1;
    const maxI = Math.max(...biz.map(d => d.impressions), 1) * 1.1;
    const yC   = v => MT + PH - (v / maxC) * PH;
    const yI   = v => MT + PH - (v / maxI) * PH;

    const p2 = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
    const clkPts  = biz.map((d, i) => p2(xOf(i), yC(d.clicks))).join(' ');
    const imprPts = biz.map((d, i) => p2(xOf(i), yI(d.impressions))).join(' ');

    // X axis sparse labels (~5 ticks)
    const step   = Math.max(1, Math.ceil(n / 5));
    const xTicks = biz.map((d, i) => ({ i, d }))
      .filter(({ i }) => i === 0 || i === n - 1 || i % step === 0)
      .map(({ i, d }) => {
        const x = xOf(i).toFixed(1), yb = (MT + PH).toFixed(1);
        return `<line x1="${x}" y1="${yb}" x2="${x}" y2="${(MT+PH+5).toFixed(1)}" stroke="#dadce0" stroke-width="1"/>
                <text x="${x}" y="${(MT+PH+17).toFixed(1)}" text-anchor="middle" font-size="11" fill="#80868b">${fmtXDate(d.date)}</text>`;
      }).join('');

    // Y ticks (4 intervals)
    const nY = 4;
    const leftY = Array.from({ length: nY + 1 }, (_, k) => {
      const v = maxC * k / nY, y = yC(v).toFixed(1);
      return `<line x1="${ML}" y1="${y}" x2="${(W-MR).toFixed(1)}" y2="${y}" stroke="#f1f3f4" stroke-width="1"/>
              <line x1="${(ML-4).toFixed(1)}" y1="${y}" x2="${ML}" y2="${y}" stroke="#dadce0" stroke-width="1"/>
              <text x="${(ML-8).toFixed(1)}" y="${(parseFloat(y)+4).toFixed(1)}" text-anchor="end" font-size="11" fill="${CLR.clicks}">${fmtAxis(v)}</text>`;
    }).join('');
    const rightY = Array.from({ length: nY + 1 }, (_, k) => {
      const v = maxI * k / nY, y = yI(v).toFixed(1);
      return `<line x1="${(W-MR).toFixed(1)}" y1="${y}" x2="${(W-MR+4).toFixed(1)}" y2="${y}" stroke="#dadce0" stroke-width="1"/>
              <text x="${(W-MR+8).toFixed(1)}" y="${(parseFloat(y)+4).toFixed(1)}" text-anchor="start" font-size="11" fill="${CLR.impressions}">${fmtAxis(v)}</text>`;
    }).join('');

    const lx=(ML/2).toFixed(1), ly=(MT+PH/2).toFixed(1);
    const rx=(W-MR/2).toFixed(1), ry=(MT+PH/2).toFixed(1);

    // Tooltip dimensions in SVG units
    const TW=155, TH=100, TP=9;

    return `<svg data-gsc-wf-chart viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="gsc-wf-sf" x="-5%" y="-5%" width="115%" height="130%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.18"/>
    </filter>
  </defs>

  <!-- Background + gridlines -->
  <rect x="${ML}" y="${MT}" width="${PW}" height="${PH}" fill="#fafafa"/>
  ${leftY}${rightY}
  <!-- Axes -->
  <line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT+PH}" stroke="#dadce0" stroke-width="1"/>
  <line x1="${W-MR}" y1="${MT}" x2="${W-MR}" y2="${MT+PH}" stroke="#dadce0" stroke-width="1"/>
  <line x1="${ML}" y1="${MT+PH}" x2="${W-MR}" y2="${MT+PH}" stroke="#dadce0" stroke-width="1"/>
  <!-- Data lines -->
  <polyline points="${imprPts}" fill="none" stroke="${CLR.impressions}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="${clkPts}"  fill="none" stroke="${CLR.clicks}"      stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <!-- X axis -->
  ${xTicks}
  <!-- Axis rotation labels -->
  <text x="${lx}" y="${ly}" text-anchor="middle" font-size="11" fill="${CLR.clicks}" transform="rotate(-90,${lx},${ly})">Clicks</text>
  <text x="${rx}" y="${ry}" text-anchor="middle" font-size="11" fill="${CLR.impressions}" transform="rotate(90,${rx},${ry})">Impressions</text>

  <!-- Hover layer (all pointer-events="none" except capture rect) -->
  <line id="gsc-wf-gl" x1="0" y1="${MT}" x2="0" y2="${MT+PH}" stroke="#9e9e9e" stroke-width="1" stroke-dasharray="4,3" pointer-events="none" visibility="hidden"/>
  <circle id="gsc-wf-mc" r="5" fill="${CLR.clicks}"      stroke="#fff" stroke-width="2" pointer-events="none" visibility="hidden"/>
  <circle id="gsc-wf-mi" r="5" fill="${CLR.impressions}" stroke="#fff" stroke-width="2" pointer-events="none" visibility="hidden"/>

  <!-- Tooltip (positioned by transform on the <g>) -->
  <g id="gsc-wf-tt" pointer-events="none" visibility="hidden">
    <rect id="gsc-wf-tt-bg" x="0" y="0" width="${TW}" height="${TH}" rx="4" ry="4"
          fill="white" stroke="#dadce0" stroke-width="1" filter="url(#gsc-wf-sf)"/>
    <text id="gsc-wf-tt-dt" x="${TP}" y="${TP+14}" font-size="12" font-weight="500" fill="#202124"/>
    <text id="gsc-wf-tt-ck" x="${TP}" y="${TP+30}" font-size="11" fill="${CLR.clicks}"/>
    <text id="gsc-wf-tt-im" x="${TP}" y="${TP+46}" font-size="11" fill="${CLR.impressions}"/>
    <text id="gsc-wf-tt-ct" x="${TP}" y="${TP+62}" font-size="11" fill="#5f6368"/>
    <text id="gsc-wf-tt-po" x="${TP}" y="${TP+78}" font-size="11" fill="#5f6368"/>
  </g>

  <!-- Transparent hover capture rect — must be LAST (topmost) -->
  <rect id="gsc-wf-hr" x="${ML}" y="${MT}" width="${PW}" height="${PH}"
        fill="transparent" style="cursor:crosshair" pointer-events="all"/>
</svg>`;
  }

  // ── Attach hover handlers ─────────────────────────────────────────────────────
  // Called once after panel.innerHTML is set. Uses biz (filtered daily rows) as
  // source of truth for tooltip values — never derived from chart aggregates.

  function attachChartHover(panel, biz) {
    if (!biz?.length || biz.length < 2) return;

    const svg = panel.querySelector('[data-gsc-wf-chart]');
    if (!svg) return;

    const q = id => svg.querySelector('#' + id);
    const hoverRect = q('gsc-wf-hr');
    const guideline = q('gsc-wf-gl');
    const markerC   = q('gsc-wf-mc');
    const markerI   = q('gsc-wf-mi');
    const tooltip   = q('gsc-wf-tt');
    const ttDt      = q('gsc-wf-tt-dt');
    const ttCk      = q('gsc-wf-tt-ck');
    const ttIm      = q('gsc-wf-tt-im');
    const ttCt      = q('gsc-wf-tt-ct');
    const ttPo      = q('gsc-wf-tt-po');
    if (!hoverRect || !guideline || !tooltip) return;

    // Precompute Y scales (same as buildChartSVG)
    const n    = biz.length;
    const maxC = Math.max(...biz.map(d => d.clicks),      1) * 1.1;
    const maxI = Math.max(...biz.map(d => d.impressions), 1) * 1.1;
    const xOf  = i => n === 1 ? ML + PW / 2 : ML + (i / (n - 1)) * PW;
    const yC   = v => MT + PH - (v / maxC) * PH;
    const yI   = v => MT + PH - (v / maxI) * PH;

    const TW = 155; // tooltip width (matches buildChartSVG)

    function onMove(e) {
      const rect  = svg.getBoundingClientRect();
      const svgX  = (e.clientX - rect.left) * (W / rect.width);

      // Nearest business-day index
      const rawIdx = (svgX - ML) / PW * (n - 1);
      const idx    = Math.max(0, Math.min(n - 1, Math.round(rawIdx)));
      const row    = biz[idx];

      const cx = xOf(idx), cy = yC(row.clicks), iy = yI(row.impressions);

      // Guideline
      guideline.setAttribute('x1', cx.toFixed(1));
      guideline.setAttribute('x2', cx.toFixed(1));
      guideline.setAttribute('visibility', 'visible');

      // Markers
      markerC.setAttribute('cx', cx.toFixed(1));
      markerC.setAttribute('cy', cy.toFixed(1));
      markerC.setAttribute('visibility', 'visible');
      markerI.setAttribute('cx', cx.toFixed(1));
      markerI.setAttribute('cy', iy.toFixed(1));
      markerI.setAttribute('visibility', 'visible');

      // Tooltip text (from filtered daily row — not from chart aggregates)
      ttDt.textContent = fmtTipDate(row.date);
      ttCk.textContent = `Clicks: ${fmtCount(row.clicks)}`;
      ttIm.textContent = `Impr: ${fmtCount(row.impressions)}`;
      ttCt.textContent = `CTR: ${fmtCtr(row.ctr)}`;
      ttPo.textContent = `Position: ${fmtPos(row.position)}`;

      // Tooltip position: right of cursor, flip left near right edge
      const MARGIN = 14;
      let tx = cx + MARGIN;
      if (tx + TW > W - MR + 8) tx = cx - TW - MARGIN;
      if (tx < ML + 4) tx = ML + 4;
      const ty = MT + 4;

      tooltip.setAttribute('transform', `translate(${tx.toFixed(1)},${ty.toFixed(1)})`);
      tooltip.setAttribute('visibility', 'visible');
    }

    function onLeave() {
      guideline.setAttribute('visibility', 'hidden');
      markerC.setAttribute('visibility', 'hidden');
      markerI.setAttribute('visibility', 'hidden');
      tooltip.setAttribute('visibility', 'hidden');
    }

    hoverRect.addEventListener('mousemove', onMove);
    hoverRect.addEventListener('mouseleave', onLeave);
    console.debug('[GSC-WF] tooltip ready');
  }

  // ── Panel HTML builders ───────────────────────────────────────────────────────

  function buildPanelHTML(fd) {
    const kpis = [
      { label: 'Clicks',        val: fmtCount(fd.totalClicks),      color: CLR.clicks      },
      { label: 'Impressions',   val: fmtCount(fd.totalImpressions),  color: CLR.impressions },
      { label: 'Avg CTR',       val: fmtCtr(fd.avgCTR),              color: '#f9ab00'       },
      { label: 'Avg Position',  val: fmtPos(fd.avgPosition),         color: '#ea4335'       },
    ];
    const cards = kpis.map(k =>
      `<div style="flex:1;min-width:130px;padding:12px 16px;background:#fff;border-radius:4px;
                   border-bottom:3px solid ${k.color};box-shadow:0 1px 2px rgba(0,0,0,.1)">
         <div style="font-size:12px;color:#5f6368;margin-bottom:4px">${k.label}</div>
         <div style="font-size:22px;font-weight:500;color:#202124">${k.val}</div>
       </div>`).join('');

    const weekendsRemoved = fd.rows.filter(r => r.isWeekend && !r.isBusinessDay).length;
    const fmtRangeDate    = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const startDate       = fd.rows[0]?.date;
    const endDate         = fd.rows[fd.rows.length - 1]?.date;
    const rangeLabel      = startDate && endDate ? `${fmtRangeDate(startDate)} – ${fmtRangeDate(endDate)}` : '';

    const toggleLabel = _nativeHidden ? 'Show Google view' : 'Hide Google view';

    return `<div style="font-family:'Google Sans',Roboto,Arial,sans-serif;background:#f8f9fa;
                         border:1px solid #dadce0;border-radius:8px;padding:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-size:14px;font-weight:500;color:#202124">Business Days View: ${fd.shownDays}</span>
          <span style="font-size:12px;color:#1967d2;background:#e8f0fe;padding:2px 8px;border-radius:10px">
            ${weekendsRemoved} weekends removed
          </span>
          ${rangeLabel ? `<span style="font-size:12px;color:#80868b;background:#f1f3f4;padding:2px 8px;border-radius:10px">${rangeLabel}</span>` : ''}
        </div>
        <button data-gsc-wf-toggle style="font-size:12px;color:#1a73e8;background:#fff;
          border:1px solid #dadce0;border-radius:4px;padding:5px 14px;cursor:pointer;line-height:1.4">
          ${toggleLabel}
        </button>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">${cards}</div>
      <div style="background:#fff;border:1px solid #dadce0;border-radius:4px;padding:8px 2px 4px">
        ${buildChartSVG(fd.businessDays)}
      </div>
    </div>`;
  }

  function buildWaitingHTML(hint) {
    let msg;
    if (hint === 'reload') {
      msg = 'date range changed — <a href="" onclick="location.reload();return false" '
          + 'style="color:#1a73e8;font-weight:500;text-decoration:none">reload page</a> to update';
    }
    return `<div style="font-family:'Google Sans',Roboto,Arial,sans-serif;background:#f8f9fa;
                         border:1px solid #dadce0;border-radius:8px;padding:16px;color:#5f6368;font-size:13px">
      <strong style="color:#202124">Business Days View</strong>&nbsp;— ${msg || 'waiting for daily chart data…'}
    </div>`;
  }

  // ── Mount target detection ────────────────────────────────────────────────────
  // Find the OUTER GSC performance section: the ancestor of the chart SVG whose
  // top edge is at least MIN_ABOVE_PX above the SVG (meaning it contains the
  // native KPI cards row above the chart).

  const MIN_ABOVE_PX = 60;   // relaxed: KPI cards are ~60 px above the chart SVG
  const MIN_WIDTH_PX = 400;  // relaxed: accommodates narrower viewports

  function findMountTarget() {
    let bestSvg = null, bestScore = 0;
    document.querySelectorAll('svg').forEach(svg => {
      if (svg.closest('[data-gsc-wf-owned]')) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 50) return;
      // Count any shape element — GSC may use path, polyline, or line for chart lines
      const cnt = svg.querySelectorAll('path, polyline, line').length;
      // Score by element count; break ties by area (larger = more likely the chart)
      const score = cnt * 10000 + rect.width * rect.height;
      if (score > bestScore) { bestScore = score; bestSvg = svg; }
    });
    // Require at least one shape element (pure-icon SVGs have none)
    if (!bestSvg || bestScore < 10000) return null;

    const svgAbsTop = bestSvg.getBoundingClientRect().top + window.scrollY;
    let el = bestSvg.parentElement;

    for (let d = 0; d < 35; d++) {  // increased depth limit for deeply-nested SPAs
      if (!el || el === document.body || el === document.documentElement) break;
      const rect = el.getBoundingClientRect();
      const elTop = rect.top + window.scrollY;
      if (elTop < svgAbsTop - MIN_ABOVE_PX && rect.width >= MIN_WIDTH_PX) {
        console.debug('[GSC-WF] mount target accepted');
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // ── Native section toggle ─────────────────────────────────────────────────────

  function hideNativeSection() {
    if (!_nativeEl || !document.contains(_nativeEl)) return;
    _nativeEl.style.setProperty('display', 'none', 'important');
    _nativeHidden = true;
    console.debug('[GSC-WF] native section hidden');
  }

  function restoreNativeSection() {
    if (!_nativeEl) return;
    const was = _nativeEl.getAttribute('data-gsc-wf-was-display') || '';
    if (was) _nativeEl.style.display = was; else _nativeEl.style.removeProperty('display');
    _nativeHidden = false;
    console.debug('[GSC-WF] native section restored');
  }

  function toggleNativeSection() {
    if (_nativeHidden) restoreNativeSection(); else hideNativeSection();
    _lastSig = '';
    scheduleRender('toggle');
  }

  function disablePanel() {
    restoreNativeSection();
    document.getElementById(MOUNT_ROW_ID)?.remove();
    hideReloadNotice();
    clearTimeout(_retryTimer); _retryTimer = null;
    _nativeEl     = null;
    _nativeHidden = false;
    _lastSig      = '';
    _retryCount   = 0;
    _loggedWait   = false;
    console.debug('[GSC-WF] panel removed, native section restored');
  }

  // ── CSS injection ─────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLES_ID)) return;
    const s = document.createElement('style');
    s.id = STYLES_ID;
    s.setAttribute('data-gsc-wf-owned', '1');
    s.textContent = `
      #${MOUNT_ROW_ID} {
        display:block!important;width:100%!important;max-width:none!important;
        position:relative!important;left:auto!important;right:auto!important;
        top:auto!important;float:none!important;clear:both!important;
        flex:0 0 100%!important;align-self:stretch!important;
        grid-column:1/-1!important;box-sizing:border-box!important;
        margin:0 0 20px 0!important;padding:0!important;
        overflow:visible!important;transform:none!important;z-index:10!important;
      }
      #${PANEL_ID} {
        display:block!important;width:100%!important;max-width:none!important;
        position:relative!important;left:auto!important;right:auto!important;
        top:auto!important;bottom:auto!important;float:none!important;
        clear:both!important;transform:none!important;
        box-sizing:border-box!important;overflow:visible!important;z-index:10!important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Render orchestration ──────────────────────────────────────────────────────

  function renderSig() {
    if (!_filtered) return 'waiting';
    const f = _filtered;
    return `${f.shownDays}:${f.totalDays}:${f.totalClicks.toFixed(0)}:${f.totalImpressions.toFixed(0)}:${_cfg.enabled}:${_nativeHidden}`;
  }

  // Main idempotent render function.
  function renderOrUpdate(reason) {
    if (!_cfg.enabled) { disablePanel(); return; }

    injectStyles();

    // ── 1. Find or validate mount target ────────────────────────────────────────
    // If the SVG-based search fails (chart in loading state, shadow DOM, etc.)
    // but we already have a live _nativeEl, keep using it so the panel stays
    // mounted and can show a "waiting / reload" message without disappearing.
    let target = findMountTarget();
    if (!target) {
      if (_nativeEl && document.contains(_nativeEl)) {
        target = _nativeEl; // fallback: reuse existing mount point
        console.debug('[GSC-WF] findMountTarget failed — reusing existing native section');
      } else {
        if (!_loggedWait) {
          console.debug('[GSC-WF] mount deferred: waiting for stable performance section');
          _loggedWait = true;
        }
        // Only count retries from explicit _retryTimer firings, NOT from every
        // mutation-triggered render. This prevents exhausting MAX_RETRIES
        // prematurely while GSC is still mutating the DOM.
        if (reason === 'retry-mount') _retryCount++;

        if (_retryCount < MAX_RETRIES && !_retryTimer) {
          // Do NOT clear an existing timer — mutation-triggered renders must not
          // keep pushing the retry back. Once scheduled, let it fire.
          _retryTimer = setTimeout(() => {
            _retryTimer = null;
            scheduleRender('retry-mount');
          }, 300);
        }
        return;
      }
    }

    // ── 2. Re-link native section reference if GSC replaced the node ────────────
    if (!_nativeEl || !document.contains(_nativeEl)) {
      _nativeEl = target;
      _nativeEl.setAttribute('data-gsc-wf-was-display', target.style.display || '');
      console.debug('[GSC-WF] native section relinked');
      // Native section changed — remove stale mount row so it re-inserts before new section
      document.getElementById(MOUNT_ROW_ID)?.remove();
      // Re-apply hide state if user had toggled it before the node was replaced
      if (_nativeHidden) hideNativeSection();
    }

    // ── 3. Get or create mount row (inserted immediately before native section) ──
    let mountRow = document.getElementById(MOUNT_ROW_ID);
    if (mountRow && !document.contains(mountRow)) {
      mountRow.remove();
      mountRow = null;
    }
    if (!mountRow) {
      mountRow = document.createElement('div');
      mountRow.id = MOUNT_ROW_ID;
      mountRow.setAttribute('data-gsc-wf-owned', '1');
      target.insertAdjacentElement('beforebegin', mountRow);
      console.debug('[GSC-WF] mount row inserted');
      _lastSig = ''; // force full render after recreation
    }

    // ── 4. Get or create panel ───────────────────────────────────────────────────
    let panel = document.getElementById(PANEL_ID);
    if (panel && !mountRow.contains(panel)) {
      // Orphaned panel (not inside our mount row) — remove and recreate
      panel.remove();
      panel = null;
    }
    let isNewPanel = false;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.setAttribute('data-gsc-wf-owned', '1');
      mountRow.appendChild(panel);
      panel.addEventListener('click', e => {
        if (e.target.closest('[data-gsc-wf-toggle]')) toggleNativeSection();
      });
      isNewPanel = true;
      _lastSig = ''; // force full render on new panel
    }

    // ── 5. Width sanity check ────────────────────────────────────────────────────
    // If the panel has no width yet (layout not settled), defer once.
    const pw = panel.getBoundingClientRect().width;
    if (isNewPanel && pw < 50) {
      console.debug(`[GSC-WF] render deferred: container width = ${Math.round(pw)}`);
      scheduleRender('layout-stabilization');
      return;
    }

    // ── 6. No filtered data → waiting state ─────────────────────────────────────
    if (!_filtered) {
      const elapsed = _routeChangedAt ? Date.now() - _routeChangedAt : 0;
      panel.innerHTML = buildWaitingHTML(elapsed > 7000 ? 'reload' : null);
      if (!_loggedWait) {
        console.debug('[GSC-WF] waiting for daily view');
        _loggedWait = true;
        if (_routeChangedAt) {
          // Schedule a re-render after 8 s to show the reload prompt if data still missing
          setTimeout(() => { if (!_filtered) scheduleRender('data-timeout'); }, 8000);
        }
      }
      return;
    }

    // ── 7. Idempotent render ─────────────────────────────────────────────────────
    const sig = renderSig();
    if (sig === _lastSig && !isNewPanel) return;

    panel.innerHTML = buildPanelHTML(_filtered);
    _lastSig    = sig;
    _retryCount = 0;
    _loggedWait = false;

    const verb = isNewPanel ? 'panel mounted' : 'panel updated';
    console.debug(
      `[GSC-WF] ${verb} — ${_filtered.shownDays} of ${_filtered.totalDays} days, ` +
      `clicks=${fmtCount(_filtered.totalClicks)}, impressions=${fmtCount(_filtered.totalImpressions)}`
    );

    // ── 8. Attach chart hover (after innerHTML is set) ──────────────────────────
    attachChartHover(panel, _filtered.businessDays);
  }

  // ── Debounced scheduler ───────────────────────────────────────────────────────

  function scheduleRender(reason) {
    // Route changes (date range, view, navigation) invalidate stale series data.
    if (reason === 'route-change') {
      _rawRows        = null;
      _filtered       = null;
      _lastSig        = '';
      _loggedWait     = false;
      _retryCount     = 0;
      clearTimeout(_retryTimer); _retryTimer = null;
      _routeChangedAt = Date.now();
      // Do NOT clear _nativeEl here: if GSC reuses the same container element
      // (common for in-page date range changes), the panel stays mounted and
      // shows "waiting" immediately. If the element gets replaced, the
      // MutationObserver catches it and clears _nativeEl then.
      scheduleNotice(8); // show floating banner if no data in 8 s
      console.debug('[GSC-WF] route changed');
    }

    // Coalesce concurrent calls: if render is in progress, queue one follow-up.
    if (_renderActive) { _pendingRender = true; return; }

    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(() => {
      _renderActive  = true;
      _pendingRender = false;
      try {
        renderOrUpdate(reason);
      } finally {
        _renderActive = false;
        if (_pendingRender) scheduleRender('deferred');
      }
    }, reason === 'layout-stabilization' ? 600 : reason === 'data-change' ? 50 : 350);
  }

  // ── SPA navigation detection ──────────────────────────────────────────────────

  (function hookHistory() {
    const orig = { push: history.pushState.bind(history), replace: history.replaceState.bind(history) };
    history.pushState = function (...a) { orig.push(...a);    scheduleRender('route-change'); };
    history.replaceState = function (...a) { orig.replace(...a); scheduleRender('route-change'); };
    window.addEventListener('popstate', () => scheduleRender('route-change'));
  })();

  // ── MutationObserver ──────────────────────────────────────────────────────────
  // Conservative: only re-renders when our own nodes disappear or a new chart
  // SVG appears. Does NOT re-render on every DOM mutation.

  (function setupObserver() {
    let _debounceTimer = null;

    const mo = new MutationObserver((mutations) => {
      if (!_cfg.enabled) return;

      // Native section node was replaced by GSC (SPA rerender)
      if (_nativeEl && !document.contains(_nativeEl)) {
        _nativeEl = null;
        scheduleNotice(5);
        scheduleRender('native-replaced');
        return;
      }

      const mountRowGone = !document.getElementById(MOUNT_ROW_ID);
      const panelGone    = !document.getElementById(PANEL_ID);

      // Nothing changed that concerns us — panel and native section both present
      if (!mountRowGone && !panelGone && _nativeEl && document.contains(_nativeEl)) return;

      if (mountRowGone) scheduleNotice(5);

      // Panel is gone — check if GSC's chart SVG has already (re)appeared.
      // This is the fast path: if the new chart is visible, mount immediately
      // instead of waiting for the _retryTimer. We must check this EVEN WHEN
      // the mount row is gone (previously the early `return` blocked this).
      if (panelGone) {
        const hasBigSvg = [...document.querySelectorAll('svg')].some(s => {
          if (s.closest('[data-gsc-wf-owned]')) return false;
          const r = s.getBoundingClientRect();
          return r.width >= 200 && r.height >= 50;
        });
        if (hasBigSvg) {
          clearTimeout(_debounceTimer);
          _debounceTimer = setTimeout(() => scheduleRender('chart-appeared'), 200);
          return;
        }
      }

      // SVG not visible yet (chart still loading) or mount row gone — schedule a retry
      if (mountRowGone || (panelGone && _filtered)) {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => scheduleRender('panel-removed'), 200);
      }
    });

    mo.observe(document.documentElement, { childList: true, subtree: true });
  })();

  // ── Bootstrap ─────────────────────────────────────────────────────────────────

  // content_script.js is guaranteed to load first (listed before us in manifest).
  window.dispatchEvent(new CustomEvent('gsc-filter-request-config'));

  console.debug('[GSC-WF] render_overlay.js loaded');
})();
