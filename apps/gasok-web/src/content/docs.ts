export type DiagramKind =
  | 'lifecycle'
  | 'protocol-runtime'
  | 'railscard'
  | 'railsflow'
  | 'nonce-lane'
  | 'stn-delta'
  | 'paycard'
  | 'workspace'
  | 'path'
  | 'baphomet'
  | 'pact'
  | 'proof'
  | 'gaia'
  | 'kernel'
  | 'clients'
  | 'network'
  | 'security'
  | 'demo';

export type DocSection = {
  id: string;
  title: string;
  body?: string[];
  callout?: string;
  properties?: Array<[string, string]>;
  code?: string;
  diagram?: DiagramKind;
  diagramCaption?: string;
};

export type DocPage = {
  slug: string;
  category: string;
  index: string;
  title: string;
  summary: string;
  status?: 'FOUNDATION' | 'LIVE' | 'REFERENCE';
  oneSentence: string;
  creates: string;
  doesNot: string;
  sections: DocSection[];
};

export const docsPages: DocPage[] = [
  {
    slug: 'overview', category: 'INTRODUCTION', index: '01', title: 'Overview', status: 'FOUNDATION',
    summary: 'OpenRails is programmable settlement infrastructure for machine commerce, extended with explicit authority, agreement, evidence, and bounded resolution.',
    oneSentence: 'OpenRails turns a commercial request into an authorised, inspectable, evidence aware settlement lifecycle.',
    creates: 'A shared system of authority, commitments, proof, settlement, and exception handling.',
    doesNot: 'Replace the wallet, take custody of keys, or treat an offchain state change as canonical settlement.',
    sections: [
      { id: 'thesis', title: 'The thesis', body: ['Software now negotiates, purchases, performs work, and coordinates economic activity continuously. Ordinary transfers remain blunt events. They can prove that value moved, but they preserve little context about the authority, limits, agreement, or evidence behind that movement.', 'OpenRails began with bounded programmable payment rails. It controls allocation, velocity, lifespan, execution order, and residual value. The Runtime extends those rails with ownership, delegated authority, commercial commitments, evidence, and bounded resolution.'] },
      { id: 'lifecycle', title: 'The complete lifecycle', diagram: 'lifecycle', diagramCaption: 'The six public verbs describe one continuous economic lifecycle. Each verb maps to a concrete OpenRails object or operation.', properties: [['Own', 'Workspace establishes economic ownership and membership.'], ['Authorise', 'Path defines what an actor or agent may prepare.'], ['Commit', 'Pact freezes accepted commercial terms.'], ['Prove', 'Evidence advances settlement eligibility.'], ['Settle', 'RailsFlow, Paycard, STN-Delta, and the Vault route value.'], ['Resolve', 'Gaia handles bounded exception and rectification paths.']] },
      { id: 'boundaries', title: 'Three execution boundaries', callout: 'The Runtime coordinates. The wallet authorises. The network finalises.', body: ['The Runtime evaluates, prepares, persists, and observes. It does not possess a private key. Wallet signatures establish authority and approve financial actions. The deployed protocol and confirmed receipts preserve canonical financial state.'], diagram: 'security', diagramCaption: 'No layer silently impersonates another. The boundaries remain visible in the product and in the audit trail.' },
      { id: 'current-proof', title: 'What the current System Lab proves', body: ['The GIWA vertical slice demonstrates a safe operational path from a signed Workspace and Path to a 420 orUSD proposal, an ALLOW decision, Pact formation, Proof, Paycard preparation, and settlement. It also demonstrates the negative control: a 1,420 orUSD proposal is blocked before Pact formation, wallet confirmation, or value movement.'], diagram: 'demo', diagramCaption: 'The permitted route and blocked route prove both execution and prevention.' }
    ]
  },
  {
    slug: 'why-openrails', category: 'INTRODUCTION', index: '02', title: 'Why OpenRails', status: 'FOUNDATION',
    summary: 'Machine commerce needs something between no authority and unlimited wallet authority.',
    oneSentence: 'OpenRails makes payment authority granular enough for software while keeping ownership and confirmation explicit.',
    creates: 'Bounded rails that software can use without receiving unrestricted wallet power.',
    doesNot: 'Assume that a wallet approval explains the commercial reason for every later transfer.',
    sections: [
      { id: 'ordinary-payments', title: 'The limitation of ordinary payments', body: ['A conventional payment usually answers one question: did value move from one address to another? It often does not answer who delegated the action, which limits applied, which agreement was accepted, which evidence justified settlement, or how unused value should return.', 'That gap becomes serious when software and agents act repeatedly. A broad approval can be technically valid while remaining economically unsafe.'] },
      { id: 'bounded-rails', title: 'The original OpenRails answer', diagram: 'railscard', diagramCaption: 'A macro budget is separated from each micro settlement action.', properties: [['Allocation', 'The maximum value committed to a rail.'], ['Velocity', 'How quickly value can become earned or drawable.'], ['Expiry', 'When delegated payment authority ends.'], ['Nonce lane', 'An isolated execution sequence for the activity.'], ['Residual', 'Where unused value returns.']] },
      { id: 'accountability', title: 'Why rails need a Runtime', body: ['Programmable movement is necessary but insufficient. A rail still needs to know who owns the activity, who may act, what commitment formed, what evidence supports performance, and which exception rules apply.', 'The Runtime does not replace the settlement protocol. It provides the commercial control and accountability layer around it.'], diagram: 'protocol-runtime', diagramCaption: 'Clients reach the Runtime. The Runtime contextualises access to the Protocol. The network preserves canonical evidence.' }
    ]
  },
  {
    slug: 'architecture', category: 'INTRODUCTION', index: '03', title: 'System architecture', status: 'REFERENCE',
    summary: 'The Protocol moves value. The Runtime controls and contextualises access to that movement. Clients expose the system.',
    oneSentence: 'OpenRails is one system with separate settlement, control, client, wallet, and network responsibilities.',
    creates: 'A composable architecture that can support web, Telegram, MCP, SDK, and later dashboard clients.',
    doesNot: 'Make any single frontend or sidecar the entire product.',
    sections: [
      { id: 'whole-system', title: 'The complete stack', diagram: 'protocol-runtime', diagramCaption: 'The architecture is layered so that commercial logic can evolve without weakening the wallet and network boundaries.' },
      { id: 'protocol', title: 'OpenRails Protocol', properties: [['RailsCard', 'Macro allocation and bounded payment authority.'], ['RailsFlow', 'Typed intent for one programmable value movement.'], ['Paycard', 'Canonical per-payment financial object.'], ['Vault', 'Custody and accounting boundary.'], ['STN-Delta', 'Earned and residual routing.'], ['Receipts', 'Network evidence that closes canonical transitions.']] },
      { id: 'runtime', title: 'OpenRails Runtime', properties: [['Workspace', 'Economic ownership and membership.'], ['Path', 'Delegated authority boundary.'], ['Proposal', 'A requested action.'], ['Baphomet', 'Deterministic policy evaluation.'], ['Pact', 'Commercial commitment.'], ['Proof', 'Evidence and checkpoint state.'], ['Gaia', 'Bounded exception handling.']] },
      { id: 'clients', title: 'OpenRails clients', body: ['The System Lab is the guided proof surface. The future personal dashboard is the operating surface. Telegram is a conversational sidecar. SDK, MCP, and REST expose application and agent integration. They all operate on the same object model and boundaries.'], diagram: 'clients', diagramCaption: 'Different clients provide different interaction modes without fragmenting the underlying product.' }
    ]
  },
  {
    slug: 'railscard', category: 'SETTLEMENT PROTOCOL', index: '04', title: 'RailsCard', status: 'REFERENCE',
    summary: 'RailsCard is the macro authority envelope that limits how much value a session or rail may use.',
    oneSentence: 'RailsCard converts a broad wallet balance into a bounded economic budget.',
    creates: 'A reusable authority envelope with asset, amount, duration, and counterparty limits.',
    doesNot: 'Describe one exact payment or independently broadcast a transaction.',
    sections: [
      { id: 'definition', title: 'What it is', body: ['RailsCard is the macro authorisation layer. It commits a maximum budget and policy envelope without granting an application unrestricted access to the owner wallet.', 'An individual RailsFlow consumes authority within that envelope. This separation allows a wallet owner to define broad session limits once, then authorise smaller typed actions inside those limits.'], diagram: 'railscard', diagramCaption: 'The macro budget and micro action are related, but they are not the same object.' },
      { id: 'fields', title: 'Typical authority fields', properties: [['Owner', 'The wallet or principal granting authority.'], ['Asset', 'The token or settlement asset covered.'], ['Budget', 'The maximum aggregate value available.'], ['Expiry', 'The deterministic end of the authority period.'], ['Counterparty scope', 'Which recipients or classes may receive value.'], ['Session key or actor', 'The bounded actor that may prepare or execute permitted actions.']] },
      { id: 'relationship', title: 'Relationship to RailsFlow', callout: 'RailsCard is macro authority. RailsFlow is one exact micro settlement intent.', body: ['A RailsFlow should fail when it exceeds the remaining RailsCard allocation, uses an unapproved asset, targets an excluded counterparty, or falls outside the authority window.'] }
    ]
  },
  {
    slug: 'railsflow', category: 'SETTLEMENT PROTOCOL', index: '05', title: 'RailsFlow', status: 'LIVE',
    summary: 'RailsFlow is a wallet-signed, bounded settlement intent that describes one exact programmable value movement.',
    oneSentence: 'RailsFlow tells the protocol who may receive value, how much, under which timing and replay constraints.',
    creates: 'Typed, reviewable micro authority for one Paycard or payment rail.',
    doesNot: 'Become a transaction before a wallet signs and broadcasts the corresponding action.',
    sections: [
      { id: 'definition', title: 'What it is', body: ['RailsFlow is the micro authorisation layer for an individual programmable payment. It binds the payer, recipient, Paycard identity, allocation, timing, nonce lane, nonce, and settlement metadata.', 'The intent is designed to be inspectable before the transaction. The user can see which financial object will open and which constraints will govern it.'], diagram: 'railsflow', diagramCaption: 'Preparation, signing, and canonical execution are separate steps.' },
      { id: 'fields', title: 'Core fields', code: `{
  payer,
  recipient,
  paycardId,
  allocation,
  startsAt,
  expiresAt,
  nonceLane,
  nonce,
  metadataHash
}` },
      { id: 'validation', title: 'What must be validated', properties: [['Signer', 'The signature must resolve to the authorised payer or account.'], ['Domain', 'Chain ID, contract, name, and version must match the intended deployment.'], ['Time', 'The intent must be inside its valid start and expiry window.'], ['Nonce', 'The lane and sequence must not have been consumed.'], ['Allocation', 'The requested value must remain inside all macro and Path limits.'], ['Metadata', 'The intent must bind to the expected Pact and commercial context.']] },
      { id: 'boundary', title: 'What it cannot do', callout: 'A prepared RailsFlow is not a transaction.', body: ['The Runtime may prepare typed data and verify its structure. Only the wallet can sign it. Only an authorised account can broadcast the corresponding transaction.'] }
    ]
  },
  {
    slug: 'nonce-lanes', category: 'SETTLEMENT PROTOCOL', index: '06', title: '2D nonce lanes and velocity', status: 'REFERENCE',
    summary: 'Nonce lanes isolate concurrent activities while velocity limits constrain how quickly each rail may draw or earn value.',
    oneSentence: 'The first dimension selects an activity lane. The second dimension advances the sequence inside that lane.',
    creates: 'Concurrent execution without forcing unrelated activities through one global nonce sequence.',
    doesNot: 'Remove the need for replay protection, expiry checks, or value limits.',
    sections: [
      { id: 'two-dimensions', title: 'Why two dimensions', body: ['A traditional sequential nonce can make unrelated automated activities block one another. OpenRails separates the activity lane from the sequence inside that lane.', 'Lane 04 can advance through sequence 0, 1, 2, and 3 while another workflow advances independently in lane 02. Each signed intent still binds to its exact lane and sequence.'], diagram: 'nonce-lane', diagramCaption: 'The grid visualises lane selection vertically and sequence advancement horizontally.' },
      { id: 'velocity', title: 'Velocity control', body: ['Velocity limits constrain the rate at which value becomes drawable, earned, or settled. A rail may have sufficient total allocation and still reject an action that attempts to draw too much within the current time window.'], properties: [['Allocation ceiling', 'Maximum total value available to the rail.'], ['Per interval ceiling', 'Maximum value that may advance during a block or time window.'], ['Elapsed time', 'The time delta used to calculate current eligibility.'], ['Expiry', 'The point after which no further draw is permitted.']] },
      { id: 'security', title: 'Replay and concurrency safety', callout: 'Isolation is not permission. Every lane still inherits the wallet, RailsCard, Path, and Pact boundaries.', body: ['A reused sequence, wrong lane, wrong chain, expired intent, or mismatched metadata must fail even when the underlying signature is otherwise valid.'] }
    ]
  },
  {
    slug: 'stn-delta', category: 'SETTLEMENT PROTOCOL', index: '07', title: 'STN-Delta', status: 'REFERENCE',
    summary: 'STN-Delta separates earned value from unused residual value and routes each side deterministically.',
    oneSentence: 'STN-Delta ensures that only earned value moves forward while unused value returns safely.',
    creates: 'A deterministic split between recipient earnings and payer residual.',
    doesNot: 'Decide whether performance occurred without the Pact and Proof policy.',
    sections: [
      { id: 'model', title: 'The routing model', body: ['A 420 orUSD allocation does not imply that the recipient must receive all 420. The amount earned depends on the bound schedule, performance conditions, settlement horizon, and verified evidence.', 'At closure, STN-Delta routes the earned amount to the recipient and the unused residual back to the payer or configured residual destination.'], diagram: 'stn-delta', diagramCaption: 'The example shows a symmetric split for clarity. Real values are calculated from the bound economics and observed state.' },
      { id: 'inputs', title: 'Inputs to the split', properties: [['Allocation', 'The maximum value committed.'], ['Elapsed time', 'How much of the earning window has passed.'], ['Velocity', 'The maximum earning or draw rate.'], ['Proof state', 'Which checkpoints are eligible or approved.'], ['Settlement policy', 'The exact formula and closure conditions.'], ['Residual destination', 'Where unused value returns.']] },
      { id: 'invariant', title: 'Conservation invariant', callout: 'Earned value plus residual value must reconcile to the value governed by the Paycard, subject only to explicit protocol fees.', body: ['The user interface should show the split, the formula inputs, and the receipt evidence so that the final routing is explainable rather than opaque.'] }
    ]
  },
  {
    slug: 'paycard', category: 'SETTLEMENT PROTOCOL', index: '08', title: 'Paycard', status: 'LIVE',
    summary: 'Paycard is the canonical per-payment financial object that tracks allocation, earning, settlement, and termination.',
    oneSentence: 'Paycard is the onchain financial state created when an authorised RailsFlow opens a rail.',
    creates: 'A canonical object that can be observed, settled, and closed through exact contract events.',
    doesNot: 'Explain the full commercial reason for the payment without its Workspace, Path, proposal, Pact, and Proof bindings.',
    sections: [
      { id: 'states', title: 'Paycard lifecycle', diagram: 'paycard', diagramCaption: 'The browser may project future states, but canonical advancement requires the corresponding contract event and receipt.', properties: [['Prepared', 'Terms exist but no canonical financial object has opened.'], ['Active', 'Allocation has entered the deployed rail.'], ['Earning', 'Value becomes eligible according to schedule and policy.'], ['Settled', 'Earned value has been routed.'], ['Terminated', 'Residual value has been handled and the rail is closed.']] },
      { id: 'identity', title: 'Paycard identity', body: ['A Paycard ID should be deterministically bound to the payer, recipient, allocation context, nonce lane, metadata, and deployment domain. This prevents a receipt from being attached to the wrong commercial object.'] },
      { id: 'receipt', title: 'Canonical evidence', body: ['OpenRails does not treat a browser state transition as settlement. The Runtime observes the exact contract, event, chain, transaction hash, block number, and receipt status before advancing canonical financial state.'], callout: 'A live Paycard state is a network fact, not a frontend animation.' }
    ]
  },
  {
    slug: 'vault', category: 'SETTLEMENT PROTOCOL', index: '09', title: 'Vault and custody boundary', status: 'LIVE',
    summary: 'The Vault is the deployed custody and accounting boundary beneath Paycards and settlement operations.',
    oneSentence: 'The Vault holds and accounts for value while Paycards express the state of individual rails.',
    creates: 'A single canonical accounting boundary for allocations, claims, settlement, and residual return.',
    doesNot: 'Take custody of user private keys or hide token approvals from the wallet.',
    sections: [
      { id: 'role', title: 'What the Vault does', body: ['The Vault receives approved assets, associates them with the relevant Paycard or rail, enforces protocol accounting, and routes settlement outputs according to the deployed rules.', 'The owner still approves token movement through the wallet. The Runtime can prepare the action, but it cannot silently approve or transfer the user asset.'] },
      { id: 'relationship', title: 'Relationship to Paycard', properties: [['Paycard', 'The financial state and identity of one bounded rail.'], ['Vault', 'The custody and accounting boundary that holds or routes the associated value.'], ['Hub or master contract', 'The orchestration and validation surface for protocol actions.'], ['Receipt', 'The network evidence that confirms the resulting state transition.']] },
      { id: 'audit', title: 'What an audit view should show', properties: [['Asset and amount', 'Exact token, decimals, and allocation.'], ['Source', 'The payer or funding account.'], ['Paycard ID', 'The financial object receiving the allocation.'], ['Events', 'Opening, earning, settlement, and termination events.'], ['Balances', 'Reconciled earned, residual, and protocol fee values.']] }
    ]
  },
  {
    slug: 'workspace-path', category: 'CONTROL RUNTIME', index: '10', title: 'Workspace and Path', status: 'REFERENCE',
    summary: 'Workspace establishes ownership. Path defines what an actor or agent may prepare inside that ownership boundary.',
    oneSentence: 'Workspace says who owns the activity. Path says what a delegated actor may do.',
    creates: 'An explicit principal and a versioned authority boundary for each actor or agent.',
    doesNot: 'Move funds or guarantee that every permitted proposal will become a Pact.',
    sections: [
      { id: 'workspace', title: 'Workspace', body: ['A Workspace anchors the principal, members, applications, agents, and administrative roles. It is the root of economic ownership for activity represented inside OpenRails.', 'The Workspace is signed and versioned so that later Path, proposal, Pact, and Proof objects can bind to the correct authority domain.'], diagram: 'workspace', diagramCaption: 'Actors and clients connect to one economic ownership boundary rather than operating as unrelated wallet addresses.' },
      { id: 'path', title: 'Path', body: ['A Path is a signed, versioned delegation. It defines which actor may propose which action, for which asset and counterparty, within which exposure, velocity, concurrency, and duration limits.'], diagram: 'path', diagramCaption: 'The Path is evaluated before the request reaches commitment or settlement.' },
      { id: 'fields', title: 'Core Path controls', properties: [['Action', 'Which operation may be proposed.'], ['Asset', 'Which settlement asset is permitted.'], ['Counterparty', 'Which party or class is allowed.'], ['Per Pact exposure', 'Maximum value in one commitment.'], ['Aggregate exposure', 'Maximum active value across commitments.'], ['Velocity', 'Maximum draw or earning rate.'], ['Duration', 'Maximum authority and commitment horizon.'], ['Revision', 'The exact signed version evaluated.']] },
      { id: 'not-payment', title: 'Important distinction', callout: 'A Path does not move funds. It determines whether a proposal may proceed toward a Pact and wallet action.' }
    ]
  },
  {
    slug: 'baphomet', category: 'CONTROL RUNTIME', index: '11', title: 'Proposal and Baphomet', status: 'REFERENCE',
    summary: 'A proposal requests an action. Baphomet evaluates that exact request against assigned authority and current economic state.',
    oneSentence: 'Baphomet converts a proposed action into an explainable ALLOW or BLOCK result.',
    creates: 'A deterministic decision bound to the exact proposal, Path revision, and state evaluated.',
    doesNot: 'Sign a wallet action, form a Pact automatically, or move value.',
    sections: [
      { id: 'proposal', title: 'Proposal', body: ['A proposal is a request, not authority. It identifies the Workspace, actor, Path, action, asset, value, counterparty, duration, and any action specific parameters.'], code: `{
  workspaceId,
  agentId,
  pathId,
  action,
  asset,
  value,
  counterparty,
  duration
}` },
      { id: 'evaluation', title: 'Evaluation', diagram: 'baphomet', diagramCaption: 'Every decision should expose the checks and reason codes that produced it.' },
      { id: 'decision', title: 'Decision semantics', properties: [['ALLOW', 'The proposal may proceed toward commitment. No value has moved.'], ['BLOCK', 'The proposal stops before Pact formation, wallet request, or value movement.'], ['Decision hash', 'Binds the exact inputs, checks, result, and state.'], ['Reason codes', 'Explain which rule passed or failed.']] },
      { id: 'binding', title: 'Deterministic binding', body: ['The decision binds to the Workspace, actor, Path revision, proposal hash, reason codes, and current economic state. A later Pact must refer to the same decision. ALLOW cannot be reused for a modified amount or counterparty.'] }
    ]
  },
  {
    slug: 'pact', category: 'CONTROL RUNTIME', index: '12', title: 'Pact', status: 'REFERENCE',
    summary: 'A Pact freezes the exact commercial commitment accepted by the participating parties.',
    oneSentence: 'Pact converts a permitted request into a signed commitment with evidence, settlement, and exception terms.',
    creates: 'A durable commercial object that later Proof and settlement actions can reference.',
    doesNot: 'Act as custody or independently move value.',
    sections: [
      { id: 'formation', title: 'How a Pact forms', body: ['A Pact may form only after a proposal receives ALLOW. It copies the exact permitted commercial terms, adds proof and exception policies, and collects the required party signatures.', 'If any material field changes, a new proposal and decision should be required. This prevents a party from using an earlier ALLOW decision to justify different economics.'] },
      { id: 'contents', title: 'What a Pact contains', properties: [['Parties', 'The principals or authorised actors bound to the commitment.'], ['Terms', 'Value, duration, recipient, asset, and performance terms.'], ['Proof policy', 'The evidence and checkpoints required.'], ['Settlement policy', 'How eligible value may settle.'], ['Exception policy', 'How a bounded Gaia process may begin.'], ['Bindings', 'Workspace, Path, proposal, and decision hashes.']] },
      { id: 'binding-chain', title: 'Binding chain', diagram: 'pact', diagramCaption: 'The Pact is the signed point where authority, request, decision, and exact terms converge.', code: `pathHash
  → proposalHash
  → decisionHash
  → pactTermsHash
  → party signatures` },
      { id: 'boundary', title: 'What a Pact is not', callout: 'A Pact is not itself custody and does not independently move value.', body: ['The Pact authorises the commercial context. The wallet and Protocol still control the financial action.'] }
    ]
  },
  {
    slug: 'proof-gaia', category: 'CONTROL RUNTIME', index: '13', title: 'Proof and Gaia', status: 'REFERENCE',
    summary: 'Proof makes performance inspectable. Gaia preserves and resolves bounded exception paths.',
    oneSentence: 'Proof evaluates evidence against the Pact. Gaia handles the exception path defined by that same Pact.',
    creates: 'Verifiable checkpoint state and a bounded rectification process when normal execution fails.',
    doesNot: 'Let an arbitrary verifier or judge rewrite commercial history or seize unrestricted funds.',
    sections: [
      { id: 'proof', title: 'Proof', body: ['Evidence is attached to Pact checkpoints and evaluated by the configured verifier. Evidence may include a signed claim, a network receipt, a delivery record, an API result, or another source allowed by the Pact.', 'A verified checkpoint may advance settlement eligibility. It does not bypass the wallet or deployed contract boundary.'], diagram: 'proof', diagramCaption: 'Evidence is verified for source, integrity, Pact binding, and policy compliance before eligibility advances.' },
      { id: 'checkpoint-state', title: 'Checkpoint state', properties: [['Pending', 'Evidence has not been submitted or evaluated.'], ['Submitted', 'An evidence bundle is attached.'], ['Verified', 'The configured verifier accepted the evidence.'], ['Rejected', 'The evidence failed a rule or binding check.'], ['Eligible value', 'The value unlocked by the verified checkpoint policy.']] },
      { id: 'gaia', title: 'Gaia', body: ['Gaia is not an unrestricted autonomous judge. It operates inside the dispute, evidence, timing, and rectification rules already bound to the Pact.', 'A Gaia case should preserve the entire lifecycle record and produce an explicit determination with bounded obligations.'], diagram: 'gaia', diagramCaption: 'Normal and exception paths share the same immutable commercial history.' },
      { id: 'normal-exception', title: 'Normal and exception paths', properties: [['Normal', 'Pact to Proof to wallet confirmation to settlement receipt.'], ['Exception', 'Pact to evidence bundle to Gaia determination to bounded rectification obligation.']] }
    ]
  },
  {
    slug: 'agent-kernel', category: 'BUILD', index: '14', title: 'Agent Kernel', status: 'REFERENCE',
    summary: 'The Agent Kernel coordinates Workspace, agent, Path, proposal, Pact, Proof, plugin, observation, and Gaia state.',
    oneSentence: 'The Kernel is the backend control runtime, not a wallet or autonomous custodian.',
    creates: 'A typed, persistent, auditable coordination layer for commercial state.',
    doesNot: 'Accept raw private keys, silently sign, or broadcast transactions.',
    sections: [
      { id: 'architecture', title: 'Kernel architecture', diagram: 'kernel', diagramCaption: 'Clients call a bounded gateway. The Kernel coordinates state. Wallet and network actions remain outside the signing boundary.' },
      { id: 'responsibilities', title: 'Responsibilities', body: ['The Agent Kernel prepares typed authority objects, evaluates proposals, persists commercial state, coordinates proof plugins, records canonical observations, and exposes bounded operator interfaces.', 'Its stores and APIs should make every material transition reconstructable from signed objects, decision outputs, evidence, and receipt observations.'] },
      { id: 'modules', title: 'Core modules', properties: [['Action registry', 'Defines supported actions and their typed requirements.'], ['Baphomet evaluator', 'Evaluates proposals against policy and state.'], ['Pact state machine', 'Controls commitment formation and transitions.'], ['Plugin registry', 'Installs and resolves evidence verifiers.'], ['GIWA observer', 'Verifies exact contracts, events, and receipts.'], ['Gaia state', 'Records bounded exception and rectification operations.']] },
      { id: 'security', title: 'Security posture', callout: 'No private keys. No autonomous signing. No hidden broadcast.', body: ['The public web gateway exposes a narrow same-origin subset of Kernel operations. Mutations require a wallet-authenticated session and exact signed payloads.'] }
    ]
  },
  {
    slug: 'clients', category: 'BUILD', index: '15', title: 'Clients and sidecars', status: 'REFERENCE',
    summary: 'The web app, dashboard, Telegram sidecar, SDK, MCP, and REST interfaces are clients of one OpenRails system.',
    oneSentence: 'Each client changes how a user interacts, not what OpenRails means.',
    creates: 'Multiple interaction modes over one canonical commercial and settlement model.',
    doesNot: 'Make Telegram, the System Lab, or any single interface the whole product.',
    sections: [
      { id: 'model', title: 'One system, many clients', diagram: 'clients', diagramCaption: 'Every client reads and prepares the same OpenRails objects. The wallet and network boundaries remain consistent.' },
      { id: 'surfaces', title: 'Product surfaces', properties: [['Homepage', 'Tells the complete OpenRails story.'], ['System Lab', 'Guides and proves one complete lifecycle.'], ['Personal dashboard', 'Operates the user account, Workspaces, Paths, Pacts, Proof, payments, and Gaia cases.'], ['Telegram sidecar', 'Creates requests and reports state conversationally.'], ['Docs', 'Explains concepts, integrations, and security boundaries.']] },
      { id: 'integration', title: 'Integration interfaces', properties: [['SDK', 'Typed application code and wallet-ready drafts.'], ['MCP', 'Agent-readable state and safe action preparation.'], ['REST', 'Bounded service integration.'], ['Events', 'Activity, decisions, proof, settlement, and receipt updates.']] },
      { id: 'telegram', title: 'Telegram as one vertical', callout: 'Telegram is a sidecar, not the product.', body: ['A user may propose an action, inspect a Path, submit evidence, or request status in chat. The complete visual state, audit history, wallet confirmation, and canonical receipts remain accessible through the web product.'] }
    ]
  },
  {
    slug: 'demo-walkthrough', category: 'BUILD', index: '16', title: 'System Lab walkthrough', status: 'LIVE',
    summary: 'The System Lab demonstrates one permitted OpenRails lifecycle and one blocked negative control.',
    oneSentence: 'The demo proves both that OpenRails can settle an authorised action and that it can stop an unauthorised one before value movement.',
    creates: 'A judge-ready, inspectable proof of the Runtime, wallet boundary, and deployed settlement protocol.',
    doesNot: 'Represent every future dashboard workflow or every production integration.',
    sections: [
      { id: 'routes', title: 'Two acceptance routes', diagram: 'demo', diagramCaption: 'The negative control is as important as the successful route because it proves prevention.' },
      { id: 'allowed', title: 'Permitted route', properties: [['Connect and authenticate', 'The wallet signs a session challenge.'], ['Initialize authority', 'Workspace, Agent, plugin, and Path are signed and registered.'], ['Propose 420 orUSD', 'The action is inside the 1,000 orUSD ceiling.'], ['Baphomet ALLOW', 'The exact proposal may proceed.'], ['Pact and Proof', 'Terms are signed and evidence becomes settlement eligible.'], ['Open and settle', 'The wallet approves and broadcasts the GIWA actions.'], ['Observe receipts', 'The Runtime verifies canonical contract events.']] },
      { id: 'blocked', title: 'Blocked route', properties: [['Propose 1,420 orUSD', 'The action exceeds the active Path ceiling.'], ['Baphomet BLOCK', 'The decision exposes the failed value rule.'], ['No Pact', 'The commercial commitment never forms.'], ['No wallet request', 'The user is not asked to approve or sign a financial action.'], ['No value moved', 'The settlement protocol is never reached.']] },
      { id: 'provenance', title: 'Provenance', callout: 'DEMONSTRATION, RECORDED, and LIVE must remain visually distinct.', body: ['A demonstration state explains the system. A recorded state replays previously captured real evidence. A live state is a current network read, wallet action, or confirmed receipt.'] }
    ]
  },
  {
    slug: 'networks', category: 'NETWORK', index: '17', title: 'Networks and deployment', status: 'LIVE',
    summary: 'OpenRails is network portable. The product language remains stable while deployment evidence comes from each configured network.',
    oneSentence: 'One OpenRails design and object model can operate across GIWA and later compatible networks.',
    creates: 'A network adapter layer for chain identity, assets, contracts, events, and receipts.',
    doesNot: 'Fork the product story, colors, primitives, or information architecture for every chain.',
    sections: [
      { id: 'portable-core', title: 'Portable core', body: ['Workspace, Path, proposal, Pact, Proof, RailsCard, RailsFlow, Paycard, settlement, and resolution are OpenRails concepts. They must remain stable across networks.', 'A network deployment supplies chain identity, RPC connectivity, assets, contracts, events, and explorer evidence.'], diagram: 'network', diagramCaption: 'The portable core remains constant while the deployment adapter changes.' },
      { id: 'adapter', title: 'Network adapter', properties: [['Identity', 'Name, chain ID, and native gas symbol.'], ['Connectivity', 'RPC and explorer URLs.'], ['Assets', 'Settlement assets and decimals.'], ['Contracts', 'Factory, hub, vault, faucet, and related addresses.'], ['Evidence', 'Events, receipts, block status, and provenance links.'], ['Wallet hints', 'Network switching and gas requirements.']] },
      { id: 'current', title: 'Current demonstrator', callout: 'The current live System Lab is configured for GIWA Sepolia.', body: ['Later compatible networks reuse the same design system, docs structure, lifecycle language, Runtime concepts, and dashboard components through separate deployment adapters.'] }
    ]
  },
  {
    slug: 'security', category: 'SECURITY', index: '18', title: 'Trust and wallet boundary', status: 'REFERENCE',
    summary: 'OpenRails coordinates commercial state without taking custody of user keys or treating offchain state as canonical settlement.',
    oneSentence: 'The Runtime can prepare and verify, the wallet signs, and the network finalises.',
    creates: 'Explicit trust boundaries and reconstructable evidence for every material transition.',
    doesNot: 'Hide signing, custody, replay, network, or verifier assumptions.',
    sections: [
      { id: 'boundaries', title: 'Trust boundaries', diagram: 'security', diagramCaption: 'Each layer has a narrow responsibility and an explicit handoff.' },
      { id: 'wallet', title: 'Wallet boundary', body: ['Authority signatures, Pact signatures, token approvals, RailsFlow signatures, Paycard opening, and settlement transactions remain visible wallet actions.', 'The user should be able to inspect the chain, contract, asset, amount, recipient, expiry, and relevant metadata before signing.'] },
      { id: 'runtime', title: 'Runtime boundary', body: ['The Runtime may prepare, validate, persist, evaluate, and observe. It must refuse raw private keys and must not silently sign or broadcast.', 'A wallet-authenticated session proves control of an address for bounded API operations. It does not give the server authority to execute financial transactions.'] },
      { id: 'network', title: 'Canonical boundary', body: ['Financial state advances only after exact network and contract verification. The observer must check chain ID, contract address, event signature, transaction status, block number, and object binding.'], callout: 'A frontend success message is not canonical settlement.' },
      { id: 'provenance', title: 'Provenance labels', properties: [['DEMONSTRATION', 'Curated explanatory state with no claim of a live transaction.'], ['RECORDED', 'Replay backed by previously captured real evidence.'], ['LIVE', 'Current network read, wallet action, or confirmed receipt.']] }
    ]
  }
];

export const docCategories = Array.from(new Set(docsPages.map((page) => page.category)));
export const defaultDoc = docsPages[0];
