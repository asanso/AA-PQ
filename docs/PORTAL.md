# Daisugi testnet portal

The frontend is a public, single-chain portal for Daisugi (1337). Its navigation
contains Overview, Explorer and Faucet. It does not discover, connect to, or
request signatures from browser wallets. The wallet demo and its browser assets
have been removed; account setup and signing happen in an external wallet.

## Routes

| Page | Local / review preview | Configured public deployment |
| --- | --- | --- |
| Overview / FAQs | `/` | `https://daisugi.fyi/` |
| FAQ topic | `/overview/<topic>` | `https://daisugi.fyi/overview/<topic>` |
| Faucet | `/faucet` | `https://daisugi.fyi/faucet` |
| Explorer dashboard | `/explorer` | `https://explorer.daisugi.fyi/` |
| Block | `/explorer/block/<number>` | `https://explorer.daisugi.fyi/block/<number>` |
| Address | `/explorer/address/<address>` | `https://explorer.daisugi.fyi/address/<address>` |
| Transaction | `/explorer/tx/<hash>` | `https://explorer.daisugi.fyi/tx/<hash>` |
| UserOperation | `/explorer/op/<hash>` | `https://explorer.daisugi.fyi/op/<hash>` |

Automatic hash searches use `/explorer/hash/<hash>` in a preview or `/hash/<hash>`
on the explorer host. They try the transaction lookup first, then the
UserOperation lookup. Localhost, IP addresses and review tunnels remain on the
current origin. The two-host rules apply only to the configured public origins.

The old `#explorer/...` and standalone explorer `#tx/...` / `#op/...` bookmarks
are translated to clean URLs. `#overview/<topic>` and `#docs/<section>` open the
corresponding FAQ. Legacy wallet/settings links return to Overview; legacy
explorer category links return to the dashboard. Direct links, reload and browser
Back/Forward are supported.

Overview contains the current six FAQs: Daisugi, post-quantum account research,
NiceTry, network configuration, faucet and first transaction. The dashboard
contains network metrics, recent blocks, UserOperations, account deployments and
search. It does not expose a wallet portfolio or a connect-wallet action.

## Data flow and APIs

`GET /api/network` checks chain ID, latest block and bundler chain ID. Checks
share a five-second cache. A block more than 45 seconds old is marked delayed.
The visible explorer refreshes every 15 seconds and on focus. Initial reads start
when the explorer is opened. Failed checks show unavailable values rather than
fabricated zeroes.

`GET /api/explorer/<route>` accepts only overview and supported record paths.
It reads the native indexer configured by `EXPLORER_URL` and enriches transaction
or UserOperation records with RPC input data and transaction details.
`GET /api/config` supplies chain, faucet and public-endpoint metadata.
`GET /site-config.js` supplies non-secret public origins and theme-cookie scope
before the interface and styles load.

Browser API calls remain on the page's origin. When `PORTAL_ORIGIN` is enabled on
the explorer service, that service forwards the shared UI and allowlisted
read-only portal API requests to the frontend. Its native `/api/overview` and
record endpoints continue to be handled by the indexer; they are not forwarded
back to the frontend. See [DUAL-DOMAIN.md](DUAL-DOMAIN.md) for configuration.

## Configuration and previews

Use Node 22 or later. Install both packages before testing both services:

```sh
npm ci --prefix frontend
npm ci --prefix explorer
```

