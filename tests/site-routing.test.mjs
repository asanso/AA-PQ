import test from 'node:test';
import assert from 'node:assert/strict';
import {createSiteRouting} from '../frontend/public/routes.js';
import {isPortalPage, publicSiteConfig} from '../frontend/site-config.mjs';
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
  for(const path of ['/','/overview','/overview/wallet','/faucet','/explorer','/tx/'+tx,'/explorer/op/'+tx,'/block/123'])
    assert.equal(isPortalPage(path),true,path);
  for(const path of ['/api/no-such-route','/.env','/missing.js','/unknown','//example.com','/tx/not-a-hash'])
    assert.equal(isPortalPage(path),false,path);
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
