(() => {
  const storageKey = 'daisugi.theme';
  const root = document.documentElement;
  const normalize = value => value === 'dark' ? 'dark' : 'light';
  const valid = value => value === 'dark' || value === 'light';
  const domain = globalThis.DAISUGI_SITE?.themeCookieDomain;
  const shared = domain && (location.hostname === domain || location.hostname.endsWith('.' + domain));

  function readCookie() {
    if (!shared) return null;
    try {
      const value = document.cookie.split('; ').find(item => item.startsWith(storageKey + '='))?.slice(storageKey.length + 1);
      return valid(value) ? value : null;
    } catch { return null; }
  }
  function readStorage() {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  }
  function saveStorage(theme) {
    try { localStorage.setItem(storageKey, theme); } catch {}
  }
  function saveCookie(theme) {
    if (!shared) return;
    try {
      document.cookie = storageKey + '=' + theme + '; Domain=' + domain +
        '; Path=/; Max-Age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch {}
  }
  function syncControl() {
    const button = document.getElementById('themeToggle');
    if (!button) return;
    const dark = root.dataset.theme === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    document.getElementById('themeLabel').textContent = dark ? 'Dark' : 'Light';
  }
  function applyTheme(value) {
    const theme = normalize(value);
    root.dataset.theme = theme;
    const color = document.querySelector('meta[name="theme-color"]');
    if (color) color.content = theme === 'dark' ? '#111214' : '#ffffff';
    syncControl();
  }
  // Loaded before CSS: preserve the chosen theme while navigating between hosts.
  const cookie = readCookie(), stored = readStorage();
  const saved = cookie || (valid(stored) ? stored : 'light');
  applyTheme(saved);
  if (cookie) saveStorage(cookie);
  else if (valid(stored)) saveCookie(stored);

  function synchronize() {
    const theme = readCookie() || readStorage();
    if (valid(theme)) { applyTheme(theme); saveStorage(theme); }
  }
  function initialize() {
    syncControl();
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(theme); saveStorage(theme); saveCookie(theme);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once:true});
  else initialize();
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) applyTheme(readCookie() || event.newValue);
  });
  window.addEventListener('pageshow', synchronize);
  window.addEventListener('focus', synchronize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) synchronize(); });
})();
