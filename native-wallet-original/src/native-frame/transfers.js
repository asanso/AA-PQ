// Extract direct ETH movements only after their containing execution succeeded.
// Nested contract transfers require traces and are not inferred from calldata.
export function directTransfers(transaction, receipt) {
  if (!transaction || !receipt || receipt.status == null || BigInt(receipt.status) !== 1n) return [];
  if (BigInt(transaction.type ?? 0) === 6n) {
    if (!Array.isArray(transaction.frames) || receipt.frameReceipts?.length !== transaction.frames.length) return [];
    return transaction.frames.flatMap((frame, index) => {
      const status = receipt.frameReceipts[index]?.status;
      if (status == null || BigInt(status) !== 1n || Number(frame.mode) !== 2 || BigInt(frame.value || 0) === 0n) return [];
      return [{ ...transaction, to: frame.target, value: frame.value, frameIndex: index }];
    });
  }
  return transaction.to && BigInt(transaction.value || 0) > 0n ? [transaction] : [];
}
