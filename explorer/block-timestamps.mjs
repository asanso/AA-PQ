const blockHashPattern = /^0x[0-9a-fA-F]{64}$/;

export function createBlockTimestampReader(provider, {maximum = 512} = {}) {
  const cached = new Map(), pending = new Map();
  async function read(hash) {
    if (!blockHashPattern.test(hash || '')) return null;
    const key = hash.toLowerCase();
    if (cached.has(key)) return cached.get(key);
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      try {
        const block = await provider.getBlock(hash);
        if (block?.hash?.toLowerCase() !== key || !Number.isSafeInteger(block.timestamp) || block.timestamp < 0) return null;
        if (cached.size >= maximum) cached.delete(cached.keys().next().value);
        cached.set(key, block.timestamp);
        return block.timestamp;
      } catch { return null; }
    })().finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }
  return async records => {
    const result = new Array(records.length);
    let next = 0;
    // Resolve only displayed records, with bounded parallel block reads.
    await Promise.all(Array.from({length: Math.min(4, records.length)}, async () => {
      while (next < records.length) {
        const index = next++, record = records[index];
        result[index] = {...record, timestamp: await read(record.blockHash)};
      }
    }));
    return result;
  };
}
