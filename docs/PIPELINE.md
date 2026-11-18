# Portal development and release workflow

## Branches and decisions

The intended long-lived branches are `dev`, `staging` and `main`.

| Branch | Purpose | Deployment |
| --- | --- | --- |
| dev | Development and automated checks | No automatic deployment |
| staging | Release candidate | Automatic after a successful enabled pipeline run |
| main | Approved source | Manual workflow dispatch only |

Use pull requests for promotion. A pull request exposes the proposed diff and
test results; merging it changes the destination branch. Required reviewer count
is **zero**. The project owner decides when to merge, after any optional feedback.
Do not enable automatic merge or required deployment reviewers.

A push to main runs checks only. It never starts a production deployment.
Every agent-performed push, merge and production deployment requires the user's
explicit authorization for that operation. This workflow does not grant it.

During review, keep staging fixed at the reviewed commit. Do not merge unrelated
development into staging. With only these three branches, the simplest release
discipline is to finish candidate fixes before mixing the next release's features
into dev. If concurrent work requires a different promotion strategy, agree on it
before applying selective commits or changing the branch layout.

Prefer merge commits for promotions between these long-lived branches; repeatedly
squashing or rebasing shared branches obscures their ancestry. After a release,
merge main back into staging and dev as needed, preserving history. Do not force
push or reset published branches to synchronize them.

## Pipeline behavior

`.github/workflows/portal.yml` runs on pushes and pull requests targeting the three
branches. The required status check is named **Portal checks**.

Checks use Node 22.23.2, both committed npm lockfiles, JavaScript syntax validation,
the isolated Node test suite and the Python deployment tests. They do not load
the server environment, create accounts or send live transactions. Pull-request
checks have read-only repository access and no deployment credentials.

When a staging push passes checks and repository variable `STAGING_DEPLOY_ENABLED`
equals `true`, the workflow packages the tested commit and deploys it to the
`staging` GitHub environment. Branch protection is what requires that this push
come from a merged pull request.

Production uses `Run workflow` on branch `main`. Enter:

- `expected_main_sha`: the complete main commit SHA to publish.
- `reviewed_staging_sha`: the complete SHA displayed by the reviewed staging release.

The workflow requires `PRODUCTION_DEPLOY_ENABLED=true`, matching checked-out
source, identical Git source trees for main and the reviewed staging commit,
and a successful GitHub staging deployment for that commit. This accommodates
different merge commit SHAs while preserving the reviewed content.

Both targets recheck the remote branch head before deployment, verify the package
checksum and serialize deployments per environment. Production is not gated by
another person's approval. New source requires a new staging deployment and review.

Disabled activation variables intentionally prevent deployment. Preparing or
pushing this workflow does not by itself install services, provision Teleport
identities or configure branch protection.

## GitHub configuration

A repository administrator must configure:

1. Branch rules for `staging` and `main`:
   - Pull request required.
   - Required approving reviews: **0**.
   - Approval of the latest push: **off**.
   - Required status check: **Portal checks**.
   - Require the branch to be up to date before merging.
   - Block force pushes and branch deletion.
   - Apply rules without routine administrator bypass.
2. Environments named `staging` and `production`:
   - No required reviewers and no wait timer.
   - Allow only `staging` to deploy to staging.
   - Allow only `main` to deploy to production.
3. Environment variables listed below.
4. Leave both repository deployment activation variables unset until their
   respective host configuration has been provisioned and reviewed.

| Environment variable | Meaning |
| --- | --- |
| TELEPORT_PROXY | Existing proxy host and port |
| TELEPORT_VERSION | Exact compatible client version, without a leading v |
| TELEPORT_JOIN_TOKEN | Non-secret name of that environment's GitHub OIDC join token |
| DEPLOY_LOGIN | Dedicated restricted Unix deployment account |
| DEPLOY_HOST | Teleport node name |
| PORTAL_URL | Public URL for the environment's deployment record |

Repository variables: `STAGING_DEPLOY_ENABLED` and `PRODUCTION_DEPLOY_ENABLED`.
Enable staging first. Enable production only after reconciling the existing
deployment and confirming its service configuration and ingress behavior.

Check available administration permissions before applying these settings.
No branch rules or environment settings have been installed by adding this file.

## Teleport access

GitHub Actions must have a dedicated Machine & Workload Identity bot. Do not copy
a personal tsh profile or expiring user certificate into GitHub secrets.

