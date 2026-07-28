BEGIN;

CREATE TABLE IF NOT EXISTS openrails_kernel_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openrails_workspaces (
  workspace_id text PRIMARY KEY,
  authority_account text NOT NULL,
  authority_type text NOT NULL,
  revision bigint NOT NULL,
  record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openrails_agents (
  agent_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES openrails_workspaces(workspace_id),
  status text NOT NULL,
  revision bigint NOT NULL,
  record_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openrails_agents_workspace_idx ON openrails_agents(workspace_id, status);

CREATE TABLE IF NOT EXISTS openrails_paths (
  path_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES openrails_workspaces(workspace_id),
  revision bigint NOT NULL,
  path_hash text NOT NULL,
  status text NOT NULL,
  artifact_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(path_id, revision)
);
CREATE INDEX IF NOT EXISTS openrails_paths_workspace_idx ON openrails_paths(workspace_id, status);

CREATE TABLE IF NOT EXISTS openrails_pacts (
  pact_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES openrails_workspaces(workspace_id),
  path_id text NOT NULL,
  status text NOT NULL,
  revision bigint NOT NULL,
  record_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openrails_pacts_workspace_idx ON openrails_pacts(workspace_id, status);
CREATE INDEX IF NOT EXISTS openrails_pacts_path_idx ON openrails_pacts(path_id, status);

CREATE TABLE IF NOT EXISTS openrails_pact_events (
  event_id text PRIMARY KEY,
  pact_id text NOT NULL REFERENCES openrails_pacts(pact_id),
  workspace_id text NOT NULL,
  sequence bigint NOT NULL,
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(pact_id, sequence)
);

CREATE TABLE IF NOT EXISTS openrails_proposals (
  proposal_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  path_id text NOT NULL,
  agent_id text NOT NULL,
  proposal_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openrails_runtime_jobs (
  job_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  proposal_id text NOT NULL,
  kind text NOT NULL,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  locked_by text,
  lock_until timestamptz,
  result_json jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openrails_runtime_jobs_queue_idx ON openrails_runtime_jobs(state, created_at);

CREATE TABLE IF NOT EXISTS openrails_baphomet_decisions (
  decision_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  proposal_id text NOT NULL,
  result text NOT NULL,
  decision_hash text NOT NULL,
  record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openrails_blocked_actions (
  blocked_action_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  path_id text NOT NULL,
  agent_id text NOT NULL,
  proposal_id text NOT NULL,
  decision_hash text NOT NULL,
  record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openrails_verification_plugins (
  plugin_key text PRIMARY KEY,
  plugin_id text NOT NULL,
  plugin_version text NOT NULL,
  code_digest text NOT NULL,
  status text NOT NULL,
  manifest_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plugin_id, plugin_version)
);

CREATE TABLE IF NOT EXISTS openrails_checkpoints (
  checkpoint_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  pact_id text NOT NULL REFERENCES openrails_pacts(pact_id),
  evidence_hash text NOT NULL,
  checkpoint_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openrails_verification_decisions (
  decision_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  pact_id text NOT NULL,
  checkpoint_id text NOT NULL,
  decision_hash text NOT NULL,
  decision_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openrails_gaia_cases (
  case_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  pact_id text NOT NULL,
  status text NOT NULL,
  record_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openrails_rectification_obligations (
  obligation_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES openrails_gaia_cases(case_id),
  workspace_id text NOT NULL,
  pact_id text NOT NULL,
  status text NOT NULL,
  record_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openrails_kernel_events (
  event_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  event_type text NOT NULL,
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openrails_kernel_events_subject_idx ON openrails_kernel_events(workspace_id, subject_type, subject_id, created_at);

CREATE TABLE IF NOT EXISTS openrails_kernel_idempotency (
  scope text NOT NULL,
  key text NOT NULL,
  fingerprint text NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope, key)
);

COMMIT;
