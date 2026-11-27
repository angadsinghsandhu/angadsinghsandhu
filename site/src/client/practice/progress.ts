type ProgressRow = {
  problemId: string;
  studied: boolean;
  lessonRevision: string;
  version: number;
  updatedAt: number;
};

type Change = Pick<ProgressRow, "problemId" | "studied" | "lessonRevision"> & {
  expectedVersion: number;
};

const endpoint = "/api/progress/";
const revisionPattern = /^[a-f0-9]{64}$/u;
const problemPattern = /^leetcode:(?:[1-9][0-9]{0,2}|1[0-9]{3}|2000)$/u;
const fetchOptions = {
  cache: "no-store",
  credentials: "same-origin",
  redirect: "manual",
} as const;

function progressRow(value: unknown): value is ProgressRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ProgressRow>;
  return (
    typeof row.problemId === "string" &&
    problemPattern.test(row.problemId) &&
    typeof row.studied === "boolean" &&
    typeof row.lessonRevision === "string" &&
    revisionPattern.test(row.lessonRevision) &&
    typeof row.version === "number" &&
    Number.isSafeInteger(row.version) &&
    row.version > 0 &&
    typeof row.updatedAt === "number" &&
    Number.isSafeInteger(row.updatedAt) &&
    row.updatedAt >= 0
  );
}

function sessionEnded(response: Response) {
  return (
    response.type === "opaqueredirect" ||
    response.status === 401 ||
    response.status === 403
  );
}

export function initOwnerProgress(document: Document) {
  const view = document.defaultView;
  if (!view) return;
  const items = [
    ...document.querySelectorAll<HTMLElement>("[data-owner-progress-item]"),
  ].flatMap((element) => {
    const { problemId, lessonRevision } = element.dataset;
    const toggle = element.querySelector<HTMLButtonElement>(
      "[data-progress-toggle]",
    );
    const retry = element.querySelector<HTMLButtonElement>(
      "[data-progress-retry]",
    );
    const status = element.querySelector<HTMLElement>("[data-progress-status]");
    return problemId &&
      problemPattern.test(problemId) &&
      lessonRevision &&
      revisionPattern.test(lessonRevision) &&
      toggle &&
      retry &&
      status
      ? [{ element, problemId, lessonRevision, toggle, retry, status }]
      : [];
  });
  if (!items.length) return;

  let rows = new Map<string, ProgressRow>();
  const interrupted = new Map<string, Change>();
  const saving = new Set<string>();
  const messages = new Map<string, string>();
  let ready = false;
  let session = 0;
  let refreshNumber = 0;

  function paint() {
    for (const {
      element,
      problemId,
      lessonRevision,
      toggle,
      retry,
      status,
    } of items) {
      const row = rows.get(problemId);
      element.hidden = !ready;
      toggle.disabled = saving.has(problemId) || interrupted.has(problemId);
      toggle.textContent = row?.studied ? "Mark unstudied" : "Mark studied";
      toggle.setAttribute("aria-pressed", String(Boolean(row?.studied)));
      retry.hidden = !interrupted.has(problemId);
      retry.disabled = saving.has(problemId);
      const message = messages.get(problemId) ?? "";
      const revised = row?.studied && row.lessonRevision !== lessonRevision;
      status.textContent = revised
        ? `${message} Lesson changed since you studied it.`.trimStart()
        : message;
    }
  }

  function clear() {
    session++;
    refreshNumber++;
    ready = false;
    rows.clear();
    interrupted.clear();
    saving.clear();
    messages.clear();
    paint();
  }

  async function refresh() {
    const request = ++refreshNumber;
    try {
      const response = await view!.fetch(endpoint, fetchOptions);
      if (request !== refreshNumber) return;
      if (sessionEnded(response)) {
        clear();
        return;
      }
      if (!response.ok) return;
      const result: { version?: unknown; rows?: unknown } =
        await response.json();
      if (
        request !== refreshNumber ||
        result.version !== 1 ||
        !Array.isArray(result.rows) ||
        result.rows.length > 2000 ||
        !result.rows.every(progressRow)
      )
        return;
      rows = new Map(result.rows.map((row) => [row.problemId, row]));
      ready = true;
      paint();
    } catch {
      // A failed read leaves the current display intact and never writes progress.
    }
  }

  async function save(change: Change) {
    const { problemId } = change;
    if (!ready || saving.has(problemId)) return;
    const expectedSession = session;
    saving.add(problemId);
    messages.set(problemId, "Saving…");
    paint();
    try {
      const response = await view!.fetch(endpoint, {
        ...fetchOptions,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      if (session !== expectedSession) return;
      if (sessionEnded(response)) {
        clear();
        return;
      }
      if (!response.ok && response.status !== 409) throw new Error();
      const result: { row?: unknown } = await response.json();
      if (session !== expectedSession) return;
      if (progressRow(result.row) && result.row.problemId === problemId) {
        rows.set(problemId, result.row);
      } else if (result.row === null && response.status === 409) {
        rows.delete(problemId);
      } else {
        throw new Error();
      }
      interrupted.delete(problemId);
      messages.set(
        problemId,
        response.status === 409
          ? "Changed on another device. Review the current state."
          : "Saved.",
      );
      void refresh();
    } catch {
      if (session !== expectedSession) return;
      interrupted.set(problemId, change);
      messages.set(problemId, "Could not save. Your change is unsaved.");
    } finally {
      if (session === expectedSession) {
        saving.delete(problemId);
        paint();
      }
    }
  }

  for (const { problemId, lessonRevision, toggle, retry } of items) {
    toggle.addEventListener("click", () => {
      const row = rows.get(problemId);
      void save({
        problemId,
        lessonRevision,
        studied: !row?.studied,
        expectedVersion: row?.version ?? 0,
      });
    });
    retry.addEventListener("click", () => {
      const change = interrupted.get(problemId);
      if (change && view.confirm("Retry the unsaved progress change?"))
        void save(change);
    });
  }

  view.addEventListener("focus", () => void refresh());
  view.addEventListener("pageshow", (event) => {
    if (event.persisted) void refresh();
  });
  view.addEventListener("pagehide", clear);
  void refresh();
}
