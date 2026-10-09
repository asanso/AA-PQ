# Aggregate account authorization profile v1

Status: experimental, inactive. This account policy uses the existing opcodes in
Nethermind `4a17b571f453d112bae5175a2e4966900201deae`. It does not change the
client's canonical transaction hash, signature hash, consensus opcodes or SPHINCS-G.
It is not an assertion of finalized EIP conformance or cross-client interoperability.

## Authorization

An immutable public-key hash is embedded in the account runtime. The wallet signs
an account-defined intent hash with its existing SPHINCS-G implementation. The
dependency frame contains `(0x10, intent_hash, keccak256(root || public_parameter))`.
The client verifies the actual signature or aggregate proof against that declaration.

During VERIFY the account reads the transaction and frame fields using TXPARAM,
FRAMEPARAM, FRAMEDATALOAD and FRAMEDATACOPY. It reconstructs the same intent hash,
checks the declared scheme, message and key, and only then calls APPROVE with
execution and payment scope. It makes no individual signature-verifier call.

This separates two required checks: the client proves the declared signature is
valid, and the account proves that its declaration authorizes this transaction.
A valid signature for another message must fail the account check.

## Supported envelope

Exactly three frames are accepted:

1. DEP_VERIFY, mode 4, flags 0, target resolving to the sender, execution gas 3,000,
   state gas 0, value 0 and exactly one 96-byte SPHINCS dependency.
2. VERIFY, mode 1, flags 3, target resolving to the sender, value 0, empty data
   and at least 50,000 execution gas.
3. SENDER, mode 2, flags 0, with a signed target, value and up to 4,096 calldata bytes.

Contract destinations are supported. The first integration fixture calls a
contract with nonempty calldata and transfers test ETH in the in-memory state.
Gas limits for both executable frames, including their state-gas components, are
bound by the signature. The sender also pays transaction fees.

The profile uses nonce key zero, permits no envelope signatures, blobs or
recent-root references, and requires a zero blob fee. Extra frames, paymasters,
atomic batches and POST_TX assertions are outside this initial account policy.
The deployed wallet and existing accounts keep their previous behavior.

Omitted and explicit self targets have the same intent representation. This is
semantic normalization, not a byte-for-byte commitment to the wire encoding.
The selected upstream EIP-8288 prototype enables EIP-8250 and rejects scalar
legacy nonces at transaction validation. The wallet construction must use the
one-element nonce-key-zero encoding. The earlier legacy codec round trips do not
establish transaction admission under this fork configuration.

## Digest encoding

Every item below is a 32-byte word. Integers and addresses are big-endian and
left-padded. Concatenation has a fixed length of 1,088 bytes.

```text
keccak256(
    keccak256(UTF8("Daisugi.AggregatedFrameAccount.v1")) ||
    chain_id || account_address || authorized_key_hash ||
    transaction_type_6 || nonce || nonce_keys_hash ||
    max_priority_fee_per_gas || max_fee_per_gas || max_fee_per_blob_gas ||
    frame_0_words || frame_1_words || frame_2_words
)

frame_i_words = resolved_target || execution_gas_limit || mode || flags ||
                data_length || value || state_gas_limit || data_hash
nonce_keys_hash = keccak256(word(1) || word(0))
```

`data_hash` normally hashes the exact frame data. Only frame zero uses a normalized
dependency: `keccak256(word(0x10) || word(0) || authorized_key_hash)`. The runtime
separately requires its actual message to equal the reconstructed digest. This
removes the self-reference without allowing another key, scheme or operation.

The account does not sign block-dependent values such as the effective gas price,
timestamp or state. Ordinary transaction validity and execution rules remain active.

## Recent-root exclusion

The pinned opcodes expose a recent-root reference by index but do not expose the
count. A bounded STATICCALL to the account's own fixed probe attempts to read index
zero. Success means at least one reference exists and rejects authorization.
An absent index exceptional-halts only the probe call. The account requires at
least 50,000 execution gas for its frame and performs only fixed, bounded work
before forwarding 2,000 gas to the short probe. It does not use the GAS opcode,
which the public pool disallows outside an immediately following call. The probe
performs no storage access or external call. The test profile requires the pinned
opcode and prefix-gas semantics.

## Test boundaries

New random signing seeds exist only in the fixture generator's memory. The output
contains public account code, messages, signatures and transaction fields. The
original NiceTry 2.1.3 module is hash-checked before loading and is not modified.
Accounts and balances are installed only in the test harness's in-memory genesis.
There is no RPC submission, persistent account deployment or faucet request.

The test harness uses real transaction-pool, EVM, native proof and block-production
components. It is not an extension UI test or an activation on the shared Daisugi
chain. A production proposal still requires factory/initial-deployment integration,
wallet packaging, fork/Engine API review and operational migration checks.