Ask the Teleport administrator to provision separate staging and production bot
identities. Restrict each GitHub join rule to the canonical repository, the
appropriate branch, the exact workflow path and environment. Use the repository's
immutable numeric ID where supported, in addition to its name.

Grant access only to the Daisugi node and a dedicated Unix login for that
environment. The login needs its own release directories and user services; it
must not inherit unrestricted sudo, Docker administration or another environment's
write access. The bot must not be able to change Teleport policy.

The deployment job alone requests an OIDC token and obtains a 15-minute SSH
certificate. It then uploads the package and invokes a preinstalled deployment
helper. No untrusted pull-request code runs in this job.

References: [Teleport GitHub Actions deployment](https://goteleport.com/docs/machine-workload-identity/machine-id/deployment/github-actions/)
and [Teleport authentication action](https://github.com/teleport-actions/auth).

## Host provisioning

The administrator provisions each environment once. Templates under
`deploy/portal/` are examples for review, not an automatic installer.

- A dedicated Unix user, a writable home, Python 3.11 or later, and Node 22.23.2
  with npm. Configure the actual absolute Node and npm CLI paths.
- A release root such as `~/staging-testnet`, owned by that user with mode 0700.
- `~/portal-incoming`, owned by that user with mode 0700.
- A reviewed copy of `scripts/portal_release.py` installed as
  `~/.local/lib/daisugi/portal_release.py`. It is updated separately from runtime
  packages; deployment does not replace its own installer.
- A mode-0600 configuration at `~/.config/daisugi/staging.json` or
  `~/.config/daisugi/production.json`, adapted from the examples.
- Private environment files outside every release and outside Git.
- The dedicated systemd user services, with user-service persistence configured.

The staging examples use loopback ports 3004 and 3005 for the portal and indexer.
These were free during preparation; check again before starting services.
Set the staging frontend's `EXPLORER_URL=http://127.0.0.1:3005` and the staging
indexer's `PORTAL_ORIGIN=http://127.0.0.1:3004`. Preserve the network, EntryPoint,
bundler and faucet account values appropriate to the existing testnet.

Staging uses the same test chain; it is an isolated application deployment, not
an isolated blockchain. The shared faucet account is retained for this testnet
phase. Its cross-process nonce limitation remains accepted.

Point the review tunnel or ingress to the staging portal, independently of the
development preview. Configure `PORTAL_URL` with the resulting URL. A temporary
tunnel URL can change after its tunnel restarts; update the deployment variable
when that happens. This pipeline does not create a public tunnel.

Production needs a separate, explicitly authorized migration plan. Existing
ports 3000 and 3001 are occupied, and the deployed checkout has local changes.
Reconcile them, preserve private configuration and ingress access, and approve
the service transition before enabling production deployment. Keep internal RPC
and bundler upstreams as documented in [DUAL-DOMAIN.md](DUAL-DOMAIN.md).

## Release format and activation

The packager reads runtime files directly from the tested Git commit. It includes
the frontend, explorer and third-party licenses, including the font binary. It
rejects symlinks, submodules, node_modules and private environment paths.

`RELEASE.json` records the source commit, complete Git source tree and SHA-256 of
every packaged file. The public `/release.json` exposes only the commit and tree.

The host verifies the archive checksum, identity, paths, sizes and file hashes.
It installs locked dependencies with lifecycle scripts disabled, prepares an
immutable release directory, and atomically switches `current` to that release.
The helper then restarts only the configured user services and checks the
running revision, chain and indexer responses.

If activation fails, it restores and checks the previous release. If there was
no previous release, it stops the new services and removes the current link.
A failed rollback is reported as requiring operator intervention. Older releases
are retained; cleanup is a separate operation. Changes to private configuration
are not rolled back by this helper.

Preview-only scripts, private configuration, installed dependencies and local
verification reports are not release inputs. Runtime services always execute
from the selected release; editing dev-testnet does not change staging.

## Initial rollout

1. Review the prepared code, tests and Git identity.
2. Authorize branch creation and the initial development commit separately from
   the exact push operation. Preserve the original checkout and development files.
3. Publish the approved dev commit and verify the actual GitHub checks.
4. Provision restricted deployment access and the staging host configuration.
5. Enable staging deployment, merge dev into staging and verify its first release.
6. Share the staging link and identify the reviewed SHA.
7. Merge staging into main when ready. Publish production only through the manual
   workflow after its host migration and enablement are explicitly approved.

The workflow, bot authentication and public staging endpoint must be verified
after provisioning; local tests cannot establish that those external integrations
have been configured correctly.
