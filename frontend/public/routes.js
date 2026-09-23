const recordKinds = ['block', 'tx', 'op', 'address', 'hash'];
const faqAliases = {start:'getting-started', accounts:'wallet', research:'pq', network:'network', status:'network'};

export function parseRoute(url, explorerHost = false) {
  const legacy = url.hash.slice(1);
  let parts = (legacy && legacy !== 'main' ? legacy : url.pathname).replace(/^\/+|\/+$/g, '').split('/');
  const [first, second, third] = parts;
  if (!first || first === 'index.html') return {page:explorerHost ? 'explorer' : 'overview'};
  if (first === 'overview') return {page:'overview', topic:second || ''};
  if (first === 'faucet') return {page:'faucet'};
  if (first === 'docs') return {page:'overview', topic:faqAliases[second] || second || 'daisugi'};
  if (['wallet','settings'].includes(first)) return {page:'overview'};
  if (['blocks','operations','accounts','wallets'].includes(first)) return {page:'explorer'};
  if (recordKinds.includes(first)) return {page:'explorer', kind:first, id:second || ''};
  if (first === 'explorer') {
    return recordKinds.includes(second) ? {page:'explorer', kind:second, id:third || ''} : {page:'explorer'};
  }
  return null;
}

export function createSiteRouting(config = {}, currentHref = 'http://localhost/') {
  const current = new URL(currentHref);
  const siteOrigin = new URL(config.siteUrl || 'https://daisugi.fyi').origin;
  const explorerOrigin = new URL(config.explorerUrl || 'https://explorer.daisugi.fyi').origin;
  // Unknown hosts (localhost and review tunnels) remain self-contained previews.
  const split = siteOrigin !== explorerOrigin && [siteOrigin, explorerOrigin].includes(current.origin);
  const main = split ? siteOrigin : current.origin;
  const explorer = split ? explorerOrigin : current.origin;
  const isExplorerHost = split && current.origin === explorerOrigin;
  function href(route) {
    let path, origin = main;
    if (route.page === 'explorer') {
      origin = explorer;
      path = split ? '/' : '/explorer';
      if (route.kind) path = (split ? '' : '/explorer') + '/' + route.kind + '/' + encodeURIComponent(route.id || '');
    } else if (route.page === 'faucet') path = '/faucet';
    else path = route.topic ? '/overview/' + encodeURIComponent(route.topic) : '/';
    return new URL(path, origin).href;
  }
  return {
    split, isExplorerHost, href,
    resolve(value = current.href) { return parseRoute(new URL(value, current), isExplorerHost); },
    legacyHref(value) {
      const route = parseRoute(new URL(value, current), isExplorerHost);
      return route ? href(route) : value;
    }
  };
}

export const site = createSiteRouting(globalThis.DAISUGI_SITE, globalThis.location?.href);
