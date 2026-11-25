CREATE TABLE release_operations (
  target TEXT NOT NULL,
  id INTEGER NOT NULL CHECK (id > 0),
  operationKey TEXT NOT NULL,
  previousId INTEGER CHECK (previousId > 0 AND previousId < id),
  kind TEXT NOT NULL CHECK (kind IN ('release', 'rollback')),
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  proof TEXT NOT NULL CHECK (json_valid(proof)),
  rollbackId INTEGER CHECK (rollbackId > 0 AND rollbackId < id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed', 'aborted')),
  deploymentId TEXT,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finishedAt TEXT,
  PRIMARY KEY (target, id),
  UNIQUE (target, operationKey),
  FOREIGN KEY (target, previousId) REFERENCES release_operations (target, id),
  FOREIGN KEY (target, rollbackId) REFERENCES release_operations (target, id),
  CHECK ((kind = 'rollback') = (rollbackId IS NOT NULL)),
  CHECK (kind != 'rollback' OR previousId IS NOT NULL),
  CHECK ((state = 'confirmed') = (deploymentId IS NOT NULL)),
  CHECK ((state = 'pending') = (finishedAt IS NULL))
) STRICT;

CREATE UNIQUE INDEX release_one_pending ON release_operations (target) WHERE state = 'pending';
CREATE INDEX release_confirmed ON release_operations (target, id) WHERE state = 'confirmed';
