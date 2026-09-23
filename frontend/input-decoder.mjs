import {Interface} from 'ethers';

// This schema is also used by frontend/server.mjs to encode account execution.
// Matching it does not assert that a destination contract has verified source.
export const accountExecutionInput = new Interface(['function execute(address target,uint256 value,bytes data)']);
const isHex = value => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
function parameter(param, value, name = param.name) {
  if (param.baseType === 'array') return {name,type:param.type,children:Array.from(value,(item,index)=>parameter(param.arrayChildren,item,`[${index}]`))};
  if (param.baseType === 'tuple') return {name,type:'tuple',children:param.components.map((part,index)=>parameter(part,value[index],part.name || `[${index}]`))};
  return {name,type:param.type,value:typeof value === 'bigint' ? value.toString() : value};
}
export function decodeInputData(input, {abi = accountExecutionInput, abiSource = 'Smart-account execute ABI template', creation = false} = {}) {
  if (!isHex(input)) return {status:'unavailable',message:'Input bytes are unavailable.'};
  if (input === '0x') return {status:'empty',message:'This input contains no bytes to decode.'};
  if (creation) return {status:'unsupported',message:'Contract creation input requires the creation bytecode and constructor ABI. The original bytes remain available.'};
  if (input.length < 10) return {status:'unsupported',message:'This input has fewer than four bytes and no complete function selector.'};
  const selector=input.slice(0,10);
  try {
    const fragment=abi.getFunction(selector);
    if (!fragment) return {status:'unsupported',selector,message:'No matching ABI is available for this function selector. View the original bytes or UTF-8 text when applicable.'};
    const decoded=abi.decodeFunctionData(fragment,input);
    const parameters=fragment.inputs.map((param,index)=>parameter(param,decoded[index],param.name || `[${index}]`));
    const canonical=abi.encodeFunctionData(fragment,decoded);
    const canonicalPrefix=input.toLowerCase().startsWith(canonical.toLowerCase());
    return {
      status:'decoded',functionName:fragment.name,functionSignature:fragment.format('full').replace(/^function /,''),selector,abiSource,parameters,
      trailingData:canonicalPrefix ? '0x'+input.slice(canonical.length) : null,
      message:canonicalPrefix ? null : 'Parameters decoded, but the byte layout differs from canonical ABI encoding. Inspect the original input for the complete representation.'
    };
  } catch {
    return {status:'invalid',selector,message:'This selector matches a known ABI, but the input cannot be decoded with that ABI. The original bytes remain available.'};
  }
}
