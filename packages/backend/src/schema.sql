CREATE TABLE IF NOT EXISTS service_lock (id integer PRIMARY KEY CHECK (id = 1));
INSERT INTO service_lock VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS challenges (
 nonce text PRIMARY KEY, address text NOT NULL, message text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, address text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
 id uuid PRIMARY KEY, agent_id text NOT NULL, owner text NOT NULL, operator text NOT NULL,
 suite_hash text NOT NULL, state jsonb NOT NULL, actions jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL CHECK(status IN ('active','passed','failed','invalid')),
 deadline timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 evidence jsonb, evidence_hash text
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(agent_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS jobs (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('trade','qualification','keeper')),
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','prepared','confirmed','reverted','blocked')),
 signer text, nonce bigint, raw text, hash text UNIQUE, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS signer_nonce ON jobs(signer,nonce) WHERE nonce IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_signer ON jobs(signer) WHERE status = 'prepared';
CREATE TABLE IF NOT EXISTS cursor (
 id integer PRIMARY KEY CHECK(id=1), block_number bigint NOT NULL, block_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
 block_number bigint NOT NULL, block_hash text NOT NULL, tx_hash text NOT NULL,
 log_index integer NOT NULL, address text NOT NULL, name text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(block_hash, tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS snapshots (
 block_number bigint PRIMARY KEY, block_hash text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS snapshots_created_at ON snapshots(created_at);
CREATE INDEX IF NOT EXISTS recent_events ON events(block_number DESC, log_index DESC);
