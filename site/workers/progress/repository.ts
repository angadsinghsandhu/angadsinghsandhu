interface ProgressQuery {
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface ProgressDatabase {
  prepare(sql: string): {
    bind(...values: (string | number)[]): ProgressQuery;
  };
}

export interface ProgressRow {
  problemId: string;
  studied: boolean;
  lessonRevision: string;
  updatedAt: number;
  version: number;
}

type StoredProgressRow = Omit<ProgressRow, "studied"> & { studied: number };
type ProgressChange = Pick<
  ProgressRow,
  "problemId" | "studied" | "lessonRevision"
> & { expectedVersion: number };

const columns = `problem_id AS problemId, studied, lesson_revision AS lessonRevision,
  updated_at AS updatedAt, version`;

function toProgressRow(row: StoredProgressRow): ProgressRow {
  return { ...row, studied: row.studied === 1 };
}

export function createProgressRepository(db: ProgressDatabase) {
  return {
    async list(ownerId: string): Promise<ProgressRow[]> {
      const { results } = await db
        .prepare(
          `SELECT ${columns} FROM progress WHERE owner_id = ? ORDER BY problem_id`,
        )
        .bind(ownerId)
        .all<StoredProgressRow>();
      return results.map(toProgressRow);
    },

    async save(
      ownerId: string,
      change: ProgressChange,
      timestampMs: number,
    ): Promise<{ kind: "saved" | "conflict"; row: ProgressRow | null }> {
      const { problemId, studied, lessonRevision, expectedVersion } = change;
      const written = await db
        .prepare(
          `INSERT INTO progress (owner_id, problem_id, studied, lesson_revision, updated_at, version)
          SELECT ?1, ?2, ?3, ?4, ?5, 1
          WHERE ?6 = 0 OR EXISTS (
            SELECT 1 FROM progress WHERE owner_id = ?1 AND problem_id = ?2
          )
          ON CONFLICT (owner_id, problem_id) DO UPDATE SET
            studied = excluded.studied,
            lesson_revision = excluded.lesson_revision,
            updated_at = excluded.updated_at,
            version = progress.version + 1
          WHERE progress.version = ?6
            AND (progress.studied != excluded.studied
              OR progress.lesson_revision != excluded.lesson_revision)
          RETURNING ${columns}`,
        )
        .bind(
          ownerId,
          problemId,
          Number(studied),
          lessonRevision,
          timestampMs,
          expectedVersion,
        )
        .first<StoredProgressRow>();
      if (written) return { kind: "saved", row: toProgressRow(written) };

      const stored = await db
        .prepare(
          `SELECT ${columns} FROM progress WHERE owner_id = ? AND problem_id = ?`,
        )
        .bind(ownerId, problemId)
        .first<StoredProgressRow>();
      const row = stored ? toProgressRow(stored) : null;
      const same =
        row?.studied === studied && row.lessonRevision === lessonRevision;
      return { kind: same ? "saved" : "conflict", row };
    },
  };
}
