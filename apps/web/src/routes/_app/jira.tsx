import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, SectionMessage } from "../../components/ui.tsx";
import { api, unwrap } from "../../lib/api.ts";
import { formatRelative } from "../../lib/format.ts";
import { activityQuery, meQuery } from "../../lib/queries.ts";

export const Route = createFileRoute("/_app/jira")({ component: JiraActivityPage });

const modeText = {
  off: "The watcher is off. Mentions of @AuditIQ are ignored.",
  shadow: "The watcher is in shadow mode. It records what it would reply, but posts nothing.",
  assist: "The watcher answers @AuditIQ questions with replies grounded in the finding's quotes.",
} as const;

/** What happened in Jira: status changes, comments, watcher decisions, and publishes that need a retry. */
function JiraActivityPage() {
  const activity = useQuery(activityQuery);
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const poll = useMutation({
    mutationFn: () => unwrap(api.jira.poll.$post()),
    onSettled: () => queryClient.invalidateQueries(),
  });
  const data = activity.data;
  if (!data) return null;
  const admin = me.data?.user.role === "admin";

  return (
    <div className="min-h-0 grow overflow-auto px-6 py-5">
      <div className="flex items-center gap-2">
        <h1 className="grow text-xl font-semibold">Jira activity</h1>
        {admin && data.configured && (
          <Button onClick={() => poll.mutate()} disabled={poll.isPending}>
            <RefreshCw className="size-4" />
            {poll.isPending ? "Checking Jira" : "Check Jira now"}
          </Button>
        )}
      </div>
      {!data.configured ? (
        <div className="mt-4">
          <SectionMessage tone="info" title="Jira isn't connected">
            {admin ? (
              <>
                <Link to="/settings/jira" className="text-brand">
                  Connect a Jira project
                </Link>{" "}
                to publish findings and follow them here.
              </>
            ) : (
              "Ask an admin to connect a Jira project."
            )}
          </SectionMessage>
        </div>
      ) : (
        <>
          <div className="mt-2 text-ink-2">
            {data.projectKey} on {data.siteUrl.replace(/^https:\/\//, "")}. Last checked{" "}
            {data.poll.lastSuccessAt ? formatRelative(data.poll.lastSuccessAt) : "never"}. {modeText[data.watcherMode]}
          </div>
          {data.poll.lastError && (
            <div className="mt-3">
              <SectionMessage tone="error" title="The last check failed">
                {data.poll.lastError}
              </SectionMessage>
            </div>
          )}
          {poll.error && (
            <div className="mt-3">
              <SectionMessage tone="error">{poll.error.message}</SectionMessage>
            </div>
          )}
        </>
      )}

      {data.failedPublishes.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 font-semibold">Publishes waiting on a retry</h2>
          {data.failedPublishes.map((job) => (
            <div key={job.id} className="border-b border-line py-2">
              <span className="font-semibold">{job.findingId}</span>{" "}
              <span className="text-ink-2">
                {job.status === "failed" ? "gave up" : "retrying"} after {job.attempts} attempts: {job.lastError}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">Watcher decisions</h2>
        {data.decisions.length === 0 ? (
          <div className="text-ink-2">No @AuditIQ mentions yet.</div>
        ) : (
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="border-b-2 border-line text-left text-xs font-semibold text-ink-2">
                <th className="w-[110px] px-2 py-2">Issue</th>
                <th className="w-[100px] px-2 py-2">Outcome</th>
                <th className="px-2 py-2">Why</th>
                <th className="w-[110px] px-2 py-2">When</th>
              </tr>
            </thead>
            <tbody>
              {data.decisions.map((d) => (
                <tr key={d.id} className="border-b border-line align-top">
                  <td className="px-2 py-2">{d.issueKey}</td>
                  <td className="px-2 py-2">{d.status === "complete" ? "Replied" : d.status}</td>
                  <td className="px-2 py-2">
                    <div className="text-ink-2">{d.policy}</div>
                    {d.reply && <div className="mt-1">{d.reply}</div>}
                    {d.lastError && <div className="mt-1 text-danger">{d.lastError}</div>}
                  </td>
                  <td className="px-2 py-2 text-ink-2">{formatRelative(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">Recent changes</h2>
        {data.changes.length === 0 ? (
          <EmptyState title="Nothing yet">Changes to published issues show up here after the next check.</EmptyState>
        ) : (
          data.changes.map((change) => {
            const payload = change.payload as {
              status?: string;
              assignee?: string | null;
              authorName?: string;
              body?: string;
            };
            return (
              <div key={change.changeKey} className="flex gap-3 border-b border-line py-2">
                <span className="w-[90px] shrink-0 font-semibold">{change.issueKey}</span>
                <span className="min-w-0 grow">
                  {change.kind === "comment" ? (
                    <>
                      <span className="text-ink-2">{payload.authorName} commented: </span>
                      <span className="break-words">{payload.body}</span>
                    </>
                  ) : (
                    <span className="text-ink-2">
                      Status {payload.status}
                      {payload.assignee ? `, assigned to ${payload.assignee}` : ""}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-ink-3">{formatRelative(change.changedAt)}</span>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
