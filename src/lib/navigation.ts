import type { Permission } from "./permissions";

export type NavItem = {
  href: string;
  /** Static label, or a function that applies the org's custom terminology. */
  label: string | ((labels: OrgLabels) => string);
  icon: NavIcon;
  permission: Permission;
};

export type NavGroup = { title: string; items: NavItem[] };

export type OrgLabels = {
  jobSingular: string;
  jobPlural: string;
  clientSingular: string;
  clientPlural: string;
};

export type NavIcon =
  | "dashboard"
  | "calendar"
  | "briefcase"
  | "file-text"
  | "receipt"
  | "credit-card"
  | "banknote"
  | "users"
  | "target"
  | "hard-hat"
  | "bar-chart"
  | "folder"
  | "settings";

export const NAVIGATION: NavGroup[] = [
  {
    title: "Overview",
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: "dashboard",
        permission: "jobs:read",
      },
    ],
  },
  {
    title: "Work",
    items: [
      {
        href: "/schedule",
        label: "Schedule",
        icon: "calendar",
        permission: "schedule:read",
      },
      {
        href: "/jobs",
        label: (l) => l.jobPlural,
        icon: "briefcase",
        permission: "jobs:read",
      },
      {
        href: "/estimates",
        label: "Estimates",
        icon: "file-text",
        permission: "estimates:read",
      },
      {
        href: "/invoices",
        label: "Invoices",
        icon: "receipt",
        permission: "invoices:read",
      },
      {
        href: "/payments",
        label: "Payments",
        icon: "credit-card",
        permission: "payments:read",
      },
      {
        href: "/expenses",
        label: "Expenses",
        icon: "banknote",
        permission: "expenses:read",
      },
    ],
  },
  {
    title: "People",
    items: [
      {
        href: "/clients",
        label: (l) => l.clientPlural,
        icon: "users",
        permission: "clients:read",
      },
      {
        href: "/leads",
        label: "Leads",
        icon: "target",
        permission: "leads:read",
      },
      {
        href: "/team",
        label: "Team",
        icon: "hard-hat",
        permission: "employees:read",
      },
    ],
  },
  {
    title: "Business",
    items: [
      {
        href: "/reports",
        label: "Reports",
        icon: "bar-chart",
        permission: "reports:read",
      },
      {
        href: "/files",
        label: "Files",
        icon: "folder",
        permission: "files:read",
      },
      {
        href: "/settings",
        label: "Settings",
        icon: "settings",
        permission: "settings:read",
      },
    ],
  },
];

/**
 * Nav labels are functions so the org's terminology can be applied late. They
 * must be resolved on the server: a function cannot be serialized across the
 * boundary into a client component.
 */
export type ResolvedNavItem = {
  href: string;
  label: string;
  icon: NavIcon;
};

export type ResolvedNavGroup = { title: string; items: ResolvedNavItem[] };

export function resolveLabel(item: NavItem, labels: OrgLabels) {
  return typeof item.label === "function" ? item.label(labels) : item.label;
}

export function resolveNavigation(
  groups: NavGroup[],
  labels: OrgLabels,
): ResolvedNavGroup[] {
  return groups.map((group) => ({
    title: group.title,
    items: group.items.map((item) => ({
      href: item.href,
      label: resolveLabel(item, labels),
      icon: item.icon,
    })),
  }));
}

export function orgLabels(org: {
  labelJobSingular: string;
  labelJobPlural: string;
  labelClientSingular: string;
  labelClientPlural: string;
}): OrgLabels {
  return {
    jobSingular: org.labelJobSingular,
    jobPlural: org.labelJobPlural,
    clientSingular: org.labelClientSingular,
    clientPlural: org.labelClientPlural,
  };
}
