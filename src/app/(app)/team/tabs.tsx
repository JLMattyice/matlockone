import { TabLinks } from "@/components/ui/tab-links";

/**
 * The two ways of looking at the same staff: one by one, or by the groups
 * they work in. Shared so both pages keep the same counts and order.
 */
export function TeamTabs({
  active,
  members,
  groups,
}: {
  active: "members" | "groups";
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
      ]}
    />
  );
}
