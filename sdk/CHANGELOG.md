# Changelog — `openrails-sdk`

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Backfilled from
git history for the versions already published to npm; entries going forward should be added in
the same commit that bumps `package.json`.

## [Unreleased]

Not yet published to npm — tracked here as work lands on `main`.

- CLI `--help` is now genuinely per-command (real flags for each of the 6 commands, not a generic
  suffix).
- `buildOpenRailsDomain` now warns (does not block) if the EIP-712 domain `version` looks
  mismatched against a known deployed hub address — an earlier, friendlier signal than waiting for
  the on-chain signature check to reject it.
- `account.ts`'s docblock corrected: EIP-1271 smart-account signatures are supported by the V2 Hub
  today (previously said "deferred to V2").

## [0.1.2] — 2026-07-04

- CLI network config now defaults to Arc-testnet-V2 (chain id, RPC, hub, USDC address) — previously
  required explicit flags/env for every value; now only a signer key is required.
- Added `GETTING_STARTED.md` with a real runnable quickstart per integration path.

## [0.1.1] — 2026-07-04

- V2 republish: default EIP-712 domain version bumped to `2.0.0` to match the V2 Hub's
  cross-version replay guard (`SignatureChecker.isValidSignatureNow`, EOA + EIP-1271). The frozen
  V1 Hub still verifies under domain version `1.0.0` — pass it explicitly if targeting V1 (not
  recommended; V1 no longer accepts new opens).

## [0.1.0] — 2026-06-30

- First npm publish. Packaged the SDK (`LeptonOpenRailsClient`, gasless helpers, pluggable
  `adapters/*`) as `openrails-sdk`, plus the `openrails` CLI bin.

## Versioning & backward-compatibility policy

`openrails-sdk` follows semver in spirit, pre-1.0 (breaking changes may still land on a minor
version bump per semver's own pre-1.0 carve-out — read every entry above, not just the version
number, before upgrading). Two patterns already in the code are the intentional policy, not
accidents of two examples:

- **Deprecated aliases are kept, not deleted.** `OpenRailsArcClient` (`sdk/src/client.ts`) is a
  type + value alias for `LeptonOpenRailsClient`, kept so code written against the earlier name
  keeps compiling. New code should use `LeptonOpenRailsClient`.
- **Env var fallbacks are kept, not deleted.** The CLI's `readPrivateKeyFromEnv` falls back from
  `OPENRAILS_PAYER_PRIVATE_KEY` (current) to `OPENRAILS_PRIVATE_KEY` (legacy) so an existing
  deployment's env doesn't silently break on upgrade.
- **A default value change (e.g. the domain version bump in 0.1.1) is a minor bump, not a patch** —
  it changes what a caller gets with no explicit override, even though no function signature
  changed.

When in doubt: prefer adding a new default-off parameter over changing an existing default: prefer
keeping an old name as an alias over removing it; and record the reasoning here, not just the
version number.
