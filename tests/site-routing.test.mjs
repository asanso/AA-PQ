import test from 'node:test';
import assert from 'node:assert/strict';
import {createSiteRouting, externalExplorerHref} from '../frontend/public/routes.js';
import {isPortalPage, publicSiteConfig, siteConfigScript} from '../frontend/site-config.mjs';
import {createPortalProxy} from '../explorer/portal-proxy.mjs';

const config={siteUrl:'https://daisugi.fyi',explorerUrl:'https://explorer.daisugi.fyi'};
const tx='0x'+'1'.repeat(64);

test('production roots and navigation remain on their intended hosts',()=>{
  const main=createSiteRouting(config,'https://daisugi.fyi/');
  const explorer=createSiteRouting(config,'https://explorer.daisugi.fyi/');
  assert.equal(main.resolve().page,'overview');
  assert.equal(explorer.resolve().page,'explorer');
  assert.equal(main.href({page:'explorer'}),'https://explorer.daisugi.fyi/');
  assert.equal(explorer.href({page:'faucet'}),'https://daisugi.fyi/faucet');
  assert.equal(explorer.href({page:'overview',topic:'wallet'}),'https://daisugi.fyi/overview/wallet');
  assert.equal(main.href({page:'explorer',kind:'tx',id:tx}),'https://explorer.daisugi.fyi/tx/'+tx);
  assert.equal(explorer.href(explorer.resolve('https://explorer.daisugi.fyi/faucet')),'https://daisugi.fyi/faucet');
});

test('localhost and review tunnels never navigate to production',()=>{
  for(const origin of ['http://localhost:3003','http://127.0.0.1:3003','https://review.trycloudflare.com']){
    const routing=createSiteRouting(config,origin+'/');
    assert.equal(routing.split,false);
    for(const route of [{page:'overview'},{page:'faucet'},{page:'explorer'},{page:'explorer',kind:'op',id:tx}])
      assert.equal(new URL(routing.href(route)).origin,origin);
    assert.equal(routing.href({page:'explorer'}),origin+'/explorer');
  }
});

test('old portal and explorer bookmarks keep their target records',()=>{
  const routing=createSiteRouting(config,'https://explorer.daisugi.fyi/');
  for(const path of ['/#explorer/tx/'+tx,'/#tx/'+tx,'/tx/'+tx])
    assert.deepEqual(routing.resolve(new URL(path,'https://explorer.daisugi.fyi').href),{page:'explorer',kind:'tx',id:tx});
  assert.deepEqual(routing.resolve('https://explorer.daisugi.fyi/#docs/accounts'),{page:'overview',topic:'wallet'});
  assert.equal(routing.resolve('https://explorer.daisugi.fyi/portal.js'),null);
  assert.equal(routing.resolve('https://explorer.daisugi.fyi/api/overview'),null);
});

test('clean page routes do not turn missing assets and API errors into HTML',()=>{
  for(const path of ['/','/overview','/overview/wallet','/faucet','/network','/explorer','/tx/'+tx,'/explorer/op/'+tx,'/block/123'])
    assert.equal(isPortalPage(path),true,path);
  for(const path of ['/api/no-such-route','/.env','/missing.js','/unknown','//example.com','/tx/not-a-hash'])
    assert.equal(isPortalPage(path),false,path);
});

test('the network page stays on the main host',()=>{
  const main=createSiteRouting(config,'https://daisugi.fyi/');
  const explorer=createSiteRouting(config,'https://explorer.daisugi.fyi/');
  assert.deepEqual(main.resolve('https://daisugi.fyi/network'),{page:'network'});
  assert.equal(explorer.href({page:'network'}),'https://daisugi.fyi/network');
  assert.equal(createSiteRouting(config,'http://localhost:3003/').href({page:'network'}),'http://localhost:3003/network');
});

test('the site config selects the page variant from the network format',()=>{
  const run=format=>{
    const root={dataset:{}};
    new Function('globalThis','document',siteConfigScript({chainId:1,eip8288Format:format}))({},{documentElement:root});
    return root.dataset.network;
  };
  assert.equal(run('eip8288-lean'),'lean');
  assert.equal(run('daisugi-v1'),'legacy');
  assert.equal(run(undefined),'legacy');
  assert.match(siteConfigScript({note:'</script>'}),/\\u003c\/script>/);
});

test('public config accepts origins only and scopes theme cookie to both hosts',()=>{
  assert.equal(publicSiteConfig({}).themeCookieDomain,'daisugi.fyi');
  assert.equal(publicSiteConfig({PUBLIC_SITE_URL:'https://example.com'}).themeCookieDomain,null);
  assert.throws(()=>publicSiteConfig({PUBLIC_SITE_URL:'https://user:password@daisugi.fyi'}));
  assert.throws(()=>publicSiteConfig({PUBLIC_EXPLORER_URL:'https://explorer.daisugi.fyi/api'}));
});

