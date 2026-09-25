import {createPublicClient,http} from 'viem';
import {getActiveNetwork,getNetwork,getRpcUrls} from '../config/networks.js';
const clients=new Map();
export const buildTransport=net=>http(getRpcUrls(net)[0],{batch:false,retryCount:0,timeout:20000});
export function getPublicClient(id){const net=id?getNetwork(id):getActiveNetwork();const url=getRpcUrls(net)[0];
 const key=net.chainId+':'+url;if(!clients.has(key))clients.set(key,createPublicClient({chain:net.viemChain,transport:buildTransport(net)}));return clients.get(key);}
export function resetPublicClient(){clients.clear();}
export const getActiveChain=()=>getActiveNetwork().viemChain;
export const publicClient=new Proxy({}, {get(_target,property){const client=getPublicClient(),value=client[property];return typeof value==='function'?value.bind(client):value;}});
