# Immutable aggregate account profile v2

This is an application account policy for the pinned experimental client. It
does not define Ethereum consensus or claim conformance to a finalized EIP.
It leaves the SPHINCS-G algorithm, proven guest and native verification key intact.

## Account and frames

Each account is an EIP-1167 dispatcher followed by a 32-byte immutable key hash:
`keccak256(pkRoot[0:16] || pkSeed[0:16])`. The implementation reads this hash from
its caller's clone code during delegated execution. Runtime length is 77 bytes.
The factory has no setters, initializer, owner rotation or standalone FORS path.
SPHINCS-G's internal hash-based signature structure is unchanged.

An existing account accepts exactly three frames:

| Index | Mode | Target | Purpose |
| --- | --- | --- | --- |
| 0 | DEP_VERIFY (4) | Account | Declare profile, intent digest and key hash |
| 1 | VERIFY (1), flags 3 | Account | Bind authorization, then APPROVE execution and payment |
| 2 | SENDER (2) | Signed destination | Execute signed calldata and value |

First sends prepend a DEFAULT frame calling `createAccount(bytes32,bytes32,bytes32)`.
The complete factory address and creation arguments are signed. The account is
created before the dependency/authorization frames. A failed authorization rolls
back the transaction. Smart-contract destinations are supported.

The prototype restricts chain 1337 in the wallet, one zero nonce key, no envelope
signatures, no blobs, no recent-root references and at most 4096 calldata bytes
in the SENDER frame. The account binds the actual chain ID rather than a constant.
DEP_VERIFY uses 3000 execution gas and zero state gas. VERIFY requires at least
50,000 execution gas; the exercised wallet path supplies 100,000.

## Signed intent

The digest is Keccak-256 over consecutive 32-byte words, in this order:

1. `keccak256("Daisugi.AggregatedFrameAccount.v2")`.
2. Chain ID, sender address, immutable authorized-key hash and transaction type 6.
3. Nonce sequence and the client commitment to the single zero nonce key.
4. Max priority fee, max fee, zero max blob fee and frame count.
5. For each frame: resolved target, execution gas, mode, flags, calldata length,
   value, state gas and calldata hash.

Only the dependency message is normalized to zero while hashing its calldata.
Its algorithm identifier 16 and authorized key hash remain in that preimage.
The account compares the reconstructed digest with the declared dependency
message, then approves. This avoids an input that must contain its own hash.
It is distinct from the typed transaction hash used for RPC and receipts.

The account checks sender, frame count/order, modes, approval flags, target,
dependency length/key/profile, envelope restrictions and supported limits before
APPROVE. The optional factory call must have the expected selector and 100-byte
input. Its destination and full arguments participate in the signed intent.

Recent-root references have no count accessor in this pinned profile. A bounded
self-call probes reference zero and the account requires its absence. The
2,000-gas probe is exercised with an actual valid reference and without one;
an adversarial gas-boundary review is still required. This mechanism must not
be generalized to unknown clone layouts or arbitrary implementations.

## Wire transport and proof binding

The wallet submits the upstream RLP wrapper:

```text
[
  [raw typed transaction],
  0,
  [dependency triple, [pkRoot16 || pkSeed16 || sphincsSignature6176]]
]
```

The typed transaction encodes `[chainId, [0], nonceSequence, sender, frames,
[], [priorityFee, maxFee, 0], []]` after its `0x06` prefix. Its hash excludes the
wrapper. A 6176-byte signature length describes encoding, not security strength.

`eth_sendProofWrapper` validates the witness and admits the transaction through
the real pool. Block production creates a proof for the selected dependency set.
Receivers verify that proof against the block's dependencies and execute account
authorization. A valid proof for a declared digest does not authorize different
transaction fields: the account must independently reconstruct the same digest.

No raw-submission fallback is provided. Before broadcast, the wallet adapter
requires its durable journal and checks the session, account state and bytecode
pins. Ambiguous transport outcomes retain the transaction hash as pending;
they do not trigger another submission.
