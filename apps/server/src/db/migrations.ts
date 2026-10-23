/** Ordered, append-only schema migrations. Never edit a shipped entry; add a new one. */
export const MIGRATIONS: string[] = [
  /* 1: core schema */ `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE chats (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, project_name TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, busy INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL, text TEXT NOT NULL, blocks_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX messages_chat ON messages(chat_id, created_at);

  -- Workflow runs + checkpoints: state_json is the resumable state machine snapshot.
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, chat_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
    step TEXT, state_json TEXT NOT NULL DEFAULT '{}', error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX runs_chat ON runs(chat_id, created_at);

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL,
    chat_id TEXT, run_id TEXT, payload_json TEXT NOT NULL
  );
  CREATE INDEX events_chat ON events(chat_id, seq);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, chat_id TEXT, run_id TEXT, incident_id TEXT, project_name TEXT,
    capability_id TEXT NOT NULL, tool TEXT NOT NULL, action TEXT NOT NULL, args_json TEXT NOT NULL,
    scope_hash TEXT NOT NULL, risk TEXT NOT NULL, view_json TEXT NOT NULL, status TEXT NOT NULL,
    typed_confirmation TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    decided_at TEXT, decided_by TEXT, consumed_at TEXT, result_json TEXT
  );
  CREATE INDEX approvals_status ON approvals(status, created_at);

  -- Append-only audit log: updates and deletes are rejected by triggers.
  CREATE TABLE audit (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
    capability_id TEXT, resource TEXT, risk TEXT, approval_id TEXT, status TEXT NOT NULL,
    error_code TEXT, duration_ms INTEGER, args_json TEXT, chat_id TEXT, run_id TEXT,
    tool_execution_id TEXT, mode TEXT NOT NULL, evidence TEXT
  );
  CREATE INDEX audit_at ON audit(at);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

  CREATE TABLE projects (
    name TEXT PRIMARY KEY, platform TEXT, plan_id TEXT, environment TEXT,
    profile_json TEXT, health TEXT NOT NULL DEFAULT 'unknown', health_url TEXT,
    last_deploy_at TEXT, primary_domain TEXT, created_by_agent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE deployments (
    id TEXT PRIMARY KEY, project_name TEXT NOT NULL, chat_id TEXT, source_id TEXT, release_id TEXT,
    port INTEGER, platform TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    verification_json TEXT, previous_release TEXT, workspace_id TEXT, note TEXT
  );
  CREATE INDEX deployments_project ON deployments(project_name, started_at);

  CREATE TABLE incidents (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, project_name TEXT NOT NULL, fingerprint TEXT NOT NULL,
    title TEXT NOT NULL, severity TEXT NOT NULL, state TEXT NOT NULL, service TEXT, environment TEXT,
    started_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, occurrences INTEGER NOT NULL DEFAULT 1,
    probable_cause TEXT, confidence REAL, hypotheses_json TEXT NOT NULL DEFAULT '[]',
    timeline_json TEXT NOT NULL DEFAULT '[]', impact TEXT, approval_id TEXT,
    notes_json TEXT NOT NULL DEFAULT '[]', acknowledged INTEGER NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL DEFAULT '{}', before_json TEXT
  );
  CREATE INDEX incidents_fp ON incidents(project_name, fingerprint, state);

  CREATE TABLE patrol_settings (
    project_name TEXT PRIMARY KEY, settings_json TEXT NOT NULL, next_run_at TEXT,
    last_run_at TEXT, lease_owner TEXT, lease_until TEXT
  );
  CREATE TABLE patrol_runs (
    id TEXT PRIMARY KEY, project_name TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL, checks_json TEXT NOT NULL DEFAULT '[]', llm_calls INTEGER NOT NULL DEFAULT 0,
    incident_id TEXT, trigger TEXT NOT NULL, idempotency_key TEXT UNIQUE
  );
  CREATE INDEX patrol_runs_project ON patrol_runs(project_name, started_at);
  CREATE TABLE baselines (
    project_name TEXT NOT NULL, key TEXT NOT NULL, ema REAL NOT NULL, samples INTEGER NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(project_name, key)
  );

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    severity TEXT NOT NULL, href TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    dedupe_key TEXT UNIQUE
  );

  CREATE TABLE model_calls (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, provider_id TEXT NOT NULL,
    ok INTEGER NOT NULL, latency_ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER,
    cost_toman REAL, cost_usd REAL, fallback_reason TEXT, error_code TEXT, run_id TEXT, chat_id TEXT, stream INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX model_calls_at ON model_calls(at);
  CREATE TABLE model_probes (model TEXT PRIMARY KEY, at TEXT NOT NULL, result_json TEXT NOT NULL);

  CREATE TABLE error_kb (
    signature TEXT PRIMARY KEY, category TEXT NOT NULL, technology TEXT, cause TEXT,
    fix_summary TEXT, success_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
    failed_fixes_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
  );

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, chat_id TEXT, kind TEXT NOT NULL, origin TEXT NOT NULL,
    path TEXT NOT NULL, original_path TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE patches (
    id TEXT PRIMARY KEY, chat_id TEXT, workspace_id TEXT NOT NULL, files_json TEXT NOT NULL,
    summary TEXT NOT NULL, status TEXT NOT NULL, signature TEXT, attempt INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  `,
];
