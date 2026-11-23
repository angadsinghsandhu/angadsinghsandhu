import { approved, projects, releases } from "./editorial";

declare const __PORTFOLIO_DEV__: boolean;

export const useFixtures =
  __PORTFOLIO_DEV__ && import.meta.env.MODE === "fixtures";

const fixtures = useFixtures
  ? await import("../../tests/fixtures/editorial")
  : undefined;

export const publishedProjects = approved(
  fixtures ? [...projects, ...fixtures.projects] : projects,
);
export const publishedReleases = approved(
  fixtures ? [...releases, ...fixtures.releases] : releases,
);
