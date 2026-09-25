export const DAISUGI_GENESIS = '0x3f08ccf3cbc9a60e7a328a3260f2fccf1ee2e8e36e647f030f77b8122cd83e55';
export const FRAME_ACTIVATION_BLOCK = 519324;
export const isFrameTransaction = tx => tx?.type != null && Number(tx.type) === 6;
const quantity = value => value == null ? null : BigInt(value).toString();
const number = value => value == null ? null : Number(value);

// Status 2 means skipped in the pinned Nethermind prototype. Receipt success
// does not imply that every frame succeeded, nor that a frame's effects survived
// a later batch rollback. Preserve the raw receipts for those distinctions.
export function frameStatus(value) {
  return value == null ? 'Unavailable' : ({0:'Failed', 1:'Success', 2:'Skipped'})[Number(value)] || 'Unknown';
}

export function nativeFrameDetails(tx, receipt) {
  if (!isFrameTransaction(tx)) return null;
  if (receipt && (receipt.transactionHash?.toLowerCase() !== tx.hash?.toLowerCase()
      || (tx.blockHash && receipt.blockHash !== tx.blockHash))) {
    throw new Error('Frame receipt does not match the transaction.');
  }
  const frames = Array.isArray(tx.frames) ? tx.frames.map((frame, index) => {
    const result = receipt?.frameReceipts?.[index];
    return {
      index, mode:number(frame.mode), modeName:frame.mode == null ? 'Unavailable' : ({0:'DEFAULT',1:'VERIFY',2:'SENDER',3:'POST_TX'})[Number(frame.mode)] || 'Unknown',
      flags:number(frame.flags), target:frame.target ?? null, valueWei:quantity(frame.value), data:frame.data ?? null,
      effectiveTarget:Object.hasOwn(frame,'target') ? frame.target ?? tx.from : null,
      executionGasLimit:quantity(frame.executionGasLimit), stateGasLimit:quantity(frame.stateGasLimit),
      status:receipt ? frameStatus(result?.status) : tx.blockNumber == null ? 'Pending' : 'Unavailable',
      executionGasUsed:quantity(result?.executionGasUsed), stateGasUsed:quantity(result?.stateGasUsed),
      logs:result?.logs ?? null
    };
  }) : null;
  const witnesses = Array.isArray(tx.signatures) ? tx.signatures.map((witness, index) => ({
    index, scheme:number(witness.scheme), schemeName:witness.scheme == null ? 'Unavailable' : ({0:'ARBITRARY (account-defined)',1:'SECP256K1'})[Number(witness.scheme)] || 'Unknown',
    signer:witness.signer ?? null, message:witness.msg ?? null, signature:witness.signature ?? null
  })) : null;
  return {
    type:6, standard:'EIP-8141 prototype', payer:receipt?.payer ?? null, frames, witnesses,
    resultsComplete:!!receipt && !!frames && Array.isArray(receipt.frameReceipts) &&
      receipt.frameReceipts.length === frames.length && frames.every(frame => ['Success','Failed','Skipped'].includes(frame.status)),
    rawTransaction:tx, rawReceipt:receipt ?? null
  };
}

export function nativeFrameSummary(tx, receipt, block) {
  const details = nativeFrameDetails(tx, receipt);
  return {
    hash:tx.hash, from:tx.from, nonce:quantity(tx.nonce), blockNumber:Number(block.number), blockHash:block.hash,
    timestamp:number(block.timestamp), transactionIndex:number(tx.transactionIndex), type:6,
    status:receipt?.status == null ? 'Unavailable' : Number(receipt.status) === 1 ? 'Success' : 'Failed',
    frameCount:details.frames?.length ?? null,
    frameStatuses:details.frames?.map(frame => frame.status) ?? null,
    targets:details.frames?.map(frame => frame.effectiveTarget).filter(Boolean) ?? [],
    resultsComplete:details.resultsComplete
  };
}
