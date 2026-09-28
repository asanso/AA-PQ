import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {createPortalApi, createFaucetLimiter} from "./portal-api.mjs";
import {isPortalPage, publicSiteConfig, siteConfigScript} from "./site-config.mjs";
import {createRpcProxy, RPC_BODY_LIMIT} from './rpc-policy.mjs';

const root = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.PORT || 3000);
const siteSettings = publicSiteConfig();
const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:18545";
const nativeFramesEnabled = process.env.NATIVE_FRAME_RPC_ENABLED === 'true';
const publicRpc = createRpcProxy({url:rpcUrl,nativeFramesEnabled});
const bundlerUrl = process.env.BUNDLER_URL || "http://127.0.0.1:4337";
const entryPoint = process.env.ENTRY_POINT || "";
const faucetKey = process.env.FAUCET_PRIVATE_KEY;
// Public RPC proxies may accept only one JSON-RPC request per HTTP call.
const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {batchMaxCount:1});
const faucetRpcUrl = process.env.FAUCET_RPC_URL || rpcUrl;
// Faucet submissions need a fresh pending nonce, including back-to-back requests.
const faucetProvider = new ethers.JsonRpcProvider(faucetRpcUrl, undefined, {batchMaxCount:1, cacheTimeout:-1});
const publicRpcUrl = process.env.PUBLIC_RPC_URL || null;
const publicBundlerUrl = process.env.PUBLIC_BUNDLER_URL || null;
const portal = createPortalApi({provider, bundlerUrl, entryPoint, rpcUrl, explorerUrl:process.env.EXPLORER_URL || 'http://127.0.0.1:3001'});
const claimFaucet = createFaucetLimiter();
const faucet = new ethers.Wallet(faucetKey, faucetProvider);
let pendingFaucetSubmission = Promise.resolve();
const factoryAddress = process.env.FACTORY_ADDRESS || '0x610178dA211FEF7D417bC0e6FeD39F05609AD788';
const factory = new ethers.Contract(factoryAddress, ['function getAddress(address,uint256) view returns(address)', 'function createAccount(address,uint256) returns(address)'], provider);
const packedType = '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';
const ep = new ethers.Contract(entryPoint, [`function getUserOpHash(${packedType}) view returns(bytes32)`, 'function getNonce(address,uint192) view returns(uint256)'], provider);

async function prepareWallet(req, res) {
  try {
    const {owner, salt = '0', recipient, amount} = await body(req);
    if (!ethers.isAddress(owner) || owner === ethers.ZeroAddress || !/^\d{1,30}$/.test(String(salt))) return json(res,400,{error:'Invalid owner or account number'});
    const sender = await factory['getAddress(address,uint256)'](owner, salt);
    const deployed = await provider.getCode(sender) !== '0x';
    const balance = ethers.formatEther(await provider.getBalance(sender));
    if(deployed && !recipient) return json(res,200,{sender,deployed,balance});
    if(recipient && (!deployed || !ethers.isAddress(recipient) || recipient === ethers.ZeroAddress || !/^\d{1,12}(\.\d{1,18})?$/.test(String(amount)) || ethers.parseEther(amount) <= 0n)) return json(res,400,{error:'Enter a valid recipient and positive ETH amount for a deployed wallet.'});
    const factoryData = factory.interface.encodeFunctionData('createAccount',[owner,salt]);
    const callData = new ethers.Interface(['function execute(address,uint256,bytes)']).encodeFunctionData('execute',[recipient || owner,recipient ? ethers.parseEther(amount) : 0,'0x']);
    const userOperation = {sender,nonce:ethers.toQuantity(await ep.getNonce(sender,0)),factory:factoryAddress,factoryData,callData,callGasLimit:'0x186a0',verificationGasLimit:'0xf4240',preVerificationGas:'0x186a0',maxFeePerGas:'0x3b9aca00',maxPriorityFeePerGas:'0x3b9aca00',signature:'0x'};
    if(deployed){delete userOperation.factory;delete userOperation.factoryData;}
    const packed = {...userOperation,initCode:deployed?'0x':ethers.concat([factoryAddress,factoryData]),accountGasLimits:ethers.concat([ethers.toBeHex(1000000,16),ethers.toBeHex(100000,16)]),gasFees:ethers.concat([ethers.toBeHex(1000000000,16),ethers.toBeHex(1000000000,16)]),paymasterAndData:'0x'};
    json(res,200,{sender,deployed,balance,userOperation,hash:await ep.getUserOpHash(packed)});
  }catch(error){json(res,500,{error:error.shortMessage || error.message});}
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req, limit = 2_000_000) {
  let data = "";
  let bytes = 0;
  for await (const chunk of req) {bytes += chunk.length; if (bytes <= limit) data += chunk;}
  if (bytes > limit) throw new Error("request too large");
  return data ? JSON.parse(data) : {};
}

