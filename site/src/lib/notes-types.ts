import type { PortfolioSnapshotV1 } from "./notes-snapshot-v1";

export type ContentEntry = PortfolioSnapshotV1["entries"][number];
export type Section = ContentEntry["section"];
export type Heading = ContentEntry["headings"][number];
export type OrganizationSnapshot = PortfolioSnapshotV1["organization"];
export type Topic = OrganizationSnapshot["topics"][number];
export type Collection = OrganizationSnapshot["collections"][number];
export type Group = OrganizationSnapshot["groups"][number];
export type LearningPath = OrganizationSnapshot["paths"][number];
export type Membership = OrganizationSnapshot["memberships"][number];
export type EditorialStatus = Membership["status"];
export type Purpose = Membership["purpose"];
