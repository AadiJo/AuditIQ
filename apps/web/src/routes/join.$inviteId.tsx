import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Logo } from "../components/icons.tsx";
import { Button, Field, SectionMessage, TextField } from "../components/ui.tsx";
import { api, unwrap } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";

export const Route = createFileRoute("/join/$inviteId")({ component: JoinPage });

/** Where invite links land. The account is created for the invited email only. */
function JoinPage() {
  const { inviteId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invite = useQuery({
    queryKey: ["invite", inviteId],
    queryFn: () => unwrap(api.setup.invite[":id"].$get({ param: { id: inviteId } })),
  });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const email = invite.data?.invite?.email ?? "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await authClient.signUp.email({ name, email, password });
    setBusy(false);
    if (result.error) return setError(result.error.message ?? "That didn't work.");
    await queryClient.invalidateQueries();
    navigate({ to: "/contracts" });
  }

  return (
    <div className="grid min-h-full place-items-center bg-sunken px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-md bg-white px-8 py-8 shadow-[0_1px_1px_rgba(30,31,33,0.25),0_0_1px_rgba(30,31,33,0.31)]"
      >
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Logo />
          AuditIQ
        </div>
        {invite.isPending ? null : !invite.data?.invite ? (
          <div className="mt-6">
            <SectionMessage tone="warning" title="This invite isn't valid">
              It may have expired or already been used. Ask an admin for a new link.
            </SectionMessage>
          </div>
        ) : (
          <>
            <h1 className="mt-6 text-xl font-semibold">Join AuditIQ</h1>
            <p className="mt-1 text-ink-2">
              You were invited as {invite.data.invite.role === "admin" ? "an admin" : "a reviewer"}.
            </p>
            {error && (
              <div className="mt-4">
                <SectionMessage tone="error">{error}</SectionMessage>
              </div>
            )}
            <Field label="Email">
              <TextField value={email} disabled />
            </Field>
            <Field label="Name">
              <TextField value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </Field>
            <Field label="Password" hint="At least 10 characters.">
              <TextField
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={10}
                required
              />
            </Field>
            <Button type="submit" variant="primary" className="mt-6 w-full" disabled={busy}>
              Create account
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
