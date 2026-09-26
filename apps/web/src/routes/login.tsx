import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Logo } from "../components/icons.tsx";
import { Button, Field, SectionMessage, TextField } from "../components/ui.tsx";
import { authClient } from "../lib/auth.ts";
import { setupStateQuery } from "../lib/queries.ts";

export const Route = createFileRoute("/login")({ component: LoginPage });

/** Sign in, or create the owner account on a fresh install. */
function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setup = useQuery(setupStateQuery);
  const owner = setup.data?.needsOwner ?? false;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = owner
      ? await authClient.signUp.email({ name, email, password })
      : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "That didn't work. Check your email and password.");
      return;
    }
    await queryClient.invalidateQueries();
    navigate({ to: owner ? "/settings/jira" : "/contracts", search: owner ? { setup: true } : undefined });
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
        <h1 className="mt-6 text-xl font-semibold">{owner ? "Create the owner account" : "Sign in"}</h1>
        {owner && (
          <p className="mt-1 text-ink-2">
            This is a new AuditIQ workspace. The first account can invite everyone else.
          </p>
        )}
        {error && (
          <div className="mt-4">
            <SectionMessage tone="error">{error}</SectionMessage>
          </div>
        )}
        {owner && (
          <Field label="Name">
            <TextField value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </Field>
        )}
        <Field label="Email">
          <TextField
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </Field>
        <Field label="Password" hint={owner ? "At least 10 characters." : undefined}>
          <TextField
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={owner ? "new-password" : "current-password"}
            minLength={owner ? 10 : undefined}
            required
          />
        </Field>
        <Button type="submit" variant="primary" className="mt-6 w-full" disabled={busy}>
          {owner ? "Create account" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
