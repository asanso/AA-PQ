# Nethermind frame-transactions rehearsal — 2026-09-24

Initial result: local replay and frames passed, but Alto validation failed.
The prefix patch subsequently fixed the AA flow; see the follow-up below and
[EF deployment record](NETHERMIND-DEPLOYMENT.md). The initial rehearsal itself
did not alter the remote network.

## Build and network

- Source: `NethermindEth/nethermind`, branch `eip8141-frame-txs-devnet7`,
  commit `c9ad4b5dc3b6db053c3a770ead8130594eb51152`.
- Built the upstream Dockerfile locally, without client source changes:
  `aa-pq-nethermind:frames-c9ad4b5` (Linux arm64).
- Image manifest list:
  `sha256:395fb462bd1d4e533439e292871fd5a7f724e7ea08e50d9e0bc73481f23de886`.
- Separate local chain from the ethrex rehearsal, chain ID 1337; existing
  Lighthouse beacon/validator, no duplicate validator.
- Nethermind RPC: `http://127.0.0.1:28545`; local Alto: port 34337;
  local portal: port 3300. These are not production endpoints.

The branch-name Docker Hub tag was unavailable, so this test built the pinned
source. An amd64 build and production-history replay have not been tested.

## Passed

1. Loaded the original local Geth genesis with matching genesis hash.
2. Replayed the chain through Engine API `newPayloadV4` and
   `forkchoiceUpdatedV3`; every payload was VALID. Final catch-up reached block
   531, hash `0x38af19846d8f64b94471ba17faa9aec7372839a2513124eedb4ffaa0ff699a9f`.
3. Switched the local beacon's existing execution address/DNS alias to Nethermind.
   The same beacon and validator resumed block production. Docker Desktop's host
   port forwarding needed a container restart after changing its network IP.
4. Executed a minimal JavaScript tracer and the production Alto V07 collector
   using Alto's exact function-to-object serialization, including state overrides.
   This capability smoke test passes, but is not the full AA test below.
5. Rejected a signed type-0x06 transaction before activation.
6. Scheduled `config.eip8141PrototypeTime = 1790272456` in a copy of the local
   execution genesis: **2026-09-24 17:54:16 UTC**. Other existing fork times were
   unchanged. Restarted only the local execution container with that config.
7. Accepted a frame transaction after activation; it transferred 123 wei and
   produced two successful frame receipts. Existing Lighthouse continued using
   Engine API V4 across the transition.
8. Rejected identical resubmission (`already known`) and a modified nonce with
   the old signature (`SECP256K1 signer does not match the recovered address`).

Frame transaction:
`0xdaad925650dfdd7392b63cb3b01c8ed38cb15a902a84653557e921846be4d167`,
block **635**, receipt type `0x6`, status `0x1`, payer equal to sender.
The block remained canonical and was verified finalized when the finalized
execution head reached block 640.
This is one secp256k1/default-account frame test, not PQ validation coverage.

## Full Alto test: failed

Deployed the canonical EntryPoint and a SimpleAccountFactory locally from copies
of the existing deployment's public build artifacts (EntryPoint CREATE2 address
checked). Ran the pinned Alto image with the repository's SafeValidator override,
and executed `tests/verify-aa.mjs` against the local portal.

The valid account-creation UserOperation was rejected with
`May not may CALL with value`. It failed both before and after frame activation.
An initial deployment attempt also encountered a nonce collision because Alto
and the deployer shared the development utility key; stopping local Alto during
deployment resolved that separate setup issue.

Diagnostic logging in a temporary copy of SafeValidator showed the collector
returning unprefixed addresses, for example:

```text
to: "433709009b8330fda32311df1c2afa402ed8d009"
value: "1200000000000000"
```

Alto compares that destination with the `0x`-prefixed EntryPoint address. The
comparison fails and the allowed EntryPoint prefund is classified as an illegal
nonzero-value call. The pinned client's JavaScript `Engine.ToHex` uses
`bytes.ToBytes().ToHexString()` without a prefix. Selectors are also shifted by
Alto's `.slice(0,10)` convention. The trace additionally labels internal returns
as REVERT; `FrameResult.getError()` returns JavaScript undefined on success while
this Alto collector uses `=== null`. Follow-up source inspection confirmed that
Geth also returns undefined here, so this is not a Nethermind-specific mismatch
and the client patch leaves this behavior unchanged. The confirmed client bug is
the missing hex prefix, not a reason to suppress validation errors.

No validation rule was disabled. Do not cut over production until a narrowly
scoped tracing compatibility fix passes complete account creation, transfer,
invalid-signature and replay tests, plus client migration/finality checks.

## Artifacts and remaining work

Temporary diagnostic scripts, public contract artifacts, frame inputs/results
and the exact copied production collector are in `/tmp/aa-pq-nethermind.oBFgFV`.
These exploratory scripts are not a durable automated migration suite.
The source checkout is `/Users/monkeair/work/nethermind-frames-c9ad4b5`.
The original local Geth and ethrex data volumes remain intact.

## Prefix-fix follow-up

Applied the one-line `Engine.ToHex` prefix fix, with parameterized regression
tests and updated existing trace expectations. All **41**
`GethLikeJavaScriptTracerTests` pass. The first run identified three remaining
legacy tracer expectations using bare hex; those expectations were updated,
and the complete fixture was rerun successfully. No error or security check was
suppressed.

Local account creation and transfer pass through pinned Alto and EntryPoint.
The strengthened AA test checks that rejected signatures leave the prepared
operation unchanged and rejected replays leave recipient balances unchanged.
One invalid operation produces a generic revert message on Nethermind; the test
does not claim that error text identifies the precise signature failure.

The persistent `tests/verify-frame.mjs` also passed on the patched client:
`0xf0647a32255c2acdd61a3639e78f4b042aaa7b26608a75e3771fd8ed14c992e5`,
block **1503**, two successful frames, 123 wei delivered, duplicate/modified
signature rejected, and canonical finality verified. Frame receipt statuses in
this branch are JSON numbers (`1`), unlike the enclosing receipt's hex status.

The checked-in build script, patch and test harness replace the temporary scripts
for reproduction. Broader frame/PQ-wallet authorization coverage remains future
work; secp256k1 frame support does not establish PQ signature support.
