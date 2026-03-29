// content_script.js
// Runs in the extension's ISOLATED world at document_start.
// Responsibility: bridge chrome.storage config → injected.js (MAIN world) via CustomEvents.
// Note: injected.js is now loaded directly by Chrome as a MAIN world content script,
// so there is no need to inject it via a <script> tag.

(function () {
  async function pushConfig() {
    const stored = await chrome.storage.local.get({
      enabled: true,
      hideSaturday: true,
      hideSunday: true,
      hideHolidays: false,
      country: 'ES',
      holidays: {},
    });
    window.dispatchEvent(new CustomEvent('gsc-filter-config', { detail: stored }));
    console.debug('[GSC-WF] content_script: config pushed', stored.enabled);
  }

  // injected.js fires this when it needs the current config
  window.addEventListener('gsc-filter-request-config', pushConfig);

  // Push immediately so injected.js gets config as soon as both scripts are ready
  pushConfig();

  // Keep in sync when the user changes settings in the popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') pushConfig();
  });
})();
