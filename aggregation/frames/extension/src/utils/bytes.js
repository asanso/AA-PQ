export function hex2bytes(h) {
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.length & 1) h = "0" + h;
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  return b;
}

export function bytes2hex(b) {
  let o = "";
  for (let i = 0; i < b.length; i++) {
    const h = b[i].toString(16);
    o += h.length < 2 ? "0" + h : h;
  }
  return o;
}

export function concatBytes() {
  let total = 0;
  for (let i = 0; i < arguments.length; i++) total += arguments[i].length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < arguments.length; i++) {
    out.set(arguments[i], offset);
    offset += arguments[i].length;
  }
  return out;
}

export function u32BE(n) {
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

export function uint128BEHex(n) {
  let bn = BigInt(n);
  if (bn < 0n) bn = 0n;
  const max = (1n << 128n) - 1n;
  if (bn > max) bn = max;
  return bn.toString(16).padStart(32, "0");
}

export function packTwoUint128(hi, lo) {
  return "0x" + uint128BEHex(hi) + uint128BEHex(lo);
}
