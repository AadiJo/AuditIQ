import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionMessage } from "../../../components/ui.tsx";
import { api, unwrap } from "../../../lib/api.ts";

export const Route = createFileRoute("/_app/settings/watcher")({ component: WatcherSettings });

const modes = [
  { id: "off", label: "Off", text: "AuditIQ ignores @AuditIQ mentions in Jira." },
  {
    id: "shadow",
    label: "Shadow",
    text: "AuditIQ drafts a reply to each @AuditIQ question and records it on the Jira activity page, but posts nothing.",
  },
  {
    id: "assist",
    label: "Assist",
    text: "AuditIQ posts short replies to @AuditIQ questions. A reply must rely only on the finding's verified quotes, clear a confidence bar, and fit a budget of three replies per issue per hour. It never changes status, priority, or assignee.",
  },
] as const;

function WatcherSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "watcher"], queryFn: () => unwrap(api.settings.watcher.$get()) });
  const save = useMutation({
    mutationFn: (mode: "off" | "shadow" | "assist") => unwrap(api.settings.watcher.$put({ json: { mode } })),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  if (!settings.data) return null;
  return (
    <>
      <h1 className="text-xl font-semibold">Jira watcher</h1>
      <p className="mt-2 text-ink-2">
        People can ask AuditIQ about a finding by mentioning @AuditIQ in a comment on its Jira issue. Comments are
        untrusted input, so every reply goes through fixed checks first. Switching to Off or Shadow stops replies
        immediately.
      </p>
      <div className="mt-5 rounded border border-line">
        {modes.map((mode, index) => (
          <label
            key={mode.id}
            className={`flex cursor-pointer gap-3 px-3.5 py-3 ${index ? "border-t border-line" : ""}`}
          >
            <input
              type="radio"
              name="mode"
              checked={settings.data.mode === mode.id}
              onChange={() => save.mutate(mode.id)}
              className="mt-0.5 size-4 accent-brand"
              disabled={save.isPending}
            />
            <span>
              <span className="block font-semibold">{mode.label}</span>
              <span className="block text-ink-2">{mode.text}</span>
            </span>
          </label>
        ))}
      </div>
      {save.error && (
        <div className="mt-3">
          <SectionMessage tone="error">{save.error.message}</SectionMessage>
        </div>
      )}
    </>
  );
}
