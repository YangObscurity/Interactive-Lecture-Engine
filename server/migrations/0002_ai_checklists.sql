-- Forward-only migration 0002_ai_checklists.sql for lecture-api (Backend M4 / backend-v2)
-- Creates ai_sessions, ai_messages, and ai_review_checklists tables and their indexes.
-- Compatible with PostgreSQL 14+ and PGlite 0.5.x forward migrations only.

CREATE TABLE IF NOT EXISTS ai_sessions (
  user_id text NOT NULL,
  id text NOT NULL,
  lecture_id text NOT NULL,
  group_id text NOT NULL,
  title text NOT NULL DEFAULT '新会话',
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_lecture_updated
  ON ai_sessions (user_id, lecture_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  user_id text NOT NULL,
  id text NOT NULL,
  session_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  selected_context text NULL,
  model text NOT NULL DEFAULT '',
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, session_id) REFERENCES ai_sessions (user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_user_session_created
  ON ai_messages (user_id, session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS ai_review_checklists (
  user_id text NOT NULL,
  id text NOT NULL,
  lecture_id text NOT NULL,
  group_id text NOT NULL,
  topic_title text NOT NULL,
  section_anchor text NULL,
  is_completed boolean NOT NULL DEFAULT false,
  pptx_source text NULL,
  priority integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_ai_checklists_user_lecture
  ON ai_review_checklists (user_id, lecture_id, priority DESC, created_at ASC);
