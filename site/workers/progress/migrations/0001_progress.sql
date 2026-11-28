CREATE TABLE progress (
  owner_id TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  studied INTEGER NOT NULL CHECK (studied IN (0, 1)),
  lesson_revision TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (owner_id, problem_id)
);
