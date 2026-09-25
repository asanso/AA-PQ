# Native frame transactions

The explorer recognizes Daisugi's type-`0x06` transactions as **EIP-8141
prototype** transactions. This is an experimental client implementation, not a
claim that frame transactions are deployed on Ethereum mainnet.

## Explorer records

Transaction details preserve the node's complete `frames`, `signatures`, `payer`
and `frameReceipts` fields. Each frame shows its mode, flags, target, value,
execution/state gas limits and usage, receipt status and full calldata. Supported
ABI templates provide parameter decoding; unknown inputs remain available as hex.
The complete RPC transaction and receipt are also displayed without truncation.

A null outer `to` field in a native frame transaction is not labeled contract
creation. Value and destination belong to individual frames. Signature witnesses
retain their scheme, optional signer, message and full signature bytes. Byte/bit
counts measure encoded length, not security strength. The ARBITRARY witness
scheme does not identify a signature algorithm; the account's verification code
determines how those bytes are interpreted.

The optional **Account verification profile** identifies SPHINCS-G only when the
sender's clone runtime and the pinned implementation and verifier code hashes
match at the inclusion block. This is implementation provenance, not an additional
signature-verification result. Unknown accounts or unavailable historical code
remain unidentified; a 6,176-byte witness alone is never sufficient.

Receipt success and frame execution are distinct. Frame status 0 means failed,
1 means successful execution and 2 means skipped in the pinned Nethermind
prototype. Missing results remain unavailable. A later atomic-batch failure can
roll back earlier successful frames; this release does not reconstruct committed
internal transfers for frame transactions. It does not infer transferred ETH
from a successful outer receipt alone.

## Index coverage

Native frame transactions have their own counter and activity list. They do not
increment the ERC-4337 UserOperation counter. Address records include indexed
transactions where the address is the sender or a frame target; these are not
necessarily ETH transfers. Lists show the most recent 100 matching records (the
home page displays the latest 10). The counter covers every indexed native
transaction, including unsuccessful executions, not just those in the list.

The index validates chain ID 1337 and genesis
`0x3f08ccf3cbc9a60e7a328a3260f2fccf1ee2e8e36e647f030f77b8122cd83e55`.
Historical coverage begins at block 519324, the activation block for the deployed
prototype. It reads full blocks rather than relying on contract events, which
native transactions need not emit. The implementation was checked against
Nethermind revision `c9ad4b5dc3b6db053c3a770ead8130594eb51152`.

On startup, the index prioritizes recent blocks and backfills history in batches
of 64, with at most four concurrent block reads. Coverage and partial counts are
reported explicitly. It re-reads the last 12 blocks and resets coverage when an
older anchor changes or the chain head regresses. Missing blocks or receipts
leave coverage incomplete rather than silently omitting transactions.

The overview does not wait for the initial ERC-4337 historical scan. Until that
scan completes, its counts remain unavailable and the interface reports that the
EntryPoint index is warming up. Block data and native frame coverage load
independently.

The cache defaults to `$HOME/.cache/daisugi-frame-index/<PORT>.json`, outside the
release directory. `FRAME_INDEX_CACHE` may select another writable path. Give
each indexer process a distinct file. Cache identity includes the genesis and
activation block; it is revalidated against the node on restart. Cache write
failures leave the in-memory index available and report the persistence warning.

## Public RPC preparation

The portal's `/rpc` endpoint supports the wallet's read methods, including nonce,
gas estimation, fee queries and native `eth_call` simulation. It accepts a single
JSON-RPC 2.0 request, a maximum 128 KiB request body, and no state/block overrides.
It does not expose node administration, debug methods, unlocked-account
transactions or signing methods. CORS permits public RPC clients without cookies
or credentials. The existing `/bundler` endpoint remains dedicated to ERC-4337.

Native raw submission is **disabled by default**. A separately approved
environment can set `NATIVE_FRAME_RPC_ENABLED=true` for its portal service. The
gateway then accepts structurally valid, bounded type-`0x06` transactions for
chain 1337 and checks the upstream genesis before forwarding them. It rejects
other transaction types. These checks are not signature verification: the node
still validates the signature, account authorization and transaction execution.

`GET /api/config` reports `nativeFrameSubmissionEnabled`. Enabling the variable,
restarting a service or deploying this source is an operational action, not an
automatic consequence of preparing or pushing the code. Each environment needs
its own explicit activation. No wallet discovery or connection is added to the
portal.

Before a public wallet build is distributed, verify the chosen HTTPS endpoint,
its activation flag, genesis and all pinned contract code hashes. Keep the
existing account factory, verifier and signature profile unchanged. Wallet
connection settings and extension host permissions must match that endpoint.

## Verification

Run `bash scripts/check-portal.sh` after installing the locked frontend and
explorer dependencies. Tests cover native receipt/data preservation, per-frame
decoding, missing/failed/skipped results, partial history, reorganization recovery,
cache identity, RPC method/envelope restrictions and the HTTP gateway. Broadcast
tests use a loopback mock, not a live signer or shared network.

The public fixture in `tests/fixtures/native-frame.json` is transaction
`0xd331644362f5e2a0c910d80d16bc66966d2907176d26edc597b4f6dd881dfc35`
and its receipt from Daisugi block 533121. It contains a zero-value self call,
account creation and verification, with three successful frame statuses. It is
not a fixture proving an ETH transfer to a different recipient.