function responseMock(){
  return {writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
}
test('explorer serves shared UI/API while native indexing routes remain independent',async()=>{
  const calls=[];
  const proxy=createPortalProxy({origin:'http://127.0.0.1:3000',fetchImpl:async(url)=>{
    calls.push(url.href);return new Response('shared content',{headers:{'content-type':'text/html'}});
  }});
  for(const path of ['/','/tx/'+tx,'/portal.css','/timestamp.js','/native-frame-view.js','/site-config.js','/api/explorer/overview']){
    const res=responseMock();
    assert.equal(await proxy({method:'GET'},res,path),true);
    assert.equal(res.status,200);
  }
  const count=calls.length;
  for(const path of ['/api/overview','/api/tx/'+tx,'/.env','/api/faucet','//example.com'])
    assert.equal(await proxy({method:'GET'},responseMock(),path),false);
  assert.equal(await proxy({method:'POST'},responseMock(),'/api/faucet'),false);
  assert.equal(calls.length,count);
  assert(calls.every(url=>new URL(url).origin==='http://127.0.0.1:3000'));
});

test('disabled or unavailable shared portal has predictable behavior',async()=>{
  assert.equal(await createPortalProxy()({method:'GET'},responseMock(),'/'),false);
  const proxy=createPortalProxy({origin:'http://127.0.0.1:3000',fetchImpl:async()=>{throw new Error('offline');}});
  const res=responseMock();
  assert.equal(await proxy({method:'GET'},res,'/'),true);
  assert.equal(res.status,502);
  assert.match(res.body,/unavailable/);
});

test('a profile with an external explorer keeps this site\'s explorer URLs, which lead to the matching external pages',()=>{
  const dora='https://dora.daisugi-devnet-0.ethpandaops.io';
  const address='0x'+'2'.repeat(40);
  for(const origin of ['https://daisugi.fyi','https://review.trycloudflare.com']){
    const routing=createSiteRouting({...config,externalExplorerUrl:dora},origin+'/');
    const explorer=routing.split?'https://explorer.daisugi.fyi':origin+'/explorer';
    // Explorer links stay on this site: the explorer host, or /explorer on a preview host.
    assert.equal(routing.href({page:'explorer'}),routing.split?explorer+'/':explorer);
    assert.equal(routing.href({page:'explorer',kind:'tx',id:tx}),explorer+'/tx/'+tx);
    // Those URLs lead to the matching Dora page.
    assert.equal(routing.externalHref({page:'explorer'}),dora+'/');
    assert.equal(routing.externalHref({page:'explorer',kind:'tx',id:tx}),dora+'/tx/'+tx);
    assert.equal(routing.externalHref({page:'explorer',kind:'address',id:address}),dora+'/address/'+address);
    assert.equal(routing.externalHref({page:'explorer',kind:'block',id:'41927'}),dora+'/block/41927');
    assert.equal(routing.externalHref({page:'explorer',kind:'hash',id:tx}),dora+'/search?q='+tx);
    // Old bookmarks of this site's explorer land on the same record.
    assert.equal(routing.externalHref(routing.resolve(origin+'/explorer/tx/'+tx)),dora+'/tx/'+tx);
    assert.equal(new URL(routing.href({page:'faucet'})).origin,origin);
  }
  // On the explorer host, the root and record paths lead to the same Dora pages.
  const host=createSiteRouting({...config,externalExplorerUrl:dora},'https://explorer.daisugi.fyi/tx/'+tx);
  assert.equal(host.externalHref(host.resolve()),dora+'/tx/'+tx);
  assert.equal(host.externalHref(host.resolve('https://explorer.daisugi.fyi/')),dora+'/');
  // The external page uses the profile URL's origin only.
  assert.equal(externalExplorerHref(dora+'/ignored/path',{page:'explorer',kind:'block',id:'7'}),dora+'/block/7');
  // Without the profile field there is no external explorer.
  assert.equal(createSiteRouting(config,'https://daisugi.fyi/').externalHref,null);
});

test('the explorer service passes on a redirect to the external explorer and no other',async()=>{
  const dora='https://dora.daisugi-devnet-0.ethpandaops.io';
  const redirecting=location=>async()=>new Response(null,{status:302,headers:{location}});
  const passed=createPortalProxy({origin:'http://127.0.0.1:3000',externalExplorerUrl:dora,fetchImpl:redirecting(dora+'/tx/'+tx)});
  const res=responseMock();
  assert.equal(await passed({method:'GET'},res,'/tx/'+tx),true);
  assert.deepEqual([res.status,res.headers.location],[302,dora+'/tx/'+tx]);
  for(const [externalExplorerUrl,location] of [[dora,'https://example.com/tx/'+tx],[null,dora+'/tx/'+tx]]){
    const blocked=createPortalProxy({origin:'http://127.0.0.1:3000',externalExplorerUrl,fetchImpl:redirecting(location)});
    const other=responseMock();
    assert.equal(await blocked({method:'GET'},other,'/tx/'+tx),true);
    assert.equal(other.status,502);
  }
});
