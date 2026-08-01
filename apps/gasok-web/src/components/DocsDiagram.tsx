import { motion, useReducedMotion } from 'framer-motion';
import type { DiagramKind } from '../content/docs';

type NodeProps = {
  eyebrow?: string;
  title: string;
  detail?: string;
  tone?: 'light' | 'dark' | 'signal';
  className?: string;
};

function Node({ eyebrow, title, detail, tone = 'light', className = '' }: NodeProps) {
  return (
    <div className={`docs-diagram-node ${tone} ${className}`}>
      {eyebrow && <span>{eyebrow}</span>}
      <strong>{title}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Arrow({ label, vertical = false }: { label?: string; vertical?: boolean }) {
  return (
    <div className={`docs-diagram-arrow ${vertical ? 'vertical' : ''}`} aria-hidden="true">
      <i />
      {label && <span>{label}</span>}
    </div>
  );
}

function LifecycleDiagram() {
  const items = [
    ['01', 'OWN', 'Workspace'],
    ['02', 'AUTHORISE', 'Path'],
    ['03', 'COMMIT', 'Pact'],
    ['04', 'PROVE', 'Proof'],
    ['05', 'SETTLE', 'Rail'],
    ['06', 'RESOLVE', 'Gaia'],
  ];
  return (
    <div className="diagram-lifecycle">
      {items.map(([index, title, detail], itemIndex) => (
        <div className="diagram-lifecycle-item" key={title}>
          <Node eyebrow={index} title={title} detail={detail} tone={itemIndex === 4 ? 'signal' : 'light'} />
          {itemIndex < items.length - 1 && <Arrow />}
        </div>
      ))}
    </div>
  );
}

function ProtocolRuntimeDiagram() {
  return (
    <div className="diagram-stack">
      <div className="diagram-stack-row">
        <span>CLIENTS</span>
        <div><Node title="SYSTEM LAB" detail="PROOF" /><Node title="DASHBOARD" detail="OPERATE" /><Node title="TELEGRAM" detail="SIDECAR" /><Node title="SDK / MCP" detail="INTEGRATE" /></div>
      </div>
      <Arrow vertical label="requests and state" />
      <div className="diagram-stack-row runtime">
        <span>RUNTIME</span>
        <div><Node title="WORKSPACE" /><Node title="PATH" /><Node title="BAPHOMET" tone="signal" /><Node title="PACT" /><Node title="PROOF" /><Node title="GAIA" /></div>
      </div>
      <Arrow vertical label="wallet authorised action" />
      <div className="diagram-stack-row protocol">
        <span>PROTOCOL</span>
        <div><Node title="RAILSCARD" tone="dark" /><Node title="RAILSFLOW" tone="dark" /><Node title="PAYCARD" tone="dark" /><Node title="STN-DELTA" tone="dark" /><Node title="VAULT" tone="dark" /></div>
      </div>
      <Arrow vertical label="canonical receipt" />
      <Node eyebrow="NETWORK" title="GIWA / EVM ADAPTER" detail="CONTRACTS, EVENTS, RECEIPTS" tone="signal" className="diagram-network-node" />
    </div>
  );
}

function RailsCardDiagram() {
  return (
    <div className="diagram-railscard-v52">
      <Node eyebrow="OWNER WALLET" title="MACRO BUDGET" detail="1,000 orUSD" />
      <Arrow label="bounded approval" />
      <div className="railscard-shell v52">
        <span>RAILSCARD / AUTHORITY ENVELOPE</span>
        <div className="railscard-meter"><i style={{ width: '60%' }} /><b>600 COMMITTED · 400 REMAINING</b></div>
        <div className="railscard-rules"><span>ASSET / orUSD</span><span>EXPIRY / 30 MIN</span><span>COUNTERPARTY / VERIFIED</span><span>ACTOR / COMMERCE OPERATOR</span></div>
        <div className="railscard-child-flows"><Node eyebrow="FLOW 018" title="420" detail="orUSD" tone="signal" /><Node eyebrow="FLOW 019" title="180" detail="orUSD" /><Node eyebrow="NEXT REQUEST" title="≤ 400" detail="AVAILABLE" tone="dark" /></div>
      </div>
    </div>
  );
}

function RailsFlowDiagram() {
  const stages = [
    ['01', 'PREPARE', 'Runtime builds exact typed intent'],
    ['02', 'REVIEW', 'Wallet displays all bound fields'],
    ['03', 'SIGN', 'User approves the exact intent'],
    ['04', 'BROADCAST', 'Wallet submits to the configured network'],
    ['05', 'OPEN', 'Protocol emits canonical Paycard state'],
  ];
  return (
    <div className="diagram-railsflow-v52">
      <div className="railsflow-fields">
        {['PAYER', 'RECIPIENT', 'PAYCARD ID', 'ALLOCATION', 'START / EXPIRY', 'NONCE LANE', 'METADATA HASH'].map((field, index) => <span key={field}><i>0{index + 1}</i>{field}</span>)}
      </div>
      <div className="railsflow-stage-track">{stages.map(([index, title, detail], stageIndex) => <div key={title}><span>{index}</span><strong>{title}</strong><small>{detail}</small>{stageIndex < stages.length - 1 && <i aria-hidden="true">→</i>}</div>)}</div>
      <div className="railsflow-boundary-note"><Node eyebrow="WALLET BOUNDARY" title="VISIBLE SIGNATURE" detail="NO RUNTIME KEY" tone="signal" /><Node eyebrow="CANONICAL RESULT" title="OPEN PAYCARD" detail="CONFIRMED RECEIPT" tone="dark" /></div>
    </div>
  );
}

function NonceLaneDiagram() {
  return (
    <div className="diagram-nonce">
      <div className="nonce-axis"><span>LANE</span>{['00', '01', '02', '03', '04'].map((lane) => <b key={lane}>{lane}</b>)}</div>
      <div className="nonce-grid">
        {Array.from({ length: 25 }, (_, index) => {
          const row = Math.floor(index / 5);
          const col = index % 5;
          const primary = row === 4 && col < 4;
          const parallel = row === 2 && col < 2;
          const active = primary || parallel;
          return <span key={index} className={primary ? 'active' : parallel ? 'parallel' : ''}><i>{col}</i>{active ? 'USED' : 'OPEN'}</span>;
        })}
      </div>
      <div className="nonce-caption"><strong>PARALLEL LANES</strong><span>Lane 04: 0, 1, 2, 3</span><span>Lane 02: 0, 1</span><small>A delayed action in one lane does not stall the other. Every intent still binds to one exact lane and sequence.</small></div>
    </div>
  );
}

function StnDeltaDiagram() {
  return (
    <div className="diagram-delta-v52">
      <div className="diagram-delta">
        <Node eyebrow="ALLOCATED" title="420" detail="orUSD" tone="dark" />
        <div className="delta-split"><i /><b>STN-DELTA</b><i /></div>
        <div className="delta-destinations">
          <Node eyebrow="EARNED" title="210" detail="TO RECIPIENT" tone="signal" />
          <Node eyebrow="RESIDUAL" title="210" detail="BACK TO PAYER" />
        </div>
      </div>
      <p><strong>DEMONSTRATION OUTCOME</strong> The 210 and 210 split is not a fixed protocol percentage. Actual routing depends on the bound earning horizon, proof state, and close condition.</p>
    </div>
  );
}

function PaycardDiagram() {
  const states = ['PREPARED', 'ACTIVE', 'EARNING', 'SETTLED', 'TERMINATED'];
  return (
    <div className="diagram-state-machine">
      {states.map((state, index) => <div key={state}><Node eyebrow={`0${index + 1}`} title={state} tone={index === 2 ? 'signal' : index >= 3 ? 'dark' : 'light'} />{index < states.length - 1 && <Arrow />}</div>)}
      <div className="diagram-state-note"><span>CANONICAL ADVANCE</span><strong>Exact contract event and confirmed receipt required</strong></div>
    </div>
  );
}

function WorkspaceDiagram() {
  return (
    <div className="diagram-workspace">
      <div className="workspace-orbit">
        <Node eyebrow="PRINCIPAL" title="OWNER" detail="CONTROLLER" />
        <Node eyebrow="MEMBER" title="OPERATOR" detail="HUMAN" />
        <Node eyebrow="CLIENT" title="APPLICATION" detail="INTEGRATION" />
        <Node eyebrow="ACTOR" title="AGENT" detail="BOUNDED" tone="signal" />
        <div className="workspace-core-doc"><span>WORKSPACE / 01</span><strong>ECONOMIC OWNERSHIP</strong><small>Membership, roles, agents, paths</small></div>
      </div>
    </div>
  );
}

function PathDiagram() {
  const rules = [['ACTION', 'PREPARE RAILSFLOW'], ['ASSET', 'orUSD'], ['PARTY', 'VERIFIED'], ['PER PACT', '≤ 1,000'], ['VELOCITY', '≤ 14 / SEC'], ['DURATION', '≤ 30 SEC']];
  return (
    <div className="diagram-path">
      <Node eyebrow="ACTOR" title="AGENT / 03" detail="REQUESTS ACTION" />
      <Arrow label="proposal" />
      <div className="path-gate"><span>PATH / 04</span>{rules.map(([label, value]) => <div key={label}><b>{label}</b><strong>{value}</strong><i /></div>)}</div>
      <Arrow label="within bounds" />
      <Node eyebrow="NEXT" title="BAPHOMET" detail="EVALUATES EXACT REQUEST" tone="signal" />
    </div>
  );
}

function BaphometDiagram() {
  return (
    <div className="diagram-baphomet">
      <Node eyebrow="PROPOSAL / 018" title="420 orUSD" detail="PREPARE RAILSFLOW" />
      <Arrow />
      <div className="baphomet-checks"><span>BAPHOMET / DETERMINISTIC CHECKS</span>{['WORKSPACE ACTIVE', 'AGENT ACTIVE', 'PATH ACTIVE', 'ACTION PERMITTED', 'ASSET PERMITTED', 'VALUE WITHIN CEILING'].map((check) => <div key={check}><strong>{check}</strong><b>PASS</b></div>)}</div>
      <div className="baphomet-outcomes"><Node eyebrow="RESULT" title="ALLOW" detail="PACT MAY FORM" tone="signal" /><Node eyebrow="OVER LIMIT" title="BLOCK" detail="NO VALUE MOVES" tone="dark" /></div>
    </div>
  );
}

function PactDiagram() {
  const chain = ['PATH HASH', 'PROPOSAL HASH', 'DECISION HASH', 'PACT TERMS HASH', 'PARTY SIGNATURES'];
  return (
    <div className="diagram-pact">
      <div className="pact-chain-doc">{chain.map((item, index) => <div key={item}><Node eyebrow={`0${index + 1}`} title={item} tone={index === chain.length - 1 ? 'signal' : 'light'} />{index < chain.length - 1 && <Arrow />}</div>)}</div>
      <div className="pact-sheet-doc"><span>PACT / 2048</span><strong>420 orUSD · 30 SEC</strong><small>PARTIES · PROOF POLICY · SETTLEMENT POLICY · EXCEPTION POLICY</small></div>
    </div>
  );
}

function ProofDiagram() {
  return (
    <div className="diagram-proof">
      <div className="proof-evidence"><Node eyebrow="EVIDENCE 01" title="GIWA RECEIPT" detail="TX + EVENT" /><Node eyebrow="EVIDENCE 02" title="CHECKPOINT" detail="SIGNED CLAIM" /><Node eyebrow="EVIDENCE 03" title="METADATA" detail="PACT BINDING" /></div>
      <Arrow vertical label="verification plugin" />
      <div className="proof-verifier"><span>VERIFIER</span><div>{['SOURCE', 'INTEGRITY', 'PACT LINK', 'POLICY'].map((item) => <b key={item}>{item}<i>PASS</i></b>)}</div></div>
      <Arrow vertical label="state advance" />
      <Node eyebrow="RESULT" title="SETTLEMENT ELIGIBLE" detail="WALLET ACTION STILL REQUIRED" tone="signal" className="diagram-network-node" />
    </div>
  );
}

function GaiaDiagram() {
  return (
    <div className="diagram-gaia">
      <div className="gaia-origin"><Node eyebrow="PACT" title="2048" detail="ACTIVE HISTORY" /><Arrow vertical /></div>
      <div className="gaia-branches">
        <div><span>NORMAL</span><Node title="PROOF APPROVED" /><Arrow vertical /><Node title="SETTLEMENT" tone="dark" /></div>
        <div className="exception"><span>EXCEPTION</span><Node title="EVIDENCE BUNDLE" /><Arrow vertical /><Node title="GAIA DETERMINATION" tone="signal" /><Arrow vertical /><Node title="RECTIFICATION" detail="BOUNDED OBLIGATION" /></div>
      </div>
      <p>Both paths preserve the same Workspace, Path, decision, Pact, evidence, and financial history.</p>
    </div>
  );
}

function KernelDiagram() {
  return (
    <div className="diagram-kernel">
      <div className="kernel-clients"><Node title="WEB" /><Node title="TELEGRAM" /><Node title="MCP" /><Node title="SDK" /></div>
      <Arrow vertical label="authenticated request" />
      <div className="kernel-shell"><span>AGENT KERNEL</span><div><Node title="ACTION REGISTRY" /><Node title="BAPHOMET" tone="signal" /><Node title="PACT STATE" /><Node title="PROOF PLUGINS" /><Node title="GIWA OBSERVER" /><Node title="GAIA" /></div></div>
      <div className="kernel-boundaries"><Node eyebrow="OUTSIDE KERNEL" title="WALLET" detail="SIGNS + BROADCASTS" tone="signal" /><Node eyebrow="OBSERVED" title="NETWORK" detail="FINAL RECEIPTS" tone="dark" /></div>
    </div>
  );
}

function ClientsDiagram() {
  return (
    <div className="diagram-clients">
      <div className="client-hub"><span>OPENRAILS SYSTEM</span><strong>ONE STATE MODEL</strong><small>Authority, commitments, evidence, settlement</small></div>
      {[
        ['SYSTEM LAB', 'GUIDED PROOF'], ['DASHBOARD', 'PERSONAL OPERATIONS'], ['TELEGRAM', 'CONVERSATIONAL SIDECAR'], ['SDK', 'APPLICATION CODE'], ['MCP', 'AGENT TOOLS'], ['REST', 'SERVICE INTEGRATION']
      ].map(([title, detail], index) => <motion.div key={title} className={`client-spoke spoke-${index + 1}`} initial={{ opacity: .25 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ delay: index * .08 }}><Node title={title} detail={detail} tone={index === 1 ? 'signal' : 'light'} /></motion.div>)}
    </div>
  );
}

function NetworkDiagram() {
  return (
    <div className="diagram-network">
      <div className="network-core-doc"><span>OPENRAILS PORTABLE CORE</span><strong>WORKSPACE · PATH · PACT · PROOF · RAILSFLOW · PAYCARD</strong></div>
      <Arrow vertical label="network adapter" />
      <div className="network-adapter-doc">{['CHAIN ID', 'RPC', 'EXPLORER', 'ASSETS', 'CONTRACTS', 'EVENTS'].map((item) => <span key={item}>{item}</span>)}</div>
      <Arrow vertical label="deployment" />
      <div className="network-targets"><Node eyebrow="LIVE DEMO" title="GIWA SEPOLIA" detail="CHAIN 91342" tone="signal" /><Node eyebrow="REUSABLE" title="CONFIGURED EVM" detail="NETWORK ADAPTER" /><Node eyebrow="FUTURE" title="OTHER EVM" detail="ADAPTER" /></div>
    </div>
  );
}

function SecurityDiagram() {
  return (
    <div className="diagram-security">
      <div><span>01 / RUNTIME</span><strong>PREPARE · VALIDATE · PERSIST · OBSERVE</strong><small>No raw private keys. No silent signatures. No hidden broadcast.</small></div>
      <Arrow vertical label="explicit payload" />
      <div className="wallet-boundary"><span>02 / WALLET</span><strong>REVIEW · SIGN · APPROVE · BROADCAST</strong><small>The user sees authority and financial actions.</small></div>
      <Arrow vertical label="transaction" />
      <div className="network-boundary"><span>03 / NETWORK</span><strong>EXECUTE · EMIT · CONFIRM</strong><small>Financial state becomes canonical only after exact receipt verification.</small></div>
    </div>
  );
}

function DemoDiagram() {
  return (
    <div className="diagram-demo">
      <div className="demo-route allow"><span>PERMITTED ROUTE</span>{['CONNECT', 'AUTHORITY', '420 PROPOSAL', 'ALLOW', 'PACT', 'PROOF', 'PAYCARD', 'SETTLE'].map((item, index) => <div key={item}><b>0{index + 1}</b><strong>{item}</strong></div>)}</div>
      <div className="demo-route block"><span>NEGATIVE CONTROL</span>{['1,420 PROPOSAL', 'POLICY CHECK', 'BLOCK', 'NO PACT', 'NO WALLET', 'NO VALUE'].map((item, index) => <div key={item}><b>0{index + 1}</b><strong>{item}</strong></div>)}</div>
    </div>
  );
}

export function DocsDiagram({ kind, caption }: { kind: DiagramKind; caption?: string }) {
  const reduceMotion = useReducedMotion();
  let content;
  switch (kind) {
    case 'lifecycle': content = <LifecycleDiagram />; break;
    case 'protocol-runtime': content = <ProtocolRuntimeDiagram />; break;
    case 'railscard': content = <RailsCardDiagram />; break;
    case 'railsflow': content = <RailsFlowDiagram />; break;
    case 'nonce-lane': content = <NonceLaneDiagram />; break;
    case 'stn-delta': content = <StnDeltaDiagram />; break;
    case 'paycard': content = <PaycardDiagram />; break;
    case 'workspace': content = <WorkspaceDiagram />; break;
    case 'path': content = <PathDiagram />; break;
    case 'baphomet': content = <BaphometDiagram />; break;
    case 'pact': content = <PactDiagram />; break;
    case 'proof': content = <ProofDiagram />; break;
    case 'gaia': content = <GaiaDiagram />; break;
    case 'kernel': content = <KernelDiagram />; break;
    case 'clients': content = <ClientsDiagram />; break;
    case 'network': content = <NetworkDiagram />; break;
    case 'security': content = <SecurityDiagram />; break;
    case 'demo': content = <DemoDiagram />; break;
    default: content = <LifecycleDiagram />;
  }
  return (
    <motion.figure className={`docs-diagram docs-diagram-${kind}`} initial={reduceMotion ? false : { opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .15 }} transition={{ duration: .55, ease: [0.22, 1, 0.36, 1] }}>
      <div className="docs-diagram-head"><span>OPENRAILS / VISUAL MODEL</span><strong>{kind.replaceAll('-', ' ').toUpperCase()}</strong></div>
      <div className="docs-diagram-canvas">{content}</div>
      {caption && <figcaption>{caption}</figcaption>}
    </motion.figure>
  );
}
