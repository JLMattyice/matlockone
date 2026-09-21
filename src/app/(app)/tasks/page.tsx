import type { Metadata } from "next";

import { asTaskView, listTasks, taskCounts } from "./queries";
import { TaskList } from "@/components/tasks/task-list";
import { Card } from "@/components/ui/card";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    assignee?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const { user, org } = await requirePermission("tasks:read");
  const params = await searchParams;
  const view = asTaskView(params.view);

  const [list, counts, people] = await Promise.all([
    listTasks({
      organizationId: org.id,
      actor: user,
      view,
      assignee: params.assignee,
      q: params.q,
      page: Number(params.page) || 1,
    }),
    taskCounts(org.id, user),
    prisma.user.findMany({
      where: { organizationId: org.id, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const writable = can(user, "tasks:write");
  const seesEveryone = can(user, "tasks:read:all");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description={
          counts.overdue > 0
            ? `${counts.open} open · ${counts.overdue} overdue`
            : `${counts.open} open`
        }
      />

      <ListToolbar
        searchPlaceholder="Search tasks…"
        filters={[
          {
            name: "view",
            label: "tasks",
            options: [
              { value: "open", label: `Open (${counts.open})` },
              { value: "today", label: `Due today (${counts.today})` },
              { value: "overdue", label: `Overdue (${counts.overdue})` },
              { value: "done", label: `Done (${counts.done})` },
            ],
          },
          // Narrowing by person only means something to somebody who can see
          // more than their own list.
          ...(seesEveryone
            ? [
                {
                  name: "assignee",
                  label: "anyone",
                  options: [
                    { value: "me", label: "Mine" },
                    { value: "unassigned", label: "Unassigned" },
                    ...people.map((person) => ({
                      value: person.id,
                      label: person.name,
                    })),
                  ],
                },
              ]
            : []),
        ]}
      />

      <Card className="overflow-hidden">
        <TaskList
          tasks={list.rows}
          people={people}
          canWrite={writable}
          emptyTitle={
            view === "done"
              ? "Nothing finished yet"
              : view === "overdue"
                ? "Nothing is overdue"
                : "Nothing to do"
          }
          emptyDescription={
            view === "overdue"
              ? "Everything with a date on it is still in hand."
              : "Add the next thing that needs doing and it will show up here."
          }
        />

        {list.rows.length > 0 ? (
          <Pagination
            page={list.page}
            pageCount={list.pageCount}
            total={list.total}
            pageSize={list.pageSize}
            pathname="/tasks"
            params={params}
            itemLabel="tasks"
          />
        ) : null}
      </Card>
    </div>
  );
}
