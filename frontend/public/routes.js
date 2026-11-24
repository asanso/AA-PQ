const recordKinds = ['block', 'tx', 'op', 'address', 'hash'];
const faqAliases = {start:'getting-started', accounts:'wallet', research:'pq', network:'network', status:'network'};

export function parseRoute(url, explorerHost = false) {
  const legacy = url.hash.slice(1);
  let parts = (legacy && legacy !== 'main' ? legacy : url.pathname).replace(/^\/+|\/+$/g, '').split('/');
  const [first, second, third] = parts;
  if (!first || first === 'index.html') return {page:explorerHost ? 'explorer' : 'overview'};
  if (first === 'overview') return {page:'overview', topic:second || ''};
  if (first === 'faucet') return {page:'faucet'};
  if (first === 'network') return {page:'network'};
  if (first === 'docs') return {page:'overview', topic:faqAliases[second] || second || 'daisugi'};
  if (['wallet','settings'].includes(first)) return {page:'overview'};
  if (['blocks','operations','accounts','wallets'].includes(first)) return {page:'explorer'};
  if (recordKinds.includes(first)) return {page:'explorer', kind:first, id:second || ''};
  if (first === 'explorer') {
    return recordKinds.includes(second) ? {page:'explorer', kind:second, id:third || ''} : {page:'explorer'};
  }
  return null;
}

// The page of the network operators' explorer (Dora) that matches an explorer route of this site: /tx/, /address/,
// /block/, a search for other identifiers, and the home page for the explorer root.
export function externalExplorerHref(externalUrl, route) {
  const id = encodeURIComponent(route.id || '');
  const path = !route.kind ? '/' : route.kind === 'tx' ? '/tx/' + id : route.kind === 'address' ? '/address/' + id
    : route.kind === 'block' ? '/block/' + id : '/search?q=' + id;
  return new URL(path, new URL(externalUrl).origin).href;
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
  // When the profile names the network operators' explorer (Dora), links keep this site's explorer URLs, and those
  // URLs redirect to the matching Dora page (externalHref).
  const external = config.externalExplorerUrl || null;
  function href(route) {
    let path, origin = main;
    if (route.page === 'explorer') {
      origin = explorer;
      path = split ? '/' : '/explorer';
      if (route.kind) path = (split ? '' : '/explorer') + '/' + route.kind + '/' + encodeURIComponent(route.id || '');
    } else if (route.page === 'faucet') path = '/faucet';
    else if (route.page === 'network') path = '/network';
    else path = route.topic ? '/overview/' + encodeURIComponent(route.topic) : '/';
    return new URL(path, origin).href;
  }
  return {
    split, isExplorerHost, href, externalHref:external ? route => externalExplorerHref(external, route) : null,
    resolve(value = current.href) { return parseRoute(new URL(value, current), isExplorerHost); },
    legacyHref(value) {
      const route = parseRoute(new URL(value, current), isExplorerHost);
      return route ? href(route) : value;
    }
  };
}

export const site = createSiteRouting(globalThis.DAISUGI_SITE, globalThis.location?.href);
// The network profile's chain ID and EntryPoint, served by /site-config.js.
export const chainId = globalThis.DAISUGI_SITE?.chainId;
export const entryPoint = globalThis.DAISUGI_SITE?.entryPoint;
// The network's native account contracts, shown on the Network page.
export const nativeContracts = Object.freeze({verifier:globalThis.DAISUGI_SITE?.nativeVerifier, factory:globalThis.DAISUGI_SITE?.nativeFactory,
  implementation:globalThis.DAISUGI_SITE?.nativeImplementation});
// True on eip8288-lean networks (no ERC-4337).
export const lean = globalThis.DAISUGI_SITE?.eip8288Format === 'eip8288-lean';
// The network operators' faucet, linked from the faucet page when the profile names one.
export const externalFaucetUrl = globalThis.DAISUGI_SITE?.externalFaucetUrl || null;
export const networkName = globalThis.DAISUGI_SITE?.networkName || 'Daisugi';
