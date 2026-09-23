export function isPortalPage(path) {
  return /^\/(?:overview(?:\/[a-z0-9-]+)?|faucet|explorer(?:\/(?:block\/\d{1,12}|(?:tx|op|hash)\/0x[0-9a-fA-F]{64}|address\/0x[0-9a-fA-F]{40}))?|block\/\d{1,12}|(?:tx|op|hash)\/0x[0-9a-fA-F]{64}|address\/0x[0-9a-fA-F]{40})?\/?$/.test(path);
}

function origin(value, fallback) {
  const url = new URL(value || fallback);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Public site URLs must be HTTP(S) origins without credentials, paths, queries or fragments.');
  }
  return url.origin;
}

export function publicSiteConfig(env = process.env) {
  const siteUrl = origin(env.PUBLIC_SITE_URL, 'https://daisugi.fyi');
  const explorerUrl = origin(env.PUBLIC_EXPLORER_URL, 'https://explorer.daisugi.fyi');
  const candidate = env.THEME_COOKIE_DOMAIN || 'daisugi.fyi';
  const contains = host => host === candidate || host.endsWith('.' + candidate);
  const themeCookieDomain = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(candidate) &&
    contains(new URL(siteUrl).hostname) && contains(new URL(explorerUrl).hostname) ? candidate : null;
  return {siteUrl, explorerUrl, themeCookieDomain};
}

export function siteConfigScript(config) {
  return 'globalThis.DAISUGI_SITE = Object.freeze(' + JSON.stringify(config).replace(/</g, '\\u003c') + ');\n';
}
