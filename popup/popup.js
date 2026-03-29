// popup.js

const COUNTRIES = [
  ['AR', 'Argentina'], ['AU', 'Australia'], ['AT', 'Austria'],
  ['BE', 'Belgium'], ['BR', 'Brazil'], ['CA', 'Canada'],
  ['CL', 'Chile'], ['CO', 'Colombia'], ['HR', 'Croatia'],
  ['CZ', 'Czechia'], ['DK', 'Denmark'], ['EC', 'Ecuador'],
  ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'],
  ['GR', 'Greece'], ['HU', 'Hungary'], ['IN', 'India'],
  ['IE', 'Ireland'], ['IT', 'Italy'], ['JP', 'Japan'],
  ['MX', 'Mexico'], ['NL', 'Netherlands'], ['NZ', 'New Zealand'],
  ['NO', 'Norway'], ['PL', 'Poland'], ['PT', 'Portugal'],
  ['RO', 'Romania'], ['ZA', 'South Africa'], ['ES', 'Spain'],
  ['SE', 'Sweden'], ['CH', 'Switzerland'], ['GB', 'United Kingdom'],
  ['US', 'United States'], ['UY', 'Uruguay'], ['VE', 'Venezuela'],
];

const $ = (id) => document.getElementById(id);

// ── Populate country selector ──────────────────────────────────────────────────
const sel = $('country');
COUNTRIES.sort((a, b) => a[1].localeCompare(b[1], 'en')).forEach(([code, name]) => {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = name;
  sel.appendChild(opt);
});

// ── Load saved config ──────────────────────────────────────────────────────────
async function loadConfig() {
  const cfg = await chrome.storage.local.get({
    enabled: true,
    hideSaturday: true,
    hideSunday: true,
    hideHolidays: false,
    country: 'ES',
    holidays: {},
  });

  $('enabled').checked       = cfg.enabled;
  $('hideSaturday').checked  = cfg.hideSaturday;
  $('hideSunday').checked    = cfg.hideSunday;
  $('hideHolidays').checked  = cfg.hideHolidays;
  sel.value                  = cfg.country;

  applyDisabledState(cfg.enabled);
  updateHolidayRowVisibility(cfg.hideHolidays);
  updateStatus(cfg);
}

// ── Persist any change ─────────────────────────────────────────────────────────
async function saveConfig() {
  const cfg = {
    enabled:      $('enabled').checked,
    hideSaturday: $('hideSaturday').checked,
    hideSunday:   $('hideSunday').checked,
    hideHolidays: $('hideHolidays').checked,
    country:      sel.value,
  };
  await chrome.storage.local.set(cfg);

  applyDisabledState(cfg.enabled);
  updateHolidayRowVisibility(cfg.hideHolidays);

  const full = await chrome.storage.local.get({ holidays: {} });
  updateStatus({ ...cfg, holidays: full.holidays });
}

function applyDisabledState(enabled) {
  document.body.classList.toggle('off', !enabled);
}

function updateHolidayRowVisibility(show) {
  $('country-row').style.display = show ? 'flex' : 'none';
}

function updateStatus(cfg) {
  const el = $('status');
  if (!cfg.enabled) {
    el.className = '';
    el.textContent = 'Filter disabled';
    return;
  }
  const parts = [];
  if (cfg.hideSaturday) parts.push('Saturdays');
  if (cfg.hideSunday)   parts.push('Sundays');
  if (cfg.hideHolidays) {
    const list = (cfg.holidays || {})[cfg.country] || [];
    parts.push(`holidays (${list.length} loaded)`);
  }
  el.className = parts.length ? 'ok' : '';
  el.textContent = parts.length
    ? `Hiding: ${parts.join(', ')}`
    : 'No active filters';
}

// ── Fetch holidays via background service worker ───────────────────────────────
$('fetch-btn').addEventListener('click', async () => {
  const btn = $('fetch-btn');
  const status = $('status');
  const country = sel.value;

  btn.disabled = true;
  btn.textContent = '…';
  status.className = '';
  status.textContent = `Fetching holidays for ${country}…`;

  try {
    const res = await chrome.runtime.sendMessage({ type: 'fetchHolidays', country });
    if (res.ok) {
      status.className = 'ok';
      status.textContent = `${res.dates.length} holidays loaded for ${country}`;
    } else {
      throw new Error(res.error);
    }
  } catch (e) {
    status.className = 'err';
    status.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
});

// ── Wire up all inputs ─────────────────────────────────────────────────────────
['enabled', 'hideSaturday', 'hideSunday', 'hideHolidays'].forEach((id) => {
  $(id).addEventListener('change', saveConfig);
});
sel.addEventListener('change', saveConfig);

// ── Init ───────────────────────────────────────────────────────────────────────
loadConfig();
