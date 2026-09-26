import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: () => (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <div className="text-lg font-semibold">Page not found</div>
        <a className="mt-2 inline-block text-brand" href="/contracts">
          Go to contracts
        </a>
      </div>
    </div>
  ),
});
