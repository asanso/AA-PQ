// Keep the injected protocol adapter limited to ABI and encoding utilities.
export {
  Interface, ZeroHash, concat, encodeRlp, getAddress, getBytes,
  getCreate2Address, hexlify, keccak256, toBeHex, toQuantity,
  toUtf8Bytes, zeroPadValue,
} from 'ethers';
