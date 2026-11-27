const keys = ["q", "topic", "difficulty", "company"] as const;

export function initPracticeDiscovery(root: HTMLElement) {
  const form = root.querySelector<HTMLFormElement>("form");
  const status = root.querySelector<HTMLElement>("[data-filter-status]");
  const results = [
    ...root.querySelectorAll<HTMLElement>("[data-practice-result]"),
  ];
  if (!form || !status) return;
  const controls = keys.map((key) =>
    form.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[name="${key}"]`,
    )!,
  );

  function render() {
    const parameters = new URLSearchParams(window.location.search);
    for (const control of controls)
      control.value = parameters.get(control.name) ?? "";
    const query = controls[0]?.value.trim().toLowerCase() ?? "";
    const topic = parameters.get("topic") || "";
    const difficulty = parameters.get("difficulty") || "";
    const company = parameters.get("company") || "";
    let count = 0;
    for (const result of results) {
      const data = result.dataset;
      const matchesQuery = /^#?\d+$/u.test(query)
        ? Number(query.replace(/^#/u, "")) === Number(data.number)
        : (data.title ?? "").includes(query);
      const matches =
        matchesQuery &&
        (!topic || data.topics?.split(" ").includes(topic)) &&
        (!difficulty || data.difficulty === difficulty) &&
        (!company ||
          (company === "unknown"
            ? !data.companies
            : data.companies?.split(" ").includes(company)));
      result.hidden = !matches;
      if (matches) count++;
    }
    status!.textContent = count
      ? `${count} matching ${count === 1 ? "lesson" : "lessons"}`
      : "No lessons match these filters.";
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = new URL(window.location.href);
    for (const { name, value } of controls) {
      const filter = value.trim();
      if (filter) next.searchParams.set(name, filter);
      else next.searchParams.delete(name);
    }
    if (next.href !== window.location.href)
      window.history.pushState(null, "", next);
    render();
  });
  window.addEventListener("popstate", render);
  render();
  form.hidden = false;
}
