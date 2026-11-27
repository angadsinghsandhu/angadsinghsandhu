import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../../workers/progress/index.ts";
import { verifyAccess } from "../../../workers/progress/access.ts";
import {
  createProgressRepository,
  type ProgressDatabase,
} from "../../../workers/progress/repository.ts";

vi.mock("../../../workers/progress/access.ts", () => ({
  verifyAccess: vi.fn(),
}));
vi.mock("../../../workers/progress/repository.ts", () => ({
  createProgressRepository: vi.fn(),
}));

const origin = "https://portfolio.example";
const owner = "private-owner-subject";
const env = {
  PRIVATE_ORIGIN: origin,
  ACCESS_ISSUER: "https://identity.example",
  ACCESS_AUDIENCE: "expected-audience",
  ACCESS_OWNER_SUBJECT: owner,
  PROGRESS: { prepare: vi.fn<ProgressDatabase["prepare"]>() },
};
const change = {
  problemId: "leetcode:1",
  studied: true,
  lessonRevision: "1".repeat(64),
  expectedVersion: 0,
};
const row = {
  problemId: change.problemId,
  studied: change.studied,
  lessonRevision: change.lessonRevision,
  updatedAt: 1234,
  version: 1,
};
const repository = {
  list: vi.fn<ReturnType<typeof createProgressRepository>["list"]>(),
  save: vi.fn<ReturnType<typeof createProgressRepository>["save"]>(),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyAccess).mockResolvedValue(owner);
  vi.mocked(createProgressRepository).mockReturnValue(repository);
  repository.list.mockResolvedValue([row]);
  repository.save.mockResolvedValue({ kind: "saved", row });
});

function request(path = "/api/progress/", init?: RequestInit) {
  return worker.fetch(new Request(origin + path, init), env);
}

function put(
  body = JSON.stringify(change),
  suppliedOrigin: string | null = origin,
) {
  return request("/api/progress/", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(suppliedOrigin ? { Origin: suppliedOrigin } : {}),
    },
    body,
  });
}

describe("private progress route", () => {
  it("rejects an alternate host, a lookalike path, and an insecure request before identity or database work", async () => {
    for (const url of [
      "https://alternate.example/api/progress/",
      "http://portfolio.example/api/progress/",
      origin + "/api/progress/unknown",
      origin + "/api/progress",
    ]) {
      const response = await worker.fetch(new Request(url), env);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(verifyAccess).not.toHaveBeenCalled();
    expect(createProgressRepository).not.toHaveBeenCalled();
  });

  it("blocks unsigned and wrong-owner credentials before all routes including export", async () => {
    for (const subject of [null, "someone-else"]) {
      vi.mocked(verifyAccess).mockResolvedValue(subject);
      for (const path of [
        "/account/",
        "/api/progress/",
        "/api/progress/export/",
      ]) {
        const response = await request(path);
        expect(response.status).toBe(401);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      }
    }
    expect(createProgressRepository).not.toHaveBeenCalled();
  });

  it("returns versioned private rows from the bound owner and offers a versioned attachment", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toEqual({ version: 1, rows: [row] });
    expect(verifyAccess).toHaveBeenCalledWith(expect.any(Request), {
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUDIENCE,
      ownerSubject: owner,
    });
    expect(repository.list).toHaveBeenCalledWith(owner);
    const exported = await request("/api/progress/export/");
    expect(exported.headers.get("Content-Disposition")).toBe(
      'attachment; filename="portfolio-progress-v1.json"',
    );
    expect(await exported.json()).toEqual({ version: 1, rows: [row] });
  });

  it("renders studied links on the protected account page without exposing subject or revision", async () => {
    repository.list.mockResolvedValueOnce([
      row,
      { ...row, problemId: "leetcode:2", studied: false },
      { ...row, problemId: 'leetcode:3"><script>unsafe</script>' },
    ]);
    const response = await request("/account/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(html).toContain('href="/cdn-cgi/access/logout"');
    expect(html).toContain('href="/api/progress/export/"');
    expect(html).not.toContain(owner);
    expect(html).not.toContain(row.lessonRevision);
    expect(html).toContain('href="/practice/leetcode/"');
    expect(html).toContain('href="/practice/leetcode/1/"');
    expect(html).toContain("1 studied lesson");
    expect(html).not.toContain('href="/practice/leetcode/2/"');
    expect(html).not.toContain("<script>");
    expect(repository.list).toHaveBeenCalledWith(owner);
  });

  it("allows only supported methods after authentication", async () => {
    const submitted = await request("/account/", { method: "POST" });
    const options = await request("/", { method: "OPTIONS" });
    const unsupported = await request("/api/progress/", { method: "PATCH" });
    expect(submitted.status).toBe(405);
    expect(submitted.headers.get("Allow")).toBe("GET");
    expect(options.status).toBe(404);
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("Allow")).toBe("GET, PUT");
    expect(createProgressRepository).not.toHaveBeenCalled();
  });

  it.each([null, "null", "https://another.example", origin + "/"])(
    "rejects a write without the exact Origin header (%s)",
    async (badOrigin) => {
      const response = await put(JSON.stringify(change), badOrigin);
      expect(response.status).toBe(403);
      expect(createProgressRepository).not.toHaveBeenCalled();
    },
  );

  it("accepts a strict same-origin write and returns the current row on conflict", async () => {
    const valid = await put();
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ row });
    expect(repository.save).toHaveBeenCalledWith(
      owner,
      change,
      expect.any(Number),
    );

    repository.save.mockResolvedValueOnce({ kind: "conflict", row });
    const conflict = await put();
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ row });
  });

  it.each([
    { problemId: "leetcode:0" },
    { problemId: "leetcode:01" },
    { problemId: "leetcode:2001" },
    { problemId: "leetcode:1\n" },
    { studied: "true" },
    { lessonRevision: "A".repeat(64) },
    { expectedVersion: -1 },
    { expectedVersion: 1.5 },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ownerId: "another-user" },
  ])("rejects an invalid write %o before database access", async (override) => {
    expect((await put(JSON.stringify({ ...change, ...override }))).status).toBe(
      400,
    );
    expect(createProgressRepository).not.toHaveBeenCalled();
  });

  it("rejects non-JSON, malformed or oversized uploads before database access", async () => {
    expect((await put("{")).status).toBe(400);
    expect((await put(" ".repeat(8192))).status).toBe(413);
    expect(
      (
        await request("/api/progress/", {
          method: "PUT",
          headers: { Origin: origin, "Content-Type": "text/plain" },
          body: JSON.stringify(change),
        })
      ).status,
    ).toBe(415);
    expect(createProgressRepository).not.toHaveBeenCalled();
  });

  it("keeps database errors private", async () => {
    repository.list.mockRejectedValueOnce(new Error("private database detail"));
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("private database detail");
  });
});
