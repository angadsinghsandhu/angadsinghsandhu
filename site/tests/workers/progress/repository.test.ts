import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgressRepository } from "../../../workers/progress/repository";

const migration = new URL(
  "../../../workers/progress/migrations/0001_progress.sql",
  import.meta.url,
);
const initial = {
  problemId: "leetcode:20",
  studied: true,
  lessonRevision: "first",
  expectedVersion: 0,
};

let sqlite: DatabaseSync;
let repository: ReturnType<typeof createProgressRepository>;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(migration, "utf8"));
  repository = createProgressRepository({
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...bindings) {
          return {
            async all<T>() {
              return { results: statement.all(...bindings) as T[] };
            },
            async first<T>() {
              return (statement.get(...bindings) as T | undefined) ?? null;
            },
          };
        },
      };
    },
  });
});

afterEach(() => sqlite.close());

describe("progress persistence", () => {
  it("rejects nonzero versions for missing rows", async () => {
    await expect(
      repository.save("owner", { ...initial, expectedVersion: 1 }, 100),
    ).resolves.toEqual({ kind: "conflict", row: null });
    await expect(repository.list("owner")).resolves.toEqual([]);
  });

  it("keeps an idempotent retry at the original version and timestamp", async () => {
    const saved = {
      kind: "saved",
      row: {
        problemId: "leetcode:20",
        studied: true,
        lessonRevision: "first",
        updatedAt: 100,
        version: 1,
      },
    };
    await expect(repository.save("owner", initial, 100)).resolves.toEqual(
      saved,
    );
    await expect(repository.save("owner", initial, 200)).resolves.toEqual(
      saved,
    );
    await expect(
      repository.save("owner", { ...initial, expectedVersion: 1 }, 300),
    ).resolves.toEqual(saved);
  });

  it("lets one changed write win for a version and returns the winner to the other", async () => {
    await repository.save("owner", initial, 100);
    const outcomes = await Promise.all([
      repository.save(
        "owner",
        { ...initial, studied: false, expectedVersion: 1 },
        200,
      ),
      repository.save(
        "owner",
        { ...initial, lessonRevision: "second", expectedVersion: 1 },
        300,
      ),
    ]);
    const winner = outcomes.find(({ kind }) => kind === "saved");
    const loser = outcomes.find(({ kind }) => kind === "conflict");
    expect(winner?.row).toMatchObject({ version: 2 });
    expect(loser?.row).toEqual(winner?.row);
    await expect(repository.list("owner")).resolves.toEqual([winner?.row]);
  });

  it("records a new lesson revision and allows studied to be undone", async () => {
    await repository.save("owner", initial, 100);
    await expect(
      repository.save(
        "owner",
        { ...initial, lessonRevision: "second", expectedVersion: 1 },
        200,
      ),
    ).resolves.toEqual({
      kind: "saved",
      row: {
        problemId: "leetcode:20",
        studied: true,
        lessonRevision: "second",
        updatedAt: 200,
        version: 2,
      },
    });
    await expect(
      repository.save(
        "owner",
        {
          ...initial,
          studied: false,
          lessonRevision: "second",
          expectedVersion: 2,
        },
        300,
      ),
    ).resolves.toEqual({
      kind: "saved",
      row: {
        problemId: "leetcode:20",
        studied: false,
        lessonRevision: "second",
        updatedAt: 300,
        version: 3,
      },
    });
  });

  it("keeps each owner's rows independent and lists them by problem ID", async () => {
    await repository.save("owner", initial, 100);
    await repository.save(
      "owner",
      { ...initial, problemId: "leetcode:1" },
      200,
    );
    await repository.save("other", { ...initial, studied: false }, 300);

    expect(
      (await repository.list("owner")).map(({ problemId }) => problemId),
    ).toEqual(["leetcode:1", "leetcode:20"]);
    await expect(repository.list("other")).resolves.toEqual([
      {
        problemId: "leetcode:20",
        studied: false,
        lessonRevision: "first",
        updatedAt: 300,
        version: 1,
      },
    ]);
  });
});
