// Experimental clone account policy for the pinned EIP-8288 client.
export function createProfile(e) {
  const { keccak256, concat, toBeHex, zeroPadValue, getBytes, hexlify, toUtf8Bytes, getAddress } = e;
  const domain = keccak256(toUtf8Bytes('Daisugi.AggregatedFrameAccount.v2'));
  const word = value => zeroPadValue(toBeHex(BigInt(value)), 32);
  const selector = keccak256(toUtf8Bytes('createAccount(bytes32,bytes32,bytes32)')).slice(0, 10);
  const keyHash = (seed, root) => {
    for (const key of [seed, root]) if (!/^0x[0-9a-f]{32}0{32}$/i.test(key)) throw Error('Invalid SPHINCS public-key encoding.');
    return keccak256(concat(['0x' + root.slice(2, 34), '0x' + seed.slice(2, 34)]));
  };
  const cloneRuntime = (implementation, key) => concat(['0x363d3d373d3d3d363d73', getAddress(implementation),
    '0x5af43d82803e903d91602b57fd5bf3', key]);
  const initCode = (implementation, key) => concat(['0x3d604d80600a3d3981f3', cloneRuntime(implementation, key)]);

  function digest(tx, key) {
    getAddress(tx.sender);
    if (!/^0x[0-9a-f]{64}$/i.test(key)) throw Error('Invalid public-key hash.');
    const count = tx.frames.length, dependency = count - 3, verify = count - 2;
    if (count !== 3 && count !== 4) throw Error('Expected three frames or four frames with account creation.');
    if (tx.nonceKeys?.length !== 1 || BigInt(tx.nonceKeys[0]) !== 0n) throw Error('Nonce key zero is required.');
    for (const quantity of [tx.chainId, tx.nonce]) if (BigInt(quantity) < 0n || BigInt(quantity) >= 1n << 64n) throw Error('Quantity exceeds the client range.');
    if (BigInt(tx.maxBlobFee ?? 0) !== 0n || tx.signatures?.length || tx.recentRootReferences?.length || tx.blobVersionedHashes?.length)
      throw Error('Unsupported envelope fields.');
    for (const [index, mode, flags, length] of [[dependency, 4, 0, 96], [verify, 1, 3, 0]]) {
      const f = tx.frames[index];
      if (f.mode !== mode || f.flags !== flags || getBytes(f.data).length !== length || BigInt(f.value) !== 0n
          || getAddress(f.target ?? tx.sender) !== getAddress(tx.sender)) throw Error('Invalid authorization frame.');
    }
    if (count === 4) {
      const f = tx.frames[0];
      if (f.mode !== 0 || f.flags !== 0 || BigInt(f.value) !== 0n || getBytes(f.data).length !== 100 || f.data.slice(0, 10) !== selector)
        throw Error('Invalid account-creation frame.');
    }
    const dep = tx.frames[dependency], call = tx.frames.at(-1);
    if (BigInt(dep.executionGas) !== 3000n || BigInt(dep.stateGas) !== 0n || BigInt(tx.frames[verify].executionGas) < 50000n
        || call.mode !== 2 || call.flags !== 0 || getBytes(call.data).length > 4096) throw Error('Unsupported frame limits.');
    const words = [domain, word(tx.chainId), word(tx.sender), key, word(6), word(tx.nonce),
      keccak256(concat([word(1), word(0)])), word(tx.maxPriorityFee), word(tx.maxFee), word(0), word(count)];
    for (let i = 0; i < count; i++) {
      const f = tx.frames[i];
      getAddress(f.target ?? tx.sender);
      for (const gas of [f.executionGas, f.stateGas]) if (BigInt(gas) < 0n || BigInt(gas) >= 1n << 64n) throw Error('Invalid frame gas.');
      const data = i === dependency ? concat([word(16), word(0), key]) : f.data;
      words.push(...[f.target ?? tx.sender, f.executionGas, f.mode, f.flags, getBytes(f.data).length, f.value, f.stateGas].map(word), keccak256(data));
    }
    return keccak256(concat(words));
  }

  function implementationRuntime() {
    const code = [], labels = new Map(), jumps = [];
    const op = (...bytes) => code.push(...bytes);
    const push = value => {
      const bytes = getBytes(typeof value === 'string' && value.startsWith('0x') ? value : toBeHex(value));
      if (bytes.length < 1 || bytes.length > 32) throw Error('Invalid PUSH width.');
      op(0x5f + bytes.length, ...bytes);
    };
    const jump = name => { op(0x61, 0, 0); jumps.push([code.length - 2, name]); op(0x57); };
    const label = name => { labels.set(name, code.length); op(0x5b); };
    const requireTrue = () => { op(0x15); jump('reject'); };
    const equal = value => { push(value); op(0x14); requireTrue(); };
    const tx = field => { push(field); op(0xb0); };
    const frame = (index, field) => { push(field); push(index); op(0xb3); };
    const key = () => { push(2048); op(0x51); };
    const load = (index, offset) => { push(index); push(offset); op(0xb1); };

    op(0x33); push(0xaa); op(0x14); jump('authorize');
    op(0x33, 0x30, 0x14, 0x36); push(32); op(0x14, 0x16); jump('probe');
    op(0x00);
    label('probe'); push(2); tx(0x0a); op(0xb3); push(1); op(0x14); jump('read-reference'); op(0x00);
    label('read-reference'); push(0); push(0); op(0xb6); op(0x50, 0x00);

    label('authorize');
    op(0x36); equal(0);
    tx(2); op(0x30, 0x14); requireTrue();
    op(0x30, 0x3b); equal(77);
    push(32); push(45); push(2048); op(0x30, 0x3c);
    for (const field of [0x0b, 7, 5, 0x10]) { tx(field); equal(0); }
    tx(0x0e); equal(1);
    tx(9); push(3); op(0x14); jump('three');
    tx(9); equal(4); push(1); jump('four');

    for (const count of [3, 4]) {
      const dep = count - 3, verify = count - 2, body = count - 1;
      label(count === 3 ? 'three' : 'four');
      tx(0x0a); equal(verify);
      for (const [index, mode, flags, length] of [[dep, 4, 0, 96], [verify, 1, 3, 0]]) {
        frame(index, 0); op(0x30, 0x14); requireTrue();
        for (const [field, value] of [[2, mode], [3, flags], [4, length], [8, 0]]) { frame(index, field); equal(value); }
      }
      if (count === 4) {
        for (const [field, value] of [[2, 0], [3, 0], [4, 100], [8, 0]]) { frame(0, field); equal(value); }
        load(0, 0); push(224); op(0x1c); equal(selector);
      }
      frame(dep, 1); equal(3000); frame(dep, 9); equal(0);
      frame(body, 2); equal(2); frame(body, 3); equal(0);
      push(4096); frame(body, 4); op(0x11, 0x15); requireTrue();
      load(dep, 0); equal(16); load(dep, 64); key(); op(0x14); requireTrue();
      push(49999); frame(verify, 1); op(0x11); requireTrue();
      push(0); push(0); push(32); push(32); op(0x30); push(2000); op(0xfa, 0x15); requireTrue();
      let offset = 0;
      const store = () => { push(offset); op(0x52); offset += 32; };
      push(domain); store(); op(0x46); store(); op(0x30); store(); key(); store();
      for (const field of [0, 1, 0x0f, 3, 4, 5, 9]) { tx(field); store(); }
      for (let index = 0; index < count; index++) {
        for (const field of [0, 1, 2, 3, 4, 8, 9]) { frame(index, field); store(); }
        if (index === dep) {
          push(16); push(3072); op(0x52); push(0); push(3104); op(0x52); key(); push(3136); op(0x52);
          push(96); push(3072); op(0x20);
        } else {
          push(index); frame(index, 4); push(0); push(4096); op(0xb2);
          frame(index, 4); push(4096); op(0x20);
        }
        store();
      }
      push(offset); push(0); op(0x20); load(dep, 32); op(0x14); requireTrue();
      push(3); push(0); push(0); op(0xaa);
    }
    label('reject'); push(0); push(0); op(0xfd);
    for (const [position, name] of jumps) {
      const address = labels.get(name);
      if (address === undefined || address > 65535) throw Error('Unresolved jump.');
      code[position] = address >> 8; code[position + 1] = address & 255;
    }
    return hexlify(new Uint8Array(code));
  }
  return { domain, word, keyHash, cloneRuntime, initCode, digest, implementationRuntime };
}
