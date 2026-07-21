# Changelog — `openrails-mcp`

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Backfilled from
git history for the versions already published to npm; entries going forward should be added in
the same commit that bumps `package.json`.

## [Unreleased]

Not yet published to npm — tracked here as work lands on `main`.

- `pay_link` (RailsFlow-open branch) and `issue_railscard` now enforce a per-call spend ceiling
  (`MCP_MAX_AMOUNT_USDC`, default 5 USDC), checked before any signing.
- Both tools now cache and replay the result of an identical retry within 5 minutes instead of
  signing a second, independent authorization.
- `issue_railscard`'s default `mode: "bearer"` now requires an explicit
  `acknowledgeBearerRisk: true` argument, since it creates a standing, anyone-with-the-link
  pull-authorization.
- Fixed the server-declared `version` string (`mcp/src/index.ts`) to match `package.json` (was
  hardcoded to `0.1.0` while `package.json` had already moved to `0.1.1`).
- Bumped the `openrails-sdk` dependency to `^0.1.2` (was `^0.1.1`).
- Fixed the documented default `OPENRAILS_HUB_ADDRESS` in `README.md` (was still showing the
  frozen V1 hub).

## [0.1.1] — 2026-07-04

- Default hub address switched to the V2 canonical hub, matching the SDK's 0.1.1 V2 republish.
- Depend on `openrails-sdk@^0.1.1`.

## [0.1.0] — 2026-07-02

- First npm publish. stdio MCP server exposing `openrails_config`, `pay_link`,
  `create_request_link`, `issue_railscard`, `paycard_status`; gasless by default via the keeper
  relay; non-custodial (signs with its own configured account only).

## Versioning & backward-compatibility policy

Same policy as [`openrails-sdk`](../sdk/CHANGELOG.md): semver in spirit, pre-1.0 (a minor bump can
still carry a behavior change — read the entries above, not just the version number). Tool *names*
are stable; argument shapes are not guaranteed stable pre-1.0 when the change is a deliberate
safety tightening — the `acknowledgeBearerRisk` requirement above is exactly that: it **is** a
breaking change for any existing caller that issues bearer-mode RailsCards without passing it, by
design (the previous behavior — a standing bearer authorization with no explicit opt-in — is the
thing being fixed). Changes like this will always get a changelog entry here calling out the break
explicitly, rather than being framed as purely additive.
