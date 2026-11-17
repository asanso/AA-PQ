import {readFileSync} from 'node:fs';

// The network the portal, RPC gateway and explorer serve. Defaults are the current Daisugi network; a complete
// profile file named by DAISUGI_NETWORK_PROFILE selects another one. A file never inherits defaults, so a new
// network cannot silently mix in the current network's genesis or contracts.
export const DAISUGI_PROFILE = Object.freeze({
  name:'Daisugi',
  chainId:1337,
  genesisHash:'0x3f08ccf3cbc9a60e7a328a3260f2fccf1ee2e8e36e647f030f77b8122cd83e55',
  frameActivationBlock:519324,
  entryPoint:'0x433709009B8330FDa32311DF1C2AFA402eD8D009',
  nativeFactory:'0xd07fcbdca6dea83b523faf95386cea236e32d989',
  nativeImplementation:'0xfec328c1725f6ef48160053e14379865aec07568',
  nativeImplementationCodeHash:'0xc8117616be026fd5b351f98470a35e46a1932816f04733e6d23ba51c8b93be30',
  nativeVerifier:'0xf505ad2cff58b84e145d637d99fae0617b5685be',
  nativeVerifierCodeHash:'0x7ab53ba1ae0d906f2d144cb673fb481e04d58b22ec72a8a0ec37cc66079f3417',
  eip8288Format:'daisugi-v1',
});

const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const fields = {
  name:value => typeof value === 'string' && /^[A-Za-z0-9 -]{1,40}$/.test(value),
  chainId:value => Number.isSafeInteger(value) && value > 0,
  genesisHash:hash,
  frameActivationBlock:value => Number.isSafeInteger(value) && value >= 0,
  entryPoint:address, nativeFactory:address, nativeImplementation:address, nativeVerifier:address,
  nativeImplementationCodeHash:hash, nativeVerifierCodeHash:hash,
  // daisugi-v1: the current chain's wrapper and header formats; eip8288-lean: upstream Nethermind feature/eip8288-lean.
  eip8288Format:value => ['daisugi-v1', 'eip8288-lean'].includes(value),
};

export function parseNetworkProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Error('A network profile must be a JSON object.');
  const unknown = Object.keys(profile).filter(key => !Object.hasOwn(fields, key));
  if (unknown.length) throw Error('Unknown network profile fields: ' + unknown.join(', '));
  for (const [key, valid] of Object.entries(fields)) if (!valid(profile[key])) throw Error('Invalid or missing network profile field: ' + key);
  return Object.freeze({...profile});
}

export function loadNetworkProfile(env = process.env) {
  const file = env.DAISUGI_NETWORK_PROFILE;
  const profile = file ? parseNetworkProfile(JSON.parse(readFileSync(file, 'utf8'))) : DAISUGI_PROFILE;
  // ENTRY_POINT predates the profile; a value left over from another network must not mix into this one.
  if (env.ENTRY_POINT && env.ENTRY_POINT.toLowerCase() !== profile.entryPoint.toLowerCase())
    throw Error('ENTRY_POINT does not match the network profile entryPoint.');
  return profile;
}

export const NETWORK = loadNetworkProfile();
// JSON-RPC quantity (0x539) and RLP integer bytes (0x0539) of the chain ID.
export const chainIdHex = '0x' + NETWORK.chainId.toString(16);
export const chainIdRlp = '0x' + NETWORK.chainId.toString(16).padStart(Math.ceil(NETWORK.chainId.toString(16).length / 2) * 2, '0');
