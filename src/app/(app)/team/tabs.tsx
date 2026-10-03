import { TabLinks } from "@/components/ui/tab-links";

/**
 * The ways of looking at the same staff: one by one, by the groups they work
 * in, and by their hours on the clock. Shared so the pages keep the same
 * counts and order.
 */
export function TeamTabs({
  active,
  members,
  groups,
}: {
  active: "members" | "groups" | "clock";
  members: number;
  groups: number;
}) {
  return (
    <TabLinks
      tabs={[
        {
          href: "/team",
          label: "Members",
          count: members,
          active: active === "members",
        },
        {
          href: "/team/groups",
          label: "Groups",
          count: groups,
          active: active === "groups",
        },
        {
          href: "/team/time-clock",
          label: "Time clock",
          active: active === "clock",
        },
      ]}
    />
  );
}
