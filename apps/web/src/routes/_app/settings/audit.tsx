import { createFileRoute } from "@tanstack/react-router";
import { Download } from "lucide-react";

export const Route = createFileRoute("/_app/settings/audit")({ component: AuditSettings });

function AuditSettings() {
  return (
    <>
      <h1 className="text-xl font-semibold">Audit log</h1>
      <p className="mt-2 text-ink-2">
        AuditIQ records every run, finding, Jira write, watcher decision, and settings change, with the person who
        caused it. The export is one JSON file with all of it. Secrets and sessions are left out.
      </p>
      <a
        href="/api/audit/export"
        className="mt-4 inline-flex h-8 items-center gap-1.5 rounded bg-neutral px-3 font-medium hover:bg-neutral-hover"
      >
        <Download className="size-4" />
        Download audit export
      </a>
      <p className="mt-6 text-ink-2">
        For backups, run <code className="rounded bg-neutral px-1">pnpm backup</code> on the server. It copies the
        database and uploaded files into the data directory's backups folder.
      </p>
    </>
  );
}
