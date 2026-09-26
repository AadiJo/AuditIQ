import type { Effort, RuntimeId } from "@auditiq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button, Checkbox, Field, SectionMessage, Select, TextField } from "../../../components/ui.tsx";
import { api, unwrap } from "../../../lib/api.ts";

export const Route = createFileRoute("/_app/settings/ai")({
  validateSearch: (search) => z.object({ setup: z.boolean().optional() }).parse(search),
  component: AiSettings,
});

const runtimeNames: Record<RuntimeId, { name: string; vendor: string; keyLabel: string; models: string[] }> = {
  claude: {
    name: "Claude",
    vendor: "Anthropic",
    keyLabel: "Anthropic API key",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"],
  },
  codex: { name: "Codex", vendor: "OpenAI", keyLabel: "OpenAI API key", models: ["gpt-5.5"] },
};

type Config = { model: string; effort: Effort };

function KeyForm({ id, hint }: { id: RuntimeId; hint: string | null }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (apiKey: string | null) =>
      unwrap(api.settings.runtime[":id"].key.$put({ param: { id }, json: { apiKey } })),
    onSuccess: async () => {
      setKey("");
      await queryClient.invalidateQueries({ queryKey: ["settings", "runtime"] });
    },
  });
  return (
    <Field label={runtimeNames[id].keyLabel} hint="Used only when this server has no CLI login for this provider.">
      <div className="flex gap-2">
        <TextField
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={hint ? `Stored, ends in ${hint}` : "Not set"}
          autoComplete="off"
        />
        <Button onClick={() => save.mutate(key)} disabled={key.length < 8 || save.isPending}>
          Save
        </Button>
        {hint && (
          <Button variant="subtle" onClick={() => save.mutate(null)} disabled={save.isPending}>
            Remove
          </Button>
        )}
      </div>
    </Field>
  );
}

/** Which model provider runs analyses. The only place Claude and Codex appear by name. */
function AiSettings() {
  const { setup } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "runtime"], queryFn: () => unwrap(api.settings.runtime.$get()) });
  const [chosen, setChosen] = useState<RuntimeId>("claude");
  const [allowOverride, setAllowOverride] = useState(true);
  const [configs, setConfigs] = useState<Record<RuntimeId, Config>>({
    claude: { model: "", effort: "medium" },
    codex: { model: "", effort: "low" },
  });
  useEffect(() => {
    if (!settings.data) return;
    setChosen(settings.data.default);
    setAllowOverride(settings.data.allowOverride);
    setConfigs({ claude: settings.data.claude, codex: settings.data.codex });
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.settings.runtime.$put({
          json: { default: chosen, allowOverride, claude: configs.claude, codex: configs.codex },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      if (setup) navigate({ to: "/contracts" });
    },
  });

  if (!settings.data) return null;
  const status = (id: RuntimeId) => settings.data.statuses.find((s) => s.id === id);
  const config = configs[chosen];

  return (
    <>
      {setup && (
        <div className="mb-5">
          <SectionMessage tone="info" title="Set up AuditIQ, step 2 of 2">
            Pick the AI provider that runs contract analyses.
          </SectionMessage>
        </div>
      )}
      <h1 className="text-xl font-semibold">AI provider</h1>
      <Field label="Run analyses with">
        <div className="rounded border border-line">
          {(["claude", "codex"] as const).map((id, index) => {
            const s = status(id);
            return (
              <label
                key={id}
                className={`flex cursor-pointer items-center gap-3 px-3.5 py-3 ${index ? "border-t border-line" : ""}`}
              >
                <input
                  type="radio"
                  name="runtime"
                  checked={chosen === id}
                  onChange={() => setChosen(id)}
                  className="size-4 accent-brand"
                />
                <span className="grow">
                  <span className="block font-semibold">{runtimeNames[id].name}</span>
                  <span className="block text-xs text-ink-2">{runtimeNames[id].vendor}</span>
                </span>
                <span
                  className={`flex max-w-[60%] items-center gap-1.5 text-xs ${s?.ready ? "text-ok" : "text-danger"}`}
                >
                  {s?.ready ? <CircleCheck className="size-4 shrink-0" /> : <CircleAlert className="size-4 shrink-0" />}
                  <span>
                    {s?.ready
                      ? `${s.auth === "cli" ? "CLI login" : "API key"}${s.account ? `, ${s.account}` : ""}`
                      : s?.detail}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </Field>
      <Field label="Model">
        <Select
          value={config.model}
          onChange={(e) => setConfigs((c) => ({ ...c, [chosen]: { ...c[chosen], model: e.target.value } }))}
        >
          {[...new Set([config.model, ...runtimeNames[chosen].models])].filter(Boolean).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Effort" hint="Higher effort thinks longer and costs more. Medium suits most contracts.">
        <Select
          value={config.effort}
          onChange={(e) => setConfigs((c) => ({ ...c, [chosen]: { ...c[chosen], effort: e.target.value as Effort } }))}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>
      </Field>
      <KeyForm key={chosen} id={chosen} hint={settings.data[chosen].keyHint} />
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox component renders the input. */}
      <label className="mt-5 flex items-center gap-2.5">
        <Checkbox label="Allow reviewers to switch provider" checked={allowOverride} onChange={setAllowOverride} />
        Reviewers can switch provider for a single run
      </label>
      {save.error && (
        <div className="mt-3">
          <SectionMessage tone="error">{save.error.message}</SectionMessage>
        </div>
      )}
      <div className="mt-6">
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {setup ? "Finish setup" : "Save"}
        </Button>
        {save.isSuccess && !setup && <span className="ml-3 text-ok">Saved.</span>}
      </div>
    </>
  );
}
