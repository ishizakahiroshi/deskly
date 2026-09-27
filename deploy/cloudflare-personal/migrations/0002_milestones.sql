CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  goal TEXT NOT NULL CHECK(length(goal) BETWEEN 1 AND 240),
  acceptance TEXT NOT NULL DEFAULT '',
  check_date TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('未確認', '進行中', '待ち', '完了', '保留')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX milestones_project ON milestones(project_id, state, check_date);
ALTER TABLE work_items ADD COLUMN milestone_id TEXT REFERENCES milestones(id);

CREATE TRIGGER milestones_created AFTER INSERT ON milestones BEGIN
  INSERT INTO events(entity_type, entity_id, operation, actor, at_utc, before_json, after_json)
  VALUES ('milestone', NEW.id, 'create', NEW.updated_by, NEW.updated_at, NULL,
    json_object('project_id', NEW.project_id, 'goal', NEW.goal, 'acceptance', NEW.acceptance,
      'check_date', NEW.check_date, 'state', NEW.state, 'version', NEW.version));
END;
CREATE TRIGGER milestones_updated AFTER UPDATE ON milestones BEGIN
  INSERT INTO events(entity_type, entity_id, operation, actor, at_utc, before_json, after_json)
  VALUES ('milestone', NEW.id, 'update', NEW.updated_by, NEW.updated_at,
    json_object('project_id', OLD.project_id, 'goal', OLD.goal, 'acceptance', OLD.acceptance,
      'check_date', OLD.check_date, 'state', OLD.state, 'version', OLD.version),
    json_object('project_id', NEW.project_id, 'goal', NEW.goal, 'acceptance', NEW.acceptance,
      'check_date', NEW.check_date, 'state', NEW.state, 'version', NEW.version));
END;

DROP TRIGGER work_items_created;
DROP TRIGGER work_items_updated;
CREATE TRIGGER work_items_created AFTER INSERT ON work_items BEGIN
  INSERT INTO events(entity_type, entity_id, operation, actor, at_utc, before_json, after_json)
  VALUES ('work_item', NEW.id, 'create', NEW.updated_by, NEW.updated_at, NULL,
    json_object('project_id', NEW.project_id, 'milestone_id', NEW.milestone_id,
      'title', NEW.title, 'next_action', NEW.next_action,
      'check_date', NEW.check_date, 'state', NEW.state, 'version', NEW.version));
END;
CREATE TRIGGER work_items_updated AFTER UPDATE ON work_items BEGIN
  INSERT INTO events(entity_type, entity_id, operation, actor, at_utc, before_json, after_json)
  VALUES ('work_item', NEW.id, 'update', NEW.updated_by, NEW.updated_at,
    json_object('project_id', OLD.project_id, 'milestone_id', OLD.milestone_id,
      'title', OLD.title, 'next_action', OLD.next_action,
      'check_date', OLD.check_date, 'state', OLD.state, 'version', OLD.version),
    json_object('project_id', NEW.project_id, 'milestone_id', NEW.milestone_id,
      'title', NEW.title, 'next_action', NEW.next_action,
      'check_date', NEW.check_date, 'state', NEW.state, 'version', NEW.version));
END;