async function rpcProxy(req,res) {
  let payload;
  try {
    payload = await body(req,RPC_BODY_LIMIT);
    json(res,200,await publicRpc(payload));
  } catch(error) {
    const oversized = error.message === 'request too large';
    const parseError = error instanceof SyntaxError;
    json(res,oversized ? 413 : parseError ? 400 : error.status || 502,{jsonrpc:'2.0',id:payload?.id ?? null,error:{code:oversized ? -32600 : parseError ? -32700 : error.rpcCode || -32000,message:error.message}});
  }
}

async function proxy(req, res, target) {
  try {
    const payload = await body(req);
    const allowed = ['eth_sendUserOperation','eth_estimateUserOperationGas','eth_getUserOperationReceipt','eth_getUserOperationByHash','eth_supportedEntryPoints','eth_chainId'];
    if (Array.isArray(payload) || !allowed.includes(payload.method)) return json(res,403,{error:'Method is not enabled on the bundler endpoint.'});
    const upstream = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  } catch (error) {
    json(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function faucetSend(req, res) {
  try {
    const payload = await body(req);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !ethers.isAddress(payload.address) || payload.address.toLowerCase() === ethers.ZeroAddress) {
      return json(res, 400, {error:'Enter a valid, non-zero Ethereum recipient address.'});
    }
    const requestedAmount = payload.amount === undefined ? '1' : payload.amount;
    if (typeof requestedAmount !== 'string' && typeof requestedAmount !== 'number') {
      return json(res, 400, {error:'The amount must be a decimal ETH value.'});
    }
    const amount = String(requestedAmount);
    if (!/^([0-9]{1,3})(\.[0-9]{1,18})?$/.test(amount)) {
      return json(res, 400, {error:'The amount must be greater than 0 and at most 10 ETH, with up to 18 decimal places.'});
    }
    const value = ethers.parseEther(amount);
    if (value <= 0n || value > ethers.parseEther('10')) {
      return json(res, 400, {error:'The amount must be greater than 0 and at most 10 ETH.'});
    }
    if (Number((await faucetProvider.getNetwork()).chainId) !== 1337) {
      return json(res, 503, {error:'The faucet is only available on Daisugi (chain 1337).'});
    }
    const retryAfter = claimFaucet(payload.address);
    if (retryAfter) {
      res.setHeader('retry-after', String(retryAfter));
      return json(res, 429, {error:`This address can request test ETH again in ${retryAfter} seconds.`, retryAfter});
    }
    // Serialize broadcasts from this signer. A failed request must not poison the queue.
    const submission = pendingFaucetSubmission.then(() =>
      faucet.sendTransaction({to:ethers.getAddress(payload.address), value}));
    pendingFaucetSubmission = submission.then(() => undefined, () => undefined);
    const tx = await submission;
    json(res, 200, {hash:tx.hash, from:faucet.address, amount});
  } catch (error) {
    json(res, 500, {error:error instanceof Error ? error.message : String(error)});
  }
}

async function config(res) {
  try {
    const network = await provider.getNetwork();
    json(res, 200, { chainId: Number(network.chainId), rpcUrl: "/rpc", bundlerUrl: "/bundler", entryPoint, faucet: faucet.address, networkName:'Daisugi', publicRpcUrl, publicBundlerUrl, faucetCooldownSeconds:60, nativeFrameSubmissionEnabled:nativeFramesEnabled });
  } catch (error) {
    json(res, 503, { error: error instanceof Error ? error.message : String(error) });
  }
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/site-config.js') {
    res.writeHead(200, {'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});
    return res.end(siteConfigScript(siteSettings));
  }
  if (req.method === 'GET' && (url.pathname === '/api/network' || url.pathname.startsWith('/api/explorer/'))) {
    try {
      const data = url.pathname === '/api/network' ? await portal.network() : await portal.explorer(url.pathname.slice('/api/explorer/'.length));
      return json(res, 200, data);
    } catch (error) {return json(res, 503, {error:error.shortMessage || error.message});}
  }
  if(req.method === 'POST' && url.pathname === '/api/aa/prepare') return prepareWallet(req,res);
  if(req.method === 'GET' && url.pathname === '/ethers.js') {
    res.writeHead(200,{'content-type':'text/javascript'});
    return res.end(await readFile(new URL('./node_modules/ethers/dist/ethers.min.js',import.meta.url)));
  }
  if (url.pathname === '/rpc') {
    res.setHeader('access-control-allow-origin','*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204,{'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'600'});
      return res.end();
    }
    if (req.method === 'POST') return rpcProxy(req,res);
  }
  if (req.method === "POST" && url.pathname === "/bundler") return proxy(req, res, bundlerUrl);
  if (req.method === "POST" && url.pathname === "/api/faucet") return faucetSend(req, res);
  if (req.method === "GET" && url.pathname === "/api/config") return config(res);
  if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });

  const relative = isPortalPage(url.pathname) ? "/index.html" : url.pathname;
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) return json(res, 404, { error: "not found" });
  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(content);
  } catch {
    json(res, 404, { error: "not found" });
  }
});

const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => console.log(`AA devnet frontend listening on http://${host}:${port}`));
