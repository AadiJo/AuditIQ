import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { PriorityIcon } from "../../../components/icons.tsx";
import { Button, Field, SectionMessage, Select, TextField } from "../../../components/ui.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import { hostOf } from "../../../lib/format.ts";

export const Route = createFileRoute("/_app/settings/jira")({
  validateSearch: (search) => z.object({ setup: z.boolean().optional() }).parse(search),
  component: JiraSettings,
});

type Priority = { id: string; name: string } | null;

/** Connect a Jira Cloud site with an API token, then choose where findings go. */
function JiraSettings() {
  const { setup } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "jira"], queryFn: () => unwrap(api.settings.jira.$get()) });
  const connected = Boolean(settings.data?.displayName && settings.data.tokenReadable);

  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  useEffect(() => {
    if (!settings.data) return;
    setSiteUrl(settings.data.siteUrl);
    setEmail(settings.data.email);
  }, [settings.data]);

  const connect = useMutation({
    mutationFn: () =>
      unwrap(api.settings.jira.connection.$put({ json: { siteUrl, email, ...(token ? { apiToken: token } : {}) } })),
    onSuccess: async () => {
      setToken("");
      await queryClient.invalidateQueries({ queryKey: ["settings", "jira"] });
    },
  });

  const projects = useQuery({
    queryKey: ["jira", "projects"],
    queryFn: () => unwrap(api.settings.jira.projects.$get()),
    enabled: connected,
  });
  const priorities = useQuery({
    queryKey: ["jira", "priorities"],
    queryFn: () => unwrap(api.settings.jira.priorities.$get()),
    enabled: connected,
  });
  const [projectKey, setProjectKey] = useState("");
  const [issueTypeId, setIssueTypeId] = useState("");
  const [mapping, setMapping] = useState<{ high: Priority; medium: Priority; low: Priority }>({
    high: null,
    medium: null,
    low: null,
  });
  useEffect(() => {
    if (!settings.data) return;
    setProjectKey(settings.data.projectKey);
    setIssueTypeId(settings.data.issueTypeId);
    setMapping(settings.data.priorities);
  }, [settings.data]);
  const issueTypes = useQuery({
    queryKey: ["jira", "issue-types", projectKey],
    queryFn: () => unwrap(api.settings.jira["issue-types"].$get({ query: { project: projectKey } })),
    enabled: connected && Boolean(projectKey),
  });

  // Suggest Jira's usual High, Medium, and Low priorities the first time.
  useEffect(() => {
    const list = priorities.data?.priorities;
    if (!list || mapping.high || mapping.medium || mapping.low) return;
    const find = (name: string) => list.find((p) => p.name.toLowerCase() === name) ?? null;
    setMapping({ high: find("high"), medium: find("medium"), low: find("low") });
  }, [priorities.data, mapping]);

  const saveProject = useMutation({
    mutationFn: () => {
      const project = projects.data?.projects.find((p) => p.key === projectKey);
      const issueType = issueTypes.data?.issueTypes.find((t) => t.id === issueTypeId);
      return unwrap(
        api.settings.jira.project.$put({
          json: {
            projectKey,
            projectName: project?.name ?? "",
            issueTypeId,
            issueTypeName: issueType?.name ?? "",
            priorities: mapping,
          },
        }),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      if (setup) navigate({ to: "/settings/ai", search: { setup: true } });
    },
  });

  function submitConnection(event: FormEvent) {
    event.preventDefault();
    connect.mutate();
  }

  return (
    <>
      {setup && (
        <div className="mb-5">
          <SectionMessage tone="info" title="Set up AuditIQ, step 1 of 2">
            Connect the Jira project where findings should go. You can skip this and do it later.{" "}
            <button
              type="button"
              className="text-brand"
              onClick={() => navigate({ to: "/settings/ai", search: { setup: true } })}
            >
              Skip for now
            </button>
          </SectionMessage>
        </div>
      )}
      <h1 className="text-xl font-semibold">Jira</h1>
      {connected && (
        <div className="mt-3">
          <SectionMessage tone="success">
            Connected to {hostOf(settings.data?.siteUrl)} as {settings.data?.displayName}.
          </SectionMessage>
        </div>
      )}
      {settings.data?.tokenReadable === false && (
        <div className="mt-3">
          <SectionMessage tone="warning" title="Re-enter the API token">
            The stored token can't be read, which happens when AUDITIQ_SECRET changes.
          </SectionMessage>
        </div>
      )}

      <form onSubmit={submitConnection}>
        <Field label="Site URL">
          <TextField
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://your-company.atlassian.net"
            required
          />
        </Field>
        <Field
          label="Email"
          hint="The Atlassian account AuditIQ acts as. A dedicated service account keeps its work easy to spot in Jira."
        >
          <TextField type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field
          label="API token"
          hint={
            <>
              Create one at{" "}
              <a
                className="text-brand"
                href="https://id.atlassian.com/manage-profile/security/api-tokens"
                target="_blank"
                rel="noreferrer"
              >
                id.atlassian.com
              </a>
              .{settings.data?.tokenHint ? ` Leave blank to keep the token ending in ${settings.data.tokenHint}.` : ""}
            </>
          }
        >
          <TextField
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            required={!settings.data?.tokenHint}
          />
        </Field>
        {connect.error && (
          <div className="mt-3">
            <SectionMessage tone="error">{connect.error.message}</SectionMessage>
          </div>
        )}
        <div className="mt-4">
          <Button type="submit" disabled={connect.isPending}>
            {connect.isPending ? "Checking" : connected ? "Save and test" : "Connect"}
          </Button>
        </div>
      </form>

      {connected && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveProject.mutate();
          }}
          className="mt-8 border-t border-line pt-6"
        >
          <h2 className="text-base font-semibold">Where findings go</h2>
          <Field label="Project">
            <Select value={projectKey} onChange={(e) => setProjectKey(e.target.value)} required>
              <option value="">Choose a project</option>
              {projects.data?.projects.map((p) => (
                <option key={p.id} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Issue type">
            <Select
              value={issueTypeId}
              onChange={(e) => setIssueTypeId(e.target.value)}
              required
              disabled={!projectKey}
            >
              <option value="">Choose an issue type</option>
              {issueTypes.data?.issueTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Jira priority for each finding level"
            hint="Leave a level blank to create issues without a priority."
          >
            <div className="flex flex-col gap-2">
              {(["high", "medium", "low"] as const).map((level) => (
                <div key={level} className="flex items-center gap-3">
                  <span className="flex w-24 items-center gap-1.5 capitalize">
                    <PriorityIcon severity={level} />
                    {level}
                  </span>
                  <Select
                    value={mapping[level]?.id ?? ""}
                    onChange={(e) => {
                      const found = priorities.data?.priorities.find((p) => p.id === e.target.value) ?? null;
                      setMapping((current) => ({ ...current, [level]: found }));
                    }}
                  >
                    <option value="">No priority</option>
                    {priorities.data?.priorities.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          </Field>
          {(saveProject.error || projects.error) && (
            <div className="mt-3">
              <SectionMessage tone="error">{(saveProject.error ?? projects.error)?.message}</SectionMessage>
            </div>
          )}
          <div className="mt-5 flex gap-2">
            <Button type="submit" variant="primary" disabled={saveProject.isPending || !projectKey || !issueTypeId}>
              {setup ? "Save and continue" : "Save"}
            </Button>
          </div>
          {saveProject.isSuccess && !setup && <div className="mt-2 text-ok">Saved.</div>}
        </form>
      )}
    </>
  );
}
