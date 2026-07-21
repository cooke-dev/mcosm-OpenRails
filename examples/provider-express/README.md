# OpenRails Agent — provider Express example

Part of the OpenRails Agent application layer (`docs/agent/README.md`) — not the core rail.

This example shows the provider side of a payable service:

```text
register surface → protect route with OpenRails middleware → serve result only after verify_session
```

## Files

```text
examples/provider-express/
├── server.ts            # surface manifest + middleware-protected paid route
├── register-surface.ts  # emits POST payload for /api/provider/register
└── README.md
```

## Surface

The example exports `premiumResearchSurface`:

```text
surfaceId: provider.premium-research
scope: premium.research.read
settlementChain: arc-testnet
pricing: 0.01 USDC/sec, max 300s
primitives: railsflow, railscard_bearer
```

## Register with OpenRails Agent runtime

```ts
import { registerPremiumResearchSurface } from './server';

const registration = registerPremiumResearchSurface({
  providerId: 'research.provider.or',
  registerEndpoint: 'https://agent.example/api/provider/register',
});
```

The returned payload is ready to POST:

```text
POST /api/provider/register
content-type: application/json

{ providerId, manifest }
```

## Protect a paid route

```ts
import { createProviderExampleApp } from './server';

const app = createProviderExampleApp({
  verifyEndpoint: 'https://agent.example/api/provider/verify-session',
});

// Express-style route:
// expressApp.get('/premium/research', app.handlePremiumResearch)
```

Behavior:

```text
missing sessionId      -> 402 openrails_session_required
invalid/stale session  -> 402/403 openrails_session_required
valid session          -> 200 paid result + receipt fields
verify endpoint down   -> 503 fail closed
```

## Test

```bash
npx hardhat test test/agent/OpenRailsProviderExample.test.ts
```
