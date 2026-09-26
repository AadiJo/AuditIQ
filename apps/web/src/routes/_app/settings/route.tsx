import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/settings")({
  beforeLoad: ({ context }) => {
    const me = context.queryClient.getQueryData<{ user: { role: string } }>(["me"]);
    if (me?.user.role !== "admin") throw redirect({ to: "/contracts" });
  },
  component: SettingsLayout,
});

const pages = [
  { to: "/settings/jira", label: "Jira" },
  { to: "/settings/ai", label: "AI provider" },
  { to: "/settings/watcher", label: "Jira watcher" },
  { to: "/settings/members", label: "Members" },
  { to: "/settings/audit", label: "Audit log" },
] as const;

function SettingsLayout() {
  return (
    <div className="flex min-h-0 grow">
      <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-line px-2 py-5" aria-label="Settings">
        {pages.map((page) => (
          <Link
            key={page.to}
            to={page.to}
            className="flex h-8 items-center rounded px-2 font-medium text-ink-2 hover:bg-neutral data-[status=active]:bg-selected data-[status=active]:text-brand"
          >
            {page.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0 grow overflow-auto px-8 py-5">
        <div className="max-w-[560px]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
