import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import { Avatar, Button, SectionMessage, Select, TextField } from "../../../components/ui.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import { formatDate } from "../../../lib/format.ts";
import { meQuery } from "../../../lib/queries.ts";

export const Route = createFileRoute("/_app/settings/members")({ component: MembersSettings });

/** Accounts and invites. Invites are links to copy and send; no mail server needed. */
function MembersSettings() {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const members = useQuery({ queryKey: ["members"], queryFn: () => unwrap(api.members.$get()) });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "reviewer">("reviewer");
  const [copied, setCopied] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members"] });

  const invite = useMutation({
    mutationFn: () => unwrap(api.members.invites.$post({ json: { email, role } })),
    onSuccess: async () => {
      setEmail("");
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.members.invites[":id"].$delete({ param: { id } })),
    onSuccess: refresh,
  });
  const changeRole = useMutation({
    mutationFn: (input: { id: string; role: "admin" | "reviewer" }) =>
      unwrap(api.members[":id"].$patch({ param: { id: input.id }, json: { role: input.role } })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.members[":id"].$delete({ param: { id } })),
    onSuccess: refresh,
  });
  const error = invite.error ?? changeRole.error ?? remove.error ?? revoke.error;

  return (
    <>
      <h1 className="text-xl font-semibold">Members</h1>
      <p className="mt-2 text-ink-2">
        Admins manage settings and members. Reviewers upload contracts, run analyses, and publish findings.
      </p>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate();
        }}
      >
        <TextField
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@company.com"
          required
        />
        <Select value={role} onChange={(e) => setRole(e.target.value as "admin" | "reviewer")} className="w-36">
          <option value="reviewer">Reviewer</option>
          <option value="admin">Admin</option>
        </Select>
        <Button type="submit" variant="primary" disabled={invite.isPending}>
          Invite
        </Button>
      </form>
      {error && (
        <div className="mt-3">
          <SectionMessage tone="error">{error.message}</SectionMessage>
        </div>
      )}

      {members.data && members.data.invites.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 font-semibold">Open invites</h2>
          {members.data.invites.map((i) => (
            <div key={i.id} className="flex items-center gap-3 border-b border-line py-2">
              <span className="grow">
                {i.email}{" "}
                <span className="text-ink-3">
                  as {i.role}, expires {formatDate(i.expiresAt)}
                </span>
              </span>
              <Button
                variant="subtle"
                onClick={async () => {
                  await navigator.clipboard.writeText(i.link);
                  setCopied(i.id);
                }}
              >
                <Copy className="size-4" />
                {copied === i.id ? "Copied" : "Copy link"}
              </Button>
              <Button
                variant="subtle"
                icon
                aria-label={`Revoke invite for ${i.email}`}
                onClick={() => revoke.mutate(i.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">People</h2>
        {members.data?.members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 border-b border-line py-2">
            <Avatar name={m.name} />
            <span className="min-w-0 grow">
              <span className="block truncate font-semibold">{m.name}</span>
              <span className="block truncate text-xs text-ink-3">{m.email}</span>
            </span>
            <Select
              value={m.role}
              className="w-32"
              aria-label={`Role for ${m.name}`}
              onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as "admin" | "reviewer" })}
            >
              <option value="reviewer">Reviewer</option>
              <option value="admin">Admin</option>
            </Select>
            <Button
              variant="subtle"
              icon
              aria-label={`Remove ${m.name}`}
              disabled={m.id === me.data?.user.id}
              onClick={() => {
                if (window.confirm(`Remove ${m.name}? They lose access right away.`)) remove.mutate(m.id);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </section>
    </>
  );
}
