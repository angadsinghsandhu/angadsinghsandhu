import { expect, it } from "vitest";
import { approved, profile, projects } from "../../src/content/editorial";

it("publishes an introduction, a résumé, and three complete selected projects", () => {
  expect(profile.intro).toMatch(/^I\b/);
  expect(profile.resume?.summary.trim()).toBeTruthy();
  expect(profile.resume?.sections.map(({ heading }) => heading)).toEqual([
    "Experience",
    "Education",
    "Research and talks",
    "Selected projects",
  ]);
  expect(
    profile.resume?.sections.every(({ items }) =>
      items.some((item) => item.trim()),
    ),
  ).toBe(true);

  const selected = approved(projects);
  expect(selected.map(({ slug }) => slug)).toEqual([
    "dagnam-ai",
    "temporal-topic-analysis",
    "tensortorch",
  ]);
  for (const project of selected) {
    expect(project.summary.trim()).toBeTruthy();
    expect(project.body.some((paragraph) => paragraph.trim())).toBe(true);
    expect(project.links.some(({ href }) => href.startsWith("https://"))).toBe(
      true,
    );
  }
});
