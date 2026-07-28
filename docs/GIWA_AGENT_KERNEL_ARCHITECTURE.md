# GIWA Agent Kernel Architecture

The backend is a modular monolith: Workspace and Agent registry, Path policy, immutable Pact terms plus mutable Pact state, Baphomet evaluation, Proof plugins, canonical OpenRails observations, and Gaia.

## Binding chain

`Path hash -> Proposal hash -> Baphomet decision hash -> Pact terms hash -> OpenRails metadata hash -> Paycard ID`

Pact terms contain the parties, approved Proposal and decision commitments, commercial/payment terms, and evidence/dispute policies. Lifecycle fields such as status, timestamps, payment observations, and checkpoints do not change the signed `termsHash`.

## Financial truth

Adapters may prepare unsigned RailsFlows. Only the kernel can mark a Pact active or settled, and only after an injected chain verifier proves the canonical GIWA receipt, canonical vault target, exact event fields, and current Paycard registry state.
