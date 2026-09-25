import { getAddress, keccak256 } from 'ethers';
import { accountAddress, accountRuntime, buildTransfer, signingHash, signedFrame, encodeFrame, frameRpc, receiptOutcome } from './protocol.js';
import config from './network.json';
import { getActiveNetwork, getRpcUrls } from '../config/networks.js';

export { config };
export async function rpc(method, params = []) {
  const response = await fetch(getRpcUrls(getActiveNetwork())[0], { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`RPC returned HTTP ${response.status}. Check the configured endpoint and its availability.`);
  const data = await response.json();
  if (data.error) { const error = Error(data.error.message); error.rpcCode = data.error.code; throw error; }
  if (!Object.hasOwn(data, 'result')) throw Error('Invalid RPC response.');
  return data.result;
}
export async function verifyNetwork() {
  const [chain, genesis, factoryCode, implementationCode, verifierCode] = await Promise.all([
    rpc('eth_chainId'), rpc('eth_getBlockByNumber', ['0x0', false]),
    rpc('eth_getCode', [config.factory, 'latest']), rpc('eth_getCode', [config.implementation, 'latest']), rpc('eth_getCode', [config.verifier, 'latest']),
  ]);
  if (BigInt(chain) !== 1337n || genesis?.hash !== config.genesisHash) throw Error('Unexpected network. Sending is disabled.');
  if (keccak256(factoryCode) !== config.factoryCodeHash || keccak256(implementationCode) !== config.implementationCodeHash || keccak256(verifierCode) !== config.verifierCodeHash)
    throw Error('Contract bytecode does not match this wallet build. Sending is disabled.');
}
export async function accountState(key) {
  const address = accountAddress(config, key.backupPkSeed, key.backupPkRoot);
  const [balance, nonce, code] = await Promise.all([
    rpc('eth_getBalance', [address, 'latest']), rpc('eth_getTransactionCount', [address, 'pending']), rpc('eth_getCode', [address, 'latest']),
  ]);
  const deployed = code !== '0x';
  if (deployed && code.toLowerCase() !== accountRuntime(config.implementation, key.backupPkSeed, key.backupPkRoot).toLowerCase())
    throw Error('Unexpected account bytecode.');
  return { address, balance: BigInt(balance), nonce: BigInt(nonce), deployed };
}

export async function quoteCall(address, recipient, value=0n, data='0x') {
  recipient=getAddress(recipient);
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(data) || BigInt(value)<0n) throw Error('Invalid transaction data.');
  if (data.length > 90002) throw Error('Calldata exceeds the development RPC request limit.');
  const [block, balance, code] = await Promise.all([
    rpc('eth_getBlockByNumber',['latest',false]),rpc('eth_getBalance',[address,'latest']),rpc('eth_getCode',[address,'latest'])]);
  const priorityFee=1000000000n, maxFee=BigInt(block.baseFeePerGas)*2n+priorityFee;
  if(maxFee>3000000000n) throw Error('Network fees exceed the configured development limit.');
  // Estimate the destination call, then budget execution and state gas separately.
  // The complete signed frame transaction is simulated again before broadcast.
  const estimated=BigInt(await rpc('eth_estimateGas',[{from:address,to:recipient,value:'0x'+BigInt(value).toString(16),data}]));
  const callGas=estimated*3n/2n>250000n?estimated*3n/2n:250000n;
  if(callGas>5000000n) throw Error('Contract call exceeds the supported gas budget.');
  const reserveGas=1500000n+callGas*2n+BigInt((data.length-2)/2)*40n;
  return {maxFee,priorityFee,callGas,feeReserve:reserveGas*maxFee,reserveGas,balance:BigInt(balance),deployed:code!=='0x'};
}
export async function prepareCall(key, recipient, value, data='0x', reviewed) {
  await verifyNetwork();
  const account=await accountState(key);
  const quote=await quoteCall(account.address,recipient,value,data);
  if(reviewed && (quote.feeReserve>BigInt(reviewed.feeReserve) || Date.now()-reviewed.at>240000))
    throw Error('The reviewed fee changed or expired. Review this transaction again.');
  if(account.balance<BigInt(value)+quote.feeReserve) throw Error('Insufficient test ETH for the transfer and maximum network fee.');
  const payload=buildTransfer({config,pkSeed:key.backupPkSeed,pkRoot:key.backupPkRoot,sender:account.address,
    recipient,nonce:account.nonce,value,deployed:account.deployed,maxFee:quote.maxFee,priorityFee:quote.priorityFee,data,callGas:quote.callGas});
  return {...quote,account,key,recipient,value:BigInt(value),data,payload,digest:signingHash(payload),preparedAt:Date.now()};
}
export async function submitCall(quote,signed,persist,assertContext=()=>{}) {
  assertContext();
  if(Date.now()-quote.preparedAt>240000) throw Error('Transaction preparation expired.');
  if(signed.backupPkSeed!==quote.key.backupPkSeed || signed.backupPkRoot!==quote.key.backupPkRoot) throw Error('Signing key changed.');
  await verifyNetwork();
  const current=await accountState(quote.key);
  if(current.nonce!==quote.account.nonce || current.deployed!==quote.account.deployed) throw Error('Account state changed. Review again.');
  if(current.balance<quote.value+quote.feeReserve) throw Error('Insufficient balance.');
  const payload=signedFrame(quote.payload,signed.signature);
  await rpc('eth_call',[frameRpc(payload),'latest']);
  const raw=encodeFrame(payload), hash=keccak256(raw);
  const record={hash,sender:current.address,recipient:quote.recipient,value:quote.value.toString(),
    nonce:current.nonce.toString(),frameCount:payload[3].length,status:'pending',createdAt:Date.now()};
  await persist(record); // Durable journal must succeed before any broadcast.
  assertContext();
  try {
    const returned=await rpc('eth_sendRawTransaction',[raw]);
    if(returned?.toLowerCase()!==hash.toLowerCase()) throw Error('Unexpected RPC transaction hash.');
  } catch(error) {
    record.message='Submission outcome is uncertain. Check the transaction hash before sending again.';
    await persist(record);
  }
  return record;
}
export async function refreshRecord(record) {
  const outcome=receiptOutcome(await rpc('eth_getTransactionReceipt',[record.hash]),record.hash,record.frameCount);
  return outcome.status==='pending'?record:{...record,status:outcome.status,message:outcome.message,receipt:outcome.receipt};
}
