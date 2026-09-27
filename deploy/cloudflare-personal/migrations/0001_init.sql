-- Personal Deskly uses its own D1 database. Do not bind a company ledger here.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  purpose TEXT NOT NULL DEFAULT '',
  repository_url TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL CHECK(scope IN ('personal', 'hybrid')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
  next_action TEXT NOT NULL DEFAULT '',
  check_date TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('未確認', '進行中', '待ち', '完了', '保留')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX work_items_project ON work_items(project_id, state, check_date);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor TEXT NOT NULL,
  at_utc TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL
);

CREATE TRIGGER projects_created AFTER INSERT ON projects BEGIN
  INSERT INTO events(entity_type, entity_id, operation, actor, at_utc, before_json, after_json)
  VALUES ('project', NEW.id, 'create', NEW.updated_by, NEW.updated_at, NULL,
    json_object('name', NEW.name, 'purpose', NEW.purpose, 'repository_url', NEW.repository_url,
      'scope', NEW.scope, 'version', NEW.version));
END;
CREATE TRIGGER projects_updated AFTER UPDATE ON projects BEGIN
  INSERT INTO events(entity_type, entity_id, operation, actor, at_utc, before_json, after_json)
  VALUES ('project', NEW.id, 'update', NEW.updated_by, NEW.updated_at,
    json_object('name', OLD.name, 'purpose', OLD.purpose, 'repository_url', OLD.repository_url,
      'scope', OLD.scope, 'version', OLD.version),
    json_object('name', NEW.name, 'purpose', NEW.purpose, 'repository_url', NEW.repository_url,
      'scope', NEW.scope, 'version', NEW.version));
END;
CREATE TRIGGER work_items_created AFTER INSERT ON work_items BEGIN
  INSERT INTO events(entity_type, entity_id, operation, actor, at_utc, before_json, after_json)
  VALUES ('work_item', NEW.id, 'create', NEW.updated_by, NEW.updated_at, NULL,
    json_object('project_id', NEW.project_id, 'title', NEW.title, 'next_action', NEW.next_action,
      'check_date', NEW.check_date, 'state', NEW.state, 'version', NEW.version));
END;
CREATE TRIGGER work_items_updated AFTER UPDATE ON work_items BEGIN
  INSERT INTO events(entity_type, entity_id, operation, actor, at_utc, before_json, after_json)
  VALUES ('work_item', NEW.id, 'update', NEW.updated_by, NEW.updated_at,
    json_object('project_id', OLD.project_id, 'title', OLD.title, 'next_action', OLD.next_action,
      'check_date', OLD.check_date, 'state', OLD.state, 'version', OLD.version),
    json_object('project_id', NEW.project_id, 'title', NEW.title, 'next_action', NEW.next_action,
      'check_date', NEW.check_date, 'state', NEW.state, 'version', NEW.version));
END;
