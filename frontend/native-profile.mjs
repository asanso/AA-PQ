import {keccak256} from 'ethers';
import {DAISUGI_GENESIS} from '../explorer/native-frame.mjs';

// This identifies an account implementation, not the validity or security
// strength of an individual signature. Never infer a profile from byte length.
const implementation = '0xfec328c1725f6ef48160053e14379865aec07568';
const implementationHash = '0xc8117616be026fd5b351f98470a35e46a1932816f04733e6d23ba51c8b93be30';
const verifier = '0xf505ad2cff58b84e145d637d99fae0617b5685be';
const verifierHash = '0x7ab53ba1ae0d906f2d144cb673fb481e04d58b22ec72a8a0ec37cc66079f3417';
const clone = new RegExp('^0x363d3d373d3d3d363d73'+implementation.slice(2)+'5af43d82803e903d91602b57fd5bf3[0-9a-f]{128}$','i');
export async function nativeAccountProfile(provider,transaction) {
  try {
    if (!transaction.from || transaction.blockNumber == null) return null;
    const [genesis,code] = await Promise.all([provider.getBlock(0),provider.getCode(transaction.from,transaction.blockNumber)]);
    if (genesis?.hash !== DAISUGI_GENESIS || !clone.test(code)) return null;
    const [implementationCode,verifierCode] = await Promise.all([
      provider.getCode(implementation,transaction.blockNumber),provider.getCode(verifier,transaction.blockNumber)
    ]);
    if (keccak256(implementationCode) !== implementationHash || keccak256(verifierCode) !== verifierHash) return null;
    return {name:'SPHINCS-G',implementation,verifier,checkedAtBlock:transaction.blockNumber,
      basis:'Sender clone, implementation and verifier bytecode match the pinned native account profile at the inclusion block.'};
  } catch {return null;}
}
