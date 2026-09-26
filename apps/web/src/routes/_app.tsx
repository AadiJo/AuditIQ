import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "../components/shell.tsx";
import { ApiError } from "../lib/api.ts";
import { meQuery } from "../lib/queries.ts";

// Every signed-in page lives under this layout. No session sends you to /login.
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    try {
      return { me: await context.queryClient.ensureQueryData(meQuery) };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw redirect({ to: "/login" });
      throw error;
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const { me } = Route.useRouteContext();
  return (
    <AppShell me={me}>
      <Outlet />
    </AppShell>
  );
}
