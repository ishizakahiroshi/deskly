/** Canonical SQLite-dialect SQL for both hosts. No filesystem or Node APIs. */
export const migrations = [
  { name: '001_initial.sql', sql: String.raw`-- New portable-store schema. Intentionally independent of legacy Python databases.
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE TABLE accounts (
  subject TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE TABLE resources (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  project_id TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES resources(workspace_id, id)
) STRICT;
CREATE INDEX resources_project ON resources(workspace_id, project_id, type);
CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, member_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
) STRICT;
CREATE TABLE project_memberships (
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, member_id, project_id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES workspace_memberships(workspace_id, member_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES resources(workspace_id, id)
) STRICT;
CREATE TABLE source_memberships (
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, member_id, source_id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES workspace_memberships(workspace_id, member_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES resources(workspace_id, id)
) STRICT;
CREATE TABLE contacts (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, source_id, contact_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES resources(workspace_id, id)
) STRICT;
-- A single operation namespace makes workspace/contact idempotency atomic. Every
-- port filters kind, so private contact history never enters workspace event reads.
CREATE TABLE events (
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('workspace', 'contact')),
  source_id TEXT,
  contact_id TEXT,
  requester_member_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, operation_id),
  CHECK ((kind = 'workspace' AND source_id IS NULL AND contact_id IS NULL)
    OR (kind = 'contact' AND source_id IS NOT NULL AND contact_id IS NOT NULL)),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
  FOREIGN KEY (workspace_id, requester_member_id) REFERENCES workspace_memberships(workspace_id, member_id),
  FOREIGN KEY (workspace_id, source_id, contact_id) REFERENCES contacts(workspace_id, source_id, contact_id)
) STRICT;
CREATE INDEX events_contact ON events(workspace_id, kind, source_id, contact_id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER events_no_replace BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM events WHERE workspace_id = NEW.workspace_id AND operation_id = NEW.operation_id)
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
` },
  { name: '002_conditions.sql', sql: `-- Successful condition checks never insert a row; failure aborts the batch.
CREATE TABLE store_conditions (
  ok INTEGER NOT NULL CONSTRAINT store_condition_failed CHECK (ok = 1)
) STRICT;
` },
  { name: '003_cases.sql', sql: String.raw`-- Received cases (stored identifier "case"; the display name is a setting).
-- Every key is scoped by workspace. No foreign key reaches an app, user or tenant
-- table; children point only at their case, so a case can never be removed.
-- Nothing here is deleted, numbers are never reissued and history is append-only.
CREATE TABLE case_number_sequences (
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  next_seq INTEGER NOT NULL CHECK (next_seq >= 2),
  PRIMARY KEY (workspace_id, source),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
) STRICT;
CREATE TRIGGER case_number_sequences_no_delete BEFORE DELETE ON case_number_sequences BEGIN
  SELECT RAISE(ABORT, 'case numbers are never reissued');
END;
CREATE TRIGGER case_number_sequences_step BEFORE UPDATE ON case_number_sequences
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.source IS NOT OLD.source OR NEW.next_seq IS NOT OLD.next_seq + 1
BEGIN
  SELECT RAISE(ABORT, 'case numbers are never reissued');
END;
CREATE TABLE cases (
  workspace_id TEXT NOT NULL,
  number TEXT NOT NULL,
  source TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  legacy_ref TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, number),
  UNIQUE (workspace_id, source, seq),
  CHECK (number = source || '-' || seq),
  FOREIGN KEY (workspace_id, source) REFERENCES case_number_sequences(workspace_id, source)
) STRICT;
CREATE UNIQUE INDEX cases_legacy_ref ON cases(workspace_id, source, legacy_ref) WHERE legacy_ref IS NOT NULL;
CREATE TRIGGER cases_issued BEFORE INSERT ON cases
WHEN NOT EXISTS (SELECT 1 FROM case_number_sequences
  WHERE workspace_id = NEW.workspace_id AND source = NEW.source AND next_seq > NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'case numbers are issued by the ledger');
END;
CREATE TRIGGER cases_no_replace BEFORE INSERT ON cases
WHEN EXISTS (SELECT 1 FROM cases WHERE workspace_id = NEW.workspace_id AND number = NEW.number)
BEGIN
  SELECT RAISE(ABORT, 'cases are never deleted');
END;
CREATE TRIGGER cases_no_delete BEFORE DELETE ON cases BEGIN
  SELECT RAISE(ABORT, 'cases are never deleted');
END;
CREATE TRIGGER cases_identity_fixed BEFORE UPDATE ON cases
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.number IS NOT OLD.number OR NEW.source IS NOT OLD.source
  OR NEW.seq IS NOT OLD.seq OR NEW.legacy_ref IS NOT OLD.legacy_ref OR NEW.revision IS NOT OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'case identity is fixed and revisions advance by one');
END;
CREATE TABLE case_events (
  workspace_id TEXT NOT NULL,
  case_number TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, case_number, seq),
  FOREIGN KEY (workspace_id, case_number) REFERENCES cases(workspace_id, number)
) STRICT;
CREATE TRIGGER case_events_no_update BEFORE UPDATE ON case_events BEGIN
  SELECT RAISE(ABORT, 'case events are append-only');
END;
CREATE TRIGGER case_events_no_delete BEFORE DELETE ON case_events BEGIN
  SELECT RAISE(ABORT, 'case events are append-only');
END;
CREATE TRIGGER case_events_in_order BEFORE INSERT ON case_events
WHEN NEW.seq IS NOT (SELECT COUNT(*) FROM case_events
  WHERE workspace_id = NEW.workspace_id AND case_number = NEW.case_number) + 1
BEGIN
  SELECT RAISE(ABORT, 'case events are append-only');
END;
CREATE TABLE case_people (
  workspace_id TEXT NOT NULL,
  case_number TEXT NOT NULL,
  reporter_ref TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, case_number, reporter_ref),
  UNIQUE (workspace_id, case_number, position),
  FOREIGN KEY (workspace_id, case_number) REFERENCES cases(workspace_id, number)
) STRICT;
CREATE TRIGGER case_people_no_delete BEFORE DELETE ON case_people BEGIN
  SELECT RAISE(ABORT, 'case people are never deleted');
END;
CREATE TRIGGER case_people_in_order BEFORE INSERT ON case_people
WHEN NEW.position IS NOT (SELECT COUNT(*) FROM case_people
  WHERE workspace_id = NEW.workspace_id AND case_number = NEW.case_number) + 1
BEGIN
  SELECT RAISE(ABORT, 'case people are added in order');
END;
CREATE TABLE case_replies (
  workspace_id TEXT NOT NULL,
  case_number TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, case_number, seq),
  FOREIGN KEY (workspace_id, case_number) REFERENCES cases(workspace_id, number)
) STRICT;
CREATE TRIGGER case_replies_no_delete BEFORE DELETE ON case_replies BEGIN
  SELECT RAISE(ABORT, 'case replies are append-only');
END;
CREATE TRIGGER case_replies_in_order BEFORE INSERT ON case_replies
WHEN NEW.seq IS NOT (SELECT COUNT(*) FROM case_replies
  WHERE workspace_id = NEW.workspace_id AND case_number = NEW.case_number) + 1
BEGIN
  SELECT RAISE(ABORT, 'case replies are append-only');
END;
CREATE TABLE case_links (
  workspace_id TEXT NOT NULL,
  case_number TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN ('commit', 'doc', 'url')),
  ref TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, case_number, link_type, ref),
  UNIQUE (workspace_id, case_number, position),
  FOREIGN KEY (workspace_id, case_number) REFERENCES cases(workspace_id, number)
) STRICT;
CREATE TRIGGER case_links_no_delete BEFORE DELETE ON case_links BEGIN
  SELECT RAISE(ABORT, 'case links are never deleted');
END;
CREATE TRIGGER case_links_in_order BEFORE INSERT ON case_links
WHEN NEW.position IS NOT (SELECT COUNT(*) FROM case_links
  WHERE workspace_id = NEW.workspace_id AND case_number = NEW.case_number) + 1
BEGIN
  SELECT RAISE(ABORT, 'case links are added in order');
END;
` },
  { name: '004_case_member_scopes.sql', sql: String.raw`-- Case scopes given to workspace members (used only while [member_access] is enabled).
-- One row per (workspace, member). Rows are never deleted: a revocation keeps the
-- row (role null, empty lists) so its revision never goes back. History is append-only.
CREATE TABLE case_member_scopes (
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, member_id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES workspace_memberships(workspace_id, member_id)
) STRICT;
CREATE TRIGGER case_member_scopes_no_delete BEFORE DELETE ON case_member_scopes BEGIN
  SELECT RAISE(ABORT, 'case member scopes are revoked, never deleted');
END;
CREATE TRIGGER case_member_scopes_no_replace BEFORE INSERT ON case_member_scopes
WHEN EXISTS (SELECT 1 FROM case_member_scopes WHERE workspace_id = NEW.workspace_id AND member_id = NEW.member_id)
BEGIN
  SELECT RAISE(ABORT, 'case member scopes are revoked, never deleted');
END;
CREATE TRIGGER case_member_scopes_step BEFORE UPDATE ON case_member_scopes
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.member_id IS NOT OLD.member_id OR NEW.revision IS NOT OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'case member scope identity is fixed and revisions advance by one');
END;
CREATE TABLE case_member_scope_events (
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  member_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (workspace_id, seq),
  FOREIGN KEY (workspace_id, member_id) REFERENCES case_member_scopes(workspace_id, member_id)
) STRICT;
CREATE TRIGGER case_member_scope_events_no_update BEFORE UPDATE ON case_member_scope_events BEGIN
  SELECT RAISE(ABORT, 'case member scope events are append-only');
END;
CREATE TRIGGER case_member_scope_events_no_delete BEFORE DELETE ON case_member_scope_events BEGIN
  SELECT RAISE(ABORT, 'case member scope events are append-only');
END;
CREATE TRIGGER case_member_scope_events_in_order BEFORE INSERT ON case_member_scope_events
WHEN NEW.seq IS NOT (SELECT COUNT(*) FROM case_member_scope_events WHERE workspace_id = NEW.workspace_id) + 1
BEGIN
  SELECT RAISE(ABORT, 'case member scope events are append-only');
END;
` },
] as const;
export async function checksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
/** Trusted, checked-in scripts only. Keep a trigger's BEGIN ... END in one statement. */
export function statements(sql: string): string[] {
  const result: string[] = [];
  let current = '';
  let trigger = false;
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) || !line.trim()) continue;
    if (/^CREATE TRIGGER\b/.test(line)) trigger = true;
    current += line + '\n';
    if (line.trimEnd().endsWith(';') && (!trigger || /^END;\s*$/.test(line))) {
      result.push(current.trim()); current = ''; trigger = false;
    }
  }
  if (current.trim()) throw new Error('Incomplete migration statement');
  return result;
}
