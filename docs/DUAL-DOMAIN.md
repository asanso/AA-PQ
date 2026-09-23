# Shared portal across two domains

The portal can serve Overview and Faucet on `daisugi.fyi` and the Explorer on
`explorer.daisugi.fyi` while reusing one interface. Enabling this mode requires
the updated application and the service configuration below.

## Public routes

| URL | Page |
| --- | --- |
| `https://daisugi.fyi/` | Overview / FAQs |
| `https://daisugi.fyi/faucet` | Faucet |
| `https://daisugi.fyi/overview/getting-started` | Corresponding FAQ |
| `https://explorer.daisugi.fyi/` | Explorer dashboard |
| `https://explorer.daisugi.fyi/tx/<hash>` | Transaction |
| `https://explorer.daisugi.fyi/op/<hash>` | UserOperation |
| `https://explorer.daisugi.fyi/block/<number>` | Block |
| `https://explorer.daisugi.fyi/address/<address>` | Address |

Both hosts use the header, fonts, styles and JavaScript in `frontend/public`.
Old hash bookmarks are translated to clean URLs. Direct links, reload,
Back/Forward and opening links in a new tab are supported.

On localhost, IP addresses and review tunnels, all navigation stays on the
current origin: Overview is `/`, Faucet is `/faucet` and Explorer is `/explorer`.
These previews do not redirect to the production domains.

## Services and API compatibility

The two existing service ports can be retained:

| Service | Default port | Responsibility |
| --- | --- | --- |
| Frontend | 3000 | Shared UI, portal APIs, faucet and existing RPC/bundler proxies |
| Explorer | 3001 | Native indexer APIs and optional shared-UI forwarding |

For the explorer process, set:

```dotenv
PORTAL_ORIGIN=http://127.0.0.1:3000
```

It forwards only allowlisted assets, page routes and read-only portal APIs to the
frontend. Faucet POST requests remain unsupported on the explorer service.
Leaving `PORTAL_ORIGIN` unset retains the previous explorer UI.

The native explorer endpoints `/api/overview`, `/api/block/*`, `/api/tx/*`,
`/api/op/*` and `/api/address/*` continue to be handled by the indexer.
The frontend's `EXPLORER_URL` points to that native API. Native requests are
never forwarded back to the frontend, avoiding a routing loop.

## Frontend configuration

Reconcile these example values with the running network:

```dotenv
PUBLIC_SITE_URL=https://daisugi.fyi
PUBLIC_EXPLORER_URL=https://explorer.daisugi.fyi
THEME_COOKIE_DOMAIN=daisugi.fyi
PUBLIC_RPC_URL=https://daisugi.fyi/rpc
PUBLIC_BUNDLER_URL=https://daisugi.fyi/bundler
RPC_URL=http://127.0.0.1:32773
FAUCET_RPC_URL=http://127.0.0.1:32773
BUNDLER_URL=http://127.0.0.1:4337
EXPLORER_URL=http://127.0.0.1:3001
```

Keep the existing EntryPoint, factory and funded faucet account configuration in
the protected server environment. The Geth RPC port above is an example from
the existing deployment, not a fixed Kurtosis port.

`PUBLIC_SITE_URL` and `PUBLIC_EXPLORER_URL` default to the origins above.
They accept HTTP(S) origins without paths, credentials, queries or fragments.
`PUBLIC_RPC_URL` and `PUBLIC_BUNDLER_URL` describe externally reachable endpoints;
`RPC_URL` and `BUNDLER_URL` select the backend upstreams.

The frontend publishing `/rpc` and `/bundler` must use their internal backends,
rather than its own public URLs, to avoid proxying to itself. Do not copy the
review environment wholesale into that service: the review instance can use the
public endpoints because it is a different service.

Read-provider JSON-RPC batching is disabled for compatibility with the restricted
public proxy. The faucet uses `FAUCET_RPC_URL` when set, otherwise `RPC_URL`;
that connection needs nonce, fee and transaction-submission methods.

Backend and environment changes require a service restart. Static files are
read from disk on each request.

## Theme continuity

The theme remains in localStorage. On the two configured public origins, the
non-sensitive `daisugi.theme` preference cookie uses `Domain=daisugi.fyi`,
`Path=/` and `SameSite=Lax`, with `Secure` on HTTPS. Both origins must be within
the configured cookie domain. The saved theme is applied before CSS loads.

Local previews keep their own preference. Moving between origins performs a
normal document navigation, while the shared assets and theme preserve the
appearance.

## Verification and release

From the repository root:

```sh
npm ci --prefix frontend
npm ci --prefix explorer
node --test tests/*.test.mjs explorer/user-operation.test.mjs
```

Verify both configured origins, direct-link reloads, old bookmarks, Back/Forward,
read-only chain data, decoded calldata, mobile widths, stable header placement
and shared theme selection. Mock faucet responses when checking its UI.
`tests/verify-aa.mjs` creates accounts and sends transactions on its test network.

Reconcile local changes and protected configuration in the deployment checkout
before publishing. Keep the current ingress destinations when they already
forward each host to the corresponding service; ensure the shared page and
asset paths reach those services as well as the APIs.

Publishing the code, applying environment settings and restarting services are
deployment steps separate from committing or pushing to Git. The prepared pipeline and its separate activation requirements are documented in
[PIPELINE.md](PIPELINE.md); adding its workflow does not provision or enable deployment.
