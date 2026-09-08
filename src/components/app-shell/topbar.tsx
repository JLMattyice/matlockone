import { GlobalSearch } from "./global-search";
import { NotificationBell } from "./notification-bell";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import type { Role } from "@/lib/constants";
import {
  recentNotifications,
  unreadNotificationCount,
} from "@/lib/notifications";

export async function Topbar({
  user,
  canOpenSettings,
  searchPlaceholder,
}: {
  searchPlaceholder: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: Role;
    avatarUrl: string | null;
  };
  canOpenSettings: boolean;
}) {
  const [notifications, unreadCount] = await Promise.all([
    recentNotifications(user.id),
    unreadNotificationCount(user.id),
  ]);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-sm lg:px-6 print:hidden">
      <div className="w-9 lg:hidden" aria-hidden />

      <div className="hidden max-w-md flex-1 sm:block">
        <GlobalSearch placeholder={searchPlaceholder} />
      </div>

      <div className="flex flex-1 items-center justify-end gap-2 sm:flex-none">
        <ThemeToggle />

        <NotificationBell
          notifications={notifications}
          unreadCount={unreadCount}
        />

        <UserMenu
          name={user.name}
          email={user.email}
          role={user.role}
          avatarUrl={user.avatarUrl}
          canOpenSettings={canOpenSettings}
        />
      </div>
    </header>
  );
}
