// background.js – service worker
// Fetches public holidays from Nager.Date and caches them in chrome.storage.local

const HOLIDAY_API = 'https://date.nager.at/api/v3/PublicHolidays';
const CACHE_KEY = 'holidays';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function fetchHolidays(country, year) {
  const res = await fetch(`${HOLIDAY_API}/${year}/${country}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.map((h) => h.date); // ["YYYY-MM-DD", ...]
}

async function getHolidays(country) {
  const { holidays = {}, holidaysFetchedAt = {} } = await chrome.storage.local.get([
    'holidays',
    'holidaysFetchedAt',
  ]);

  const now = Date.now();
  const years = [new Date().getFullYear() - 2, new Date().getFullYear() - 1, new Date().getFullYear()];
  let changed = false;

  for (const year of years) {
    const cacheKey = `${country}_${year}`;
    const fetchedAt = holidaysFetchedAt[cacheKey] || 0;

    if (now - fetchedAt < CACHE_TTL_MS && holidays[cacheKey]) continue;

    try {
      const dates = await fetchHolidays(country, year);
      holidays[cacheKey] = dates;
      holidaysFetchedAt[cacheKey] = now;
      changed = true;
    } catch (e) {
      console.warn(`GSC Weekend Filter: could not fetch holidays for ${country}/${year}`, e);
    }
  }

  if (changed) {
    await chrome.storage.local.set({ holidays, holidaysFetchedAt });
  }

  // Merge both years into a flat list and store under the country key
  // (this is what content_script sends as config.holidays)
  const merged = [
    ...(holidays[`${country}_${years[0]}`] || []),
    ...(holidays[`${country}_${years[1]}`] || []),
    ...(holidays[`${country}_${years[2]}`] || []),
  ];

  // Update the flat holidays map that content_script uses
  const stored = await chrome.storage.local.get({ holidays: {} });
  const flat = stored.holidays || {};
  flat[country] = merged;
  await chrome.storage.local.set({ holidays: flat });

  return merged;
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'fetchHolidays') {
    getHolidays(msg.country)
      .then((dates) => sendResponse({ ok: true, dates }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
});
