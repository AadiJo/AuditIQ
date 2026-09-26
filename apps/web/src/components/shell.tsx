import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Activity, FileText, Flag, LogOut, Search, Settings } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { Me } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import { activityQuery, contractsQuery, findingsQuery } from "../lib/queries.ts";
import { Logo } from "./icons.tsx";
import { Avatar } from "./ui.tsx";

const nav = [
  { to: "/contracts", label: "Contracts", icon: FileText },
  { to: "/findings", label: "Findings", icon: Flag },
  { to: "/jira", label: "Jira activity", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings, admin: true },
] as const;

function useNavCounts(): Record<string, number | undefined> {
  const contracts = useQuery({ ...contractsQuery, refetchInterval: false });
  const findings = useQuery({ ...findingsQuery, refetchInterval: false });
  const activity = useQuery({ ...activityQuery, refetchInterval: 60_000 });
  const pendingDecisions = activity.data?.decisions.filter(
    (d) => d.status === "pending" || d.status === "retry",
  ).length;
  return {
    "/contracts": contracts.data?.length,
    "/findings": findings.data?.length,
    "/jira": (pendingDecisions ?? 0) + (activity.data?.failedPublishes.length ?? 0) || undefined,
  };
}

function TopBar({ me }: { me: Me }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
      <Link to="/contracts" className="flex w-[220px] items-center gap-2 text-[15px] font-semibold">
        <Logo />
        AuditIQ
      </Link>
      <form
        className="flex h-8 w-[420px] items-center gap-2 rounded border border-[#B7B9BE] px-2.5 text-ink-3 focus-within:border-brand"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ to: "/findings", search: { q: query || undefined } });
        }}
      >
        <Search className="size-4" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search findings"
          className="h-full grow bg-transparent text-ink outline-none placeholder:text-ink-3"
        />
      </form>
      <div className="grow" />
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenu((open) => !open)}
          className="rounded-full"
          aria-label="Account menu"
        >
          <Avatar name={me.user.name} />
        </button>
        {menu && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setMenu(false)}
          />
        )}
        {menu && (
          <div className="absolute right-0 top-9 z-20 w-60 rounded-md bg-white py-2 shadow-[0_8px_12px_rgba(30,31,33,0.15),0_0_1px_rgba(30,31,33,0.31)]">
            <div className="px-4 pb-2">
              <div className="font-semibold">{me.user.name}</div>
              <div className="text-xs text-ink-3">
                {me.user.email}, {me.user.role}
              </div>
            </div>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-neutral"
              onClick={async () => {
                await authClient.signOut();
                queryClient.clear();
                navigate({ to: "/login" });
              }}
            >
              <LogOut className="size-4 text-ink-2" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

/**
 * The signed-in frame. Contract workspaces collapse the sidebar to an icon rail so the
 * panes get the width; every other page shows the full sidebar.
 */
export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const counts = useNavCounts();
  const rail = /^\/contracts\/[^/]+/.test(pathname);
  const items = nav.filter((item) => !("admin" in item) || me.user.role === "admin");

  return (
    <div className="flex h-full flex-col">
      <TopBar me={me} />
      <div className="flex min-h-0 grow">
        {rail ? (
          <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line py-3" aria-label="Main">
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                title={item.label}
                aria-label={item.label}
                className="grid size-8 place-items-center rounded text-ink-2 hover:bg-neutral data-[status=active]:bg-selected data-[status=active]:text-brand"
              >
                <item.icon className="size-4" />
              </Link>
            ))}
          </nav>
        ) : (
          <nav className="flex w-[232px] shrink-0 flex-col gap-0.5 border-r border-line px-2 py-3" aria-label="Main">
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="flex h-8 items-center gap-2.5 rounded px-2 font-medium text-ink-2 hover:bg-neutral data-[status=active]:bg-selected data-[status=active]:text-brand"
              >
                <item.icon className="size-4" />
                {item.label}
                {counts[item.to] !== undefined && (
                  <span className="ml-auto text-xs font-normal text-ink-3">{counts[item.to]}</span>
                )}
              </Link>
            ))}
          </nav>
        )}
        <main className="flex min-w-0 grow flex-col">{children}</main>
      </div>
    </div>
  );
}