[The README](../README.md#run-against-an-existing-network) documents starting a
fresh local instance against an existing network. The existing review copy is
in `~/dev-testnet`, using a frontend bound to `127.0.0.1:3003`. Its commands and
temporary public link are described in that copy's `README-PREVIEW.md`. These
review helpers are specific to that environment and are not part of the source
release.

Configure the RPC, bundler, EntryPoint and funded faucet account through the
server environment. `FAUCET_PRIVATE_KEY` is required. `FAUCET_RPC_URL` optionally
separates transaction submission from read-only RPC access. `EXPLORER_URL`
defaults to `http://127.0.0.1:3001`. RPC ports can change when a devnet is
recreated; use the actual service addresses.

`PUBLIC_RPC_URL` and `PUBLIC_BUNDLER_URL` are public endpoint metadata. They do
not change the internal upstreams. The portal's `/rpc` proxy permits selected
read methods and does not provide every method required by a general-purpose
wallet. Its public bundler URL is separate.

The faucet retains amount validation (maximum 10 ETH at the API; the interface
requests 1 ETH), verifies chain 1337, and reserves a 60-second cooldown per
recipient before broadcasting. The cooldown is case insensitive, process-local,
bounded and cleared on restart. Failed or uncertain broadcasts retain the
reservation to avoid immediate duplicates. Amounts are checked as integer wei,
including the 10 ETH upper bound; an omitted amount defaults to 1 ETH, while zero
and invalid recipients are rejected. Broadcasts from the faucet signer are
serialized within the process, with uncached pending-nonce reads. This prevents
concurrent requests from reusing a nonce; it does not coordinate multiple faucet
processes sharing a key. No browser wallet connection is used.

## Research scope

The portal reads the deployed chain and displays available UserOperation
signatures and execution data. It does not determine a signature algorithm from
byte length or claim that an entire network is post-quantum secure. The pinned
SimpleAccount deployment recipe in this repository is a baseline; the account
and verifier versions used by a research deployment must be documented and
verified separately. Updating this UI does not change them.

## Design and verification

The same assets serve both public origins: the self-hosted Inter font, Ethereum
diamond, white light theme and dark theme. The font license is in
`frontend/public/fonts/OFL-Inter.txt`. The diamond comes from
[the Ethereum assets page](https://ethereum.org/assets/), with its viewBox cropped
to remove surrounding whitespace.

Theme selection is saved locally. On the configured Daisugi hosts, a shared
preference cookie preserves it across subdomains and is read before CSS loads.
The header keeps a stable scrollbar gutter to avoid horizontal movement during
navigation.

```sh
node --test tests/*.test.mjs explorer/user-operation.test.mjs
```

Browser verification covers navigation without wallet extensions, real read-only
chain queries, service failures, direct-link reloads, old bookmarks, Back/Forward,
mobile layouts, theme persistence and manual faucet address entry. Mock
`POST /api/faucet` when testing the form; do not use the live-chain integration
script as a read-only UI test.

## Transaction input and UserOperation call data

Transaction details include the complete hexadecimal `data` returned by the Daisugi RPC, its byte/bit length and a copy action. Empty input (`0x`) is distinct from unavailable data. Contract-creation input is described as creation bytecode/constructor arguments, without labeling the first four bytes a function selector.

UserOperation details retain the signature and also display the operation's `callData` and the full enclosing transaction input. Operation extraction supports packed EntryPoint `handleOps` and `handleAggregatedOps`, requiring the configured EntryPoint destination and a unique sender/nonce match. Unsupported or ambiguous encodings remain unavailable; the raw transaction bytes are still shown. No account ABI or function name is guessed from a selector. Bit counts describe encoded length, not cryptographic security strength.

These additional reads run in the frontend backend. The native explorer indexing APIs remain available; the optional shared-interface proxy is described above. Input-read failures leave indexed details and signatures visible with an input-data error. Failure to load optional receipt or trace metadata does not discard input bytes that were already retrieved and verified. Test the read/enrichment/decoding paths with `node --test tests/transaction-input.test.mjs tests/portal-api.test.mjs`.

## Input views and ABI decoding

Each transaction/callData panel has Default view (function signature when recognized plus original input), UTF-8 (strict decoding with control characters escaped), Original hex, Decode input data and Export JSON. Copy hex always copies the original bytes regardless of the selected view. The signature panel stays separate.

Decoding supports the project's packed EntryPoint `handleOps` / `handleAggregatedOps` ABI for the configured EntryPoint address, plus the `execute(address target,uint256 value,bytes data)` schema used by the frontend. The account schema is explicitly an ABI template, not a claim of verified contract source. Array and tuple fields use fully qualified names, with name/type above each full-width value; integer values retain decimal precision as strings. Unknown selectors, invalid encodings and creation input receive an explanatory fallback rather than fabricated parameters.

Canonical re-encoding is compared to the full input. Additional trailing bytes are exposed separately and retained in the original data and JSON export. If the encoding is non-canonical, the view reports this without claiming which bytes are unused. UTF-8 presentation does not execute input or parse it as HTML. JSON exports contain both the complete original input and the typed decode result.

Decoder tests: `node --test tests/input-decoder.test.mjs tests/input-data.test.mjs tests/transaction-input.test.mjs`.

## Full transaction record

The transaction detail layout includes receipt status, block confirmations (head - inclusion block + 1), block timestamp with UTC/local presentation, sender/destination, created contracts when available, transaction value, actual fee, effective gas price, gas limit/usage, EIP-1559 caps, execution fee burned, fee-cap savings, transaction type/nonce/position, and the input viewer embedded in the record. Supported ABI parameters are flattened into paths such as `ops[0].callData` for this compact view. Original hex, UTF-8, copy and JSON export remain available. UserOperation execution results and signature data remain on their own detail pages.

All fee arithmetic uses integers in wei. Execution fee is receipt gas used times receipt effective gas price. The total transaction fee also includes blob gas fees when present; the total is unavailable if a blob transaction's blob fee is missing. The burnt amount shown is explicitly execution gas used times block base fee. Fee-cap savings are `(maxFeePerGas - effectiveGasPrice) * gasUsed`; unused gas is not counted as an additional saving. Test ETH has no fiat valuation. Pending/legacy/missing receipt values are labelled instead of treated as zero.

Internal ETH transfers use a read-only `debug_traceTransaction` call with `callTracer`, a two-second tracer timeout and `reexec: 0`. Calls are bounded to two concurrent traces and cached for 30 seconds (100 entries). The debug method is used only by the backend; it is not added to the browser RPC proxy allowlist. No node configuration is changed. Transfers from reverted frames or reverted ancestors, delegate-call value fields and the top-level transaction value are excluded. Net transfers sum these internal value movements only and exclude fees. Created contract addresses come from a receipt or successful CREATE/CREATE2 trace frames.

Tracing requires an RPC endpoint that permits `debug_traceTransaction` and a node with the relevant historical state. The restricted public RPC rejects this method; another node can also report unavailable historical state. The page displays the limitation and still shows available receipt, block and input data. Transaction logs alone are not a substitute for those internal transfers.

References: https://ethereum.org/developers/docs/apis/json-rpc/ , https://eips.ethereum.org/EIPS/eip-1559 , https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers .
