// Experimental account-defined authorization; not a change to the EIP-8141 digest.
export function accountTools({ keccak256, concat, toBeHex, zeroPadValue, getBytes, toUtf8Bytes }) {
  const domain = keccak256(toUtf8Bytes('Daisugi.AggregatedFrameAccount.v1'));
  const word = value => zeroPadValue(toBeHex(BigInt(value)), 32);
  const emptyHash = keccak256('0x');
  const fields = [0, 1, 2, 3, 4, 8, 9];
  const frameWords = (frame, sender) => [frame.target ?? sender, frame.executionGas,
    frame.mode, frame.flags, getBytes(frame.data).length, frame.value, frame.stateGas].map(word);

  function digest(transaction, keyHash) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(transaction.sender)
        || transaction.frames.some(frame => frame.target !== null && !/^0x[0-9a-fA-F]{40}$/.test(frame.target))
        || !/^0x[0-9a-fA-F]{64}$/.test(keyHash)) throw Error('Invalid address or public-key hash');
    if (transaction.frames.length !== 3) throw Error('The authorization profile requires three frames');
    const keys = transaction.nonceKeys;
    if (!Array.isArray(keys) || keys.length !== 1 || BigInt(keys[0]) !== 0n) {
      throw Error('The prototype requires the keyed-nonce encoding with key zero');
    }
    if (BigInt(transaction.maxBlobFee ?? 0) !== 0n || transaction.blobVersionedHashes?.length
        || transaction.recentRootReferences?.length || transaction.signatures?.length) {
      throw Error('Blob data, recent-root references and envelope signatures are outside this profile');
    }
    for (const [index, mode, flags, length] of [[0, 4, 0, 96], [1, 1, 3, 0]]) {
      const frame = transaction.frames[index];
      if (frame.mode !== mode || frame.flags !== flags || getBytes(frame.data).length !== length
          || BigInt(frame.value) !== 0n || BigInt(frame.target ?? transaction.sender) !== BigInt(transaction.sender)) {
        throw Error('Unsupported dependency or VERIFY frame');
      }
    }
    const [dependency, , body] = transaction.frames;
    if (BigInt(dependency.executionGas) !== 3000n || BigInt(dependency.stateGas) !== 0n
        || BigInt(transaction.frames[1].executionGas) < 50000n
        || body.mode !== 2 || body.flags !== 0 || getBytes(body.data).length > 4096) {
      throw Error('Unsupported frame limits or SENDER frame');
    }
    const nonceKeysHash = keccak256(concat([word(keys.length), ...keys.map(word)]));
    const words = [domain, word(transaction.chainId), word(transaction.sender), keyHash,
      word(6), word(transaction.nonce), nonceKeysHash, word(transaction.maxPriorityFee),
      word(transaction.maxFee), word(transaction.maxBlobFee ?? 0)];
    for (let index = 0; index < 3; index++) {
      const frame = transaction.frames[index];
      const data = index === 0 ? concat([word(16), word(0), keyHash]) : frame.data;
      words.push(...frameWords(frame, transaction.sender), keccak256(data));
    }
    return keccak256(concat(words));
  }

  function runtime(keyHash) {
    const code = [], labels = new Map(), jumps = [];
    const op = (...bytes) => code.push(...bytes);
    const push = value => {
      const hex = typeof value === 'string' && value.startsWith('0x') ? value.slice(2) : BigInt(value).toString(16);
      const bytes = getBytes('0x' + (hex.length % 2 ? '0' : '') + hex);
      if (bytes.length > 32) throw Error('EVM word overflow');
      op(0x5f + bytes.length, ...bytes);
    };
    const jump = (label, conditional = true) => {
      op(0x61, 0, 0); jumps.push([code.length - 2, label]); op(conditional ? 0x57 : 0x56);
    };
    const label = name => { labels.set(name, code.length); op(0x5b); };
    const requireTrue = () => { op(0x15); jump('reject'); };
    const equal = expected => { push(expected); op(0x14); requireTrue(); };
    const tx = parameter => { push(parameter); op(0xb0); };
    const frame = (index, parameter) => { push(parameter); push(index); op(0xb3); };
    const load = offset => { push(0); push(offset); op(0xb1); };
    let offset = 0;
    const store = () => { push(offset); op(0x52); offset += 32; };

    op(0x33); push(0xaa); op(0x14); jump('verify');
    op(0x33, 0x30, 0x14, 0x36); push(32); op(0x14, 0x16); jump('reference-probe');
    op(0x00);
    label('reference-probe');
    tx(0x0a); push(1); op(0x14); jump('read-reference');
    op(0x00);
    label('read-reference');
    // The bounded self-call succeeds exactly when recent-root reference zero exists.
    push(0); push(0); op(0xb6); push(0); op(0x52); push(32); push(0); op(0xf3);

    label('verify');
    op(0x36); equal(0);
    tx(0x0a); equal(1);
    tx(0x02); op(0x30, 0x14); requireTrue();
    tx(0x09); equal(3);
    tx(0x0b); equal(0);
    tx(0x07); equal(0);
    tx(0x05); equal(0);
    tx(0x0e); equal(1);
    tx(0x10); equal(0);
    for (const [index, mode, flags, length] of [[0, 4, 0, 96], [1, 1, 3, 0]]) {
      frame(index, 0); op(0x30, 0x14); requireTrue();
      frame(index, 2); equal(mode);
      frame(index, 3); equal(flags);
      frame(index, 4); equal(length);
      frame(index, 8); equal(0);
    }
    frame(0, 1); equal(3000);
    frame(0, 9); equal(0);
    frame(2, 2); equal(2);
    frame(2, 3); equal(0);
    push(4096); frame(2, 4); op(0x11, 0x15); requireTrue();
    load(0); equal(16);
    load(64); equal(keyHash);
    // All work before this fixed self-call is bounded; GAS introspection is not pool-safe.
    push(49999); frame(1, 1); op(0x11); requireTrue();
    push(32); push(64); push(32); push(32); op(0x30); push(2000); op(0xfa, 0x15); requireTrue();

    push(domain); store();
    op(0x46); store();
    op(0x30); store();
    push(keyHash); store();
    for (const parameter of [0, 1, 0x0f, 3, 4, 5]) { tx(parameter); store(); }
    for (let index = 0; index < 3; index++) {
      for (const parameter of fields) { frame(index, parameter); store(); }
      if (index === 0) push(keccak256(concat([word(16), word(0), keyHash])));
      if (index === 1) push(emptyHash);
      if (index === 2) {
        push(2); frame(2, 4); push(0); push(4096); op(0xb2);
        frame(2, 4); push(4096); op(0x20);
      }
      store();
    }
    push(offset); push(0); op(0x20); load(32); op(0x14); requireTrue();
    push(3); push(0); push(0); op(0xaa);
    label('reject'); push(0); push(0); op(0xfd);
    for (const [position, name] of jumps) {
      const address = labels.get(name);
      if (address === undefined || address > 65535) throw Error('Unresolved EVM label');
      code[position] = address >> 8; code[position + 1] = address & 255;
    }
    return '0x' + Buffer.from(code).toString('hex');
  }
  return { domain, digest, runtime, word };
}
