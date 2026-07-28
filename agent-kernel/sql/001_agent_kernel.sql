BEGIN;

-- V1 intentionally uses one transactionally locked JSONB snapshot. The domain
-- event arrays inside state_json are the canonical runtime audit log. Normalized
-- projection tables are deferred until their writer and rebuild semantics exist.
CREATE TABLE IF NOT EXISTS openrails_kernel_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
