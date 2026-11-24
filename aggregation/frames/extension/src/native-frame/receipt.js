// Outcome of a native frame transaction from its receipt: confirmed only when the transaction and every frame
// succeeded, so top-level success never hides a failed transfer.
export function receiptOutcome(receipt, expectedHash, expectedFrames) {
  if (!receipt) return { status: 'pending' };
  if (receipt.transactionHash?.toLowerCase() !== expectedHash.toLowerCase() || BigInt(receipt.type ?? -1) !== 6n)
    throw Error('The receipt does not match this frame transaction.');
  if (receipt.status == null || receipt.blockNumber == null) throw Error('Incomplete transaction receipt.');
  if (BigInt(receipt.status) !== 1n) return { status: 'failed', message: 'Transaction failed.', receipt };
  if (!Array.isArray(receipt.frameReceipts) || receipt.frameReceipts.length !== expectedFrames)
    throw Error('Frame execution results are unavailable. Success cannot be confirmed.');
  const failed = receipt.frameReceipts.findIndex(f => f.status == null || BigInt(f.status) !== 1n);
  return failed < 0 ? { status: 'confirmed', receipt } :
    { status: 'failed', message: `Frame ${failed} failed. The transfer was not confirmed.`, receipt };
}
