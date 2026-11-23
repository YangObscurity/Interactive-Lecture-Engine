-- Forward-only initial schema for lecture-api (V2 backend v1)
-- Creates progress and idempotency_keys tables and their indexes.
-- Note: schema_migrations is managed separately by the migration runner so
-- status checks and --dry-run remain strictly read-only.

CREATE TABLE IF NOT EXISTS progress (
  user_id text NOT NULL,
  lecture_id text NOT NULL,
  group_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('未开始', '学习中', '已完成')),
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  notion_node_id text NULL,
  notion_page_id text NULL,
  PRIMARY KEY (user_id, lecture_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_user_group
  ON progress (user_id, group_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id text NOT NULL,
  key text NOT NULL,
  fingerprint text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON idempotency_keys (created_at);
