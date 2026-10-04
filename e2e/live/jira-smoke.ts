import fs from "node:fs/promises";
import path from "node:path";
import type { AppType } from "@auditiq/server/app";
import { type ClientResponse, hc } from "hono/client";

// Live check of the Jira integration against a real Jira Cloud site. It runs against an
// AuditIQ server whose Settings > Jira already points at a sandbox project, and plays two
// roles:
//   - AuditIQ publishes, syncs, and replies with the account configured in its settings.
//   - The reviewer, a second Atlassian account, plays the person working in Jira. It checks
//     what AuditIQ wrote through Jira's own API, moves an issue, and @mentions AuditIQ.
// Rerunning is safe: findings already in Jira get linked, not created again. Only status
// changes and the watcher's comments pile up. Results go to e2e/.artifacts/live/<time>/.
//
//   JIRA_REVIEWER_EMAIL=you@example.com JIRA_REVIEWER_TOKEN=... pnpm smoke:jira
//
// Optional settings:
//   AUDITIQ_URL       AuditIQ's API, default http://127.0.0.1:5180 (the dev server)
//   AUDITIQ_EMAIL     an AuditIQ admin, default the dev seed account
//   AUDITIQ_PASSWORD
//   SMOKE_CONTRACT    contract id to publish from, default the newest one with findings
//   SMOKE_FINDINGS    how many findings to publish, default 3
//   SMOKE_WATCHER=0   skip the watcher steps, which make a few small AI provider calls

const appUrl = (process.env.AUDITIQ_URL ?? "http://127.0.0.1:5180").replace(/\/+$/, "");
const reviewerEmail = process.env.JIRA_REVIEWER_EMAIL ?? "";
const reviewerToken = process.env.JIRA_REVIEWER_TOKEN ?? "";
const findingCount = Number(process.env.SMOKE_FINDINGS ?? 3);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = path.resolve(import.meta.dirname, "../.artifacts/live", stamp);

if (!reviewerEmail || !reviewerToken) {
  console.error("Set JIRA_REVIEWER_EMAIL and JIRA_REVIEWER_TOKEN for the Atlassian account that plays the reviewer.");
  process.exit(2);
}

/* ------------------------------ AuditIQ client ------------------------------ */

// A cookie jar, so the typed client stays signed in like a browser would.
const jar = new Map<string, string>();
const cookieFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  if (jar.size) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
  headers.set("origin", appUrl);
  const response = await fetch(input, { ...init, headers });
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return response;
};
const api = hc<AppType>(`${appUrl}/api`, { fetch: cookieFetch });

async function unwrap<T>(request: Promise<ClientResponse<T>>): Promise<T> {
  const response = await request;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(`AuditIQ returned ${response.status}: ${body?.error ?? "no details"}`);
  }
  return (await response.json()) as T;
}

/* ---------------------------- Reviewer Jira client --------------------------- */

let jiraBase = "";
const jiraAuth = `Basic ${Buffer.from(`${reviewerEmail}:${reviewerToken}`).toString("base64")}`;

async function jira<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${jiraBase}${route}`, {
    method,
    headers: { Authorization: jiraAuth, Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Jira returned ${response.status} for ${method} ${route}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Same rule as AuditIQ: classic tokens use the site URL, scoped tokens go through api.atlassian.com. */
async function resolveJiraBase(siteUrl: string) {
  const probe = await fetch(`${siteUrl}/rest/api/3/myself`, { headers: { Authorization: jiraAuth } });
  if (probe.ok) return siteUrl;
  const tenant = (await (await fetch(`${siteUrl}/_edge/tenant_info`)).json()) as { cloudId?: string };
  if (!tenant.cloudId) throw new Error(`Jira rejected the reviewer's email and token (${probe.status}).`);
  return `https://api.atlassian.com/ex/jira/${tenant.cloudId}`;
}

type JiraComment = { id: string; author: { accountId: string }; body: unknown; created: string };
type JiraIssue = {
  key: string;
  fields: {
    summary: string;
    labels: string[];
    priority: { name: string } | null;
    issuetype: { id: string; name: string };
    status: { name: string };
    description: unknown;
  };
};

function adfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; attrs?: { text?: string }; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention") return n.attrs?.text ?? "";
  return `${(n.content ?? []).map(adfText).join("")} `;
}

const normalize = (value: string) =>
  value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

async function comments(key: string) {
  return (await jira<{ comments: JiraComment[] }>("GET", `/rest/api/3/issue/${key}/comment?maxResults=100`)).comments;
}

/* --------------------------------- Reporting -------------------------------- */

type Check = { step: string; status: "pass" | "fail" | "skip"; detail: string; seconds: number };
const checks: Check[] = [];

class CheckFailed extends Error {}
/** Thrown after a failed step is recorded. It unwinds the run through any cleanup. */
class StopRun extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

/** Runs one step. A failure stops the run, since later steps build on earlier ones. */
async function step(name: string, run: () => Promise<string>) {
  const started = Date.now();
  process.stdout.write(`- ${name} ... `);
  try {
    const detail = await run();
    checks.push({ step: name, status: "pass", detail, seconds: (Date.now() - started) / 1000 });
    console.log(`ok\n    ${detail.replace(/\n/g, "\n    ")}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ step: name, status: "fail", detail, seconds: (Date.now() - started) / 1000 });
    console.log(`FAILED\n    ${detail}`);
    throw new StopRun();
  }
}

function skip(name: string, reason: string) {
  checks.push({ step: name, status: "skip", detail: reason, seconds: 0 });
  console.log(`- ${name} ... skipped\n    ${reason}`);
}

async function until<T>(what: string, seconds: number, probe: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new CheckFailed(`Gave up after ${seconds}s waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

const context: Record<string, string> = { auditiq: appUrl, started: new Date().toISOString() };

async function finish(): Promise<never> {
  await fs.mkdir(reportDir, { recursive: true });
  const failed = checks.some((c) => c.status === "fail");
  const md = [
    `# Jira live smoke test, ${context.started}`,
    "",
    ...Object.entries(context).map(([key, value]) => `- ${key}: ${value}`),
    "",
    `Result: ${failed ? "FAILED" : "passed"}`,
    "",
    ...checks.flatMap((c) => [
      `## ${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP"} ${c.step} (${c.seconds.toFixed(1)}s)`,
      "",
      c.detail,
      "",
    ]),
  ].join("\n");
  await fs.writeFile(path.join(reportDir, "report.md"), md);
  await fs.writeFile(path.join(reportDir, "report.json"), `${JSON.stringify({ context, checks }, null, 2)}\n`);
  console.log(
    `\n${failed ? "FAILED" : "Passed"}. Report: ${path.relative(process.cwd(), path.join(reportDir, "report.md"))}`,
  );
  process.exit(failed ? 1 : 0);
}

/* ---------------------------------- Steps ----------------------------------- */

async function main() {
  await step("Sign in to AuditIQ", async () => {
    const email = process.env.AUDITIQ_EMAIL ?? "aadi@example.com";
    const response = await cookieFetch(`${appUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: process.env.AUDITIQ_PASSWORD ?? "correct-horse-battery" }),
    });
    expect(response.ok, `Sign-in failed (${response.status}). Is AuditIQ running at ${appUrl}?`);
    const me = await unwrap(api.setup.me.$get());
    expect(me.user.role === "admin", `${email} isn't an admin, and the test changes watcher settings.`);
    return `Signed in as ${me.user.name}.`;
  });

  const settings = await unwrap(api.settings.jira.$get());
  const priorityFor = settings.priorities;
  context.site = settings.siteUrl;
  context.project = settings.projectKey;

  await step("AuditIQ is connected to a Jira project", async () => {
    expect(
      settings.displayName && settings.tokenReadable,
      "AuditIQ has no working Jira connection. Set it up in Settings > Jira.",
    );
    expect(
      settings.projectKey && settings.issueTypeId,
      "AuditIQ is connected but has no project or issue type. Finish Settings > Jira.",
    );
    return `${settings.displayName} (${settings.email}) on ${settings.siteUrl}, project ${settings.projectKey}, issue type ${settings.issueTypeName}.`;
  });

  let reviewer = { accountId: "", displayName: "" };
  await step("The reviewer can sign in to Jira", async () => {
    jiraBase = await resolveJiraBase(settings.siteUrl);
    reviewer = await jira("GET", "/rest/api/3/myself");
    context.reviewer = `${reviewer.displayName} (${reviewerEmail})`;
    return `${reviewer.displayName}, through ${jiraBase === settings.siteUrl ? "the site URL" : "api.atlassian.com (scoped token)"}.`;
  });
  const sameAccount = reviewer.accountId === settings.accountId;

  type Target = {
    id: string;
    title: string;
    severity: "high" | "medium" | "low";
    quotes: string[];
    wasLinked: boolean;
  };
  let contractId = process.env.SMOKE_CONTRACT ?? "";
  let targets: Target[] = [];

  await step(`Pick ${findingCount} verified findings to publish`, async () => {
    if (!contractId) {
      const { contracts } = await unwrap(api.contracts.$get());
      const withFindings = contracts.find((c) => c.findings.high + c.findings.medium + c.findings.low > 0);
      expect(withFindings, "AuditIQ has no contract with findings. Upload one and run extraction first.");
      contractId = withFindings.id;
    }
    const contract = await unwrap(api.contracts[":id"].$get({ param: { id: contractId } }));
    const eligible = contract.findings.filter((f) => f.eligible);
    // Prefer one per severity, so the priority mapping gets checked for each level.
    const picked = [
      ...(["high", "medium", "low"] as const).flatMap((s) => eligible.filter((f) => f.severity === s).slice(0, 1)),
      ...eligible,
    ].filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i);
    targets = picked.slice(0, findingCount).map((f) => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      quotes: f.citations.map((c) => c.quote),
      wasLinked: Boolean(f.jira),
    }));
    expect(targets.length, "The contract has no verified findings.");
    context.contract = `${contract.contractNumber ?? contract.filename} (${contractId})`;
    return targets.map((t) => `${t.severity} ${t.id}${t.wasLinked ? " (already in Jira)" : ""}: ${t.title}`).join("\n");
  });

  const keys = new Map<string, string>();
  const issueUrl = (key: string) => `${settings.siteUrl}/browse/${key}`;

  await step("Publish them to Jira", async () => {
    const result = await unwrap(
      api.contracts[":id"].publish.$post({ param: { id: contractId }, json: { findingIds: targets.map((t) => t.id) } }),
    );
    expect(!result.failed.length, `Publishing failed: ${result.failed.map((f) => f.error).join("; ")}`);
    for (const target of targets) {
      const outcome = result.published.find((p) => p.findingId === target.id);
      expect(outcome, `${target.id} wasn't published.`);
      const expected = target.wasLinked ? ["linked", "commented"] : ["created"];
      expect(
        expected.includes(outcome.operation),
        `${target.id} was ${outcome.operation}, expected ${expected.join(" or ")}.`,
      );
      keys.set(target.id, outcome.issueKey);
    }
    return result.published.map((p) => `${p.issueKey} ${p.operation}: ${issueUrl(p.issueKey)}`).join("\n");
  });

  /** Issues carrying a finding's label. Jira's search index lags writes by a few seconds. */
  async function issuesFor(findingId: string): Promise<JiraIssue[]> {
    const label = `auditiq-fnd-${findingId.replace(/^FND-/, "").toLowerCase()}`;
    const page = await jira<{ issues: JiraIssue[] }>("POST", "/rest/api/3/search/jql", {
      jql: `project = "${settings.projectKey}" AND labels = "${label}"`,
      fields: ["summary"],
      maxResults: 10,
    });
    return page.issues;
  }

  await step("Jira shows one issue per finding, with the right content", async () => {
    const lines: string[] = [];
    for (const target of targets) {
      const key = keys.get(target.id) ?? "";
      const issue = await jira<JiraIssue>(
        "GET",
        `/rest/api/3/issue/${key}?fields=summary,labels,priority,issuetype,status,description`,
      );
      expect(issue.fields.summary === target.title.slice(0, 250), `${key} has summary "${issue.fields.summary}".`);
      expect(issue.fields.labels.includes("auditiq"), `${key} is missing the auditiq label.`);
      expect(issue.fields.issuetype.id === settings.issueTypeId, `${key} is a ${issue.fields.issuetype.name}.`);
      const wantPriority = priorityFor[target.severity]?.name;
      if (wantPriority) {
        expect(
          issue.fields.priority?.name === wantPriority,
          `${key} has priority ${issue.fields.priority?.name}, expected ${wantPriority}.`,
        );
      }
      const description = normalize(adfText(issue.fields.description));
      for (const quote of target.quotes) {
        expect(
          description.includes(normalize(quote)),
          `${key}'s description is missing the quote "${quote.slice(0, 60)}".`,
        );
      }
      const found = await until(`${key} to appear in Jira search`, 60, async () => {
        const issues = await issuesFor(target.id);
        return issues.length ? issues : null;
      });
      expect(
        found.length === 1,
        `Jira has ${found.length} issues for ${target.id}: ${found.map((i) => i.key).join(", ")}.`,
      );
      lines.push(
        `${key}: summary, labels, type, priority ${issue.fields.priority?.name ?? "unset"}, ${target.quotes.length} quotes; one issue for its label`,
      );
    }
    return lines.join("\n");
  });

  await step("Publishing again creates nothing new", async () => {
    const result = await unwrap(
      api.contracts[":id"].publish.$post({ param: { id: contractId }, json: { findingIds: targets.map((t) => t.id) } }),
    );
    expect(
      result.published.every((p) => p.operation === "linked"),
      `Got ${result.published.map((p) => p.operation).join(", ")}.`,
    );
    for (const target of targets) {
      const issues = await issuesFor(target.id);
      expect(issues.length === 1, `Jira now has ${issues.length} issues for ${target.id}.`);
    }
    return `${result.published.length} findings linked to their existing issues, and Jira still has one issue each.`;
  });

  const first = targets[0];
  const firstKey = keys.get(first?.id ?? "") ?? "";

  await step("A status and assignee change in Jira shows up in AuditIQ", async () => {
    const issue = await jira<JiraIssue>("GET", `/rest/api/3/issue/${firstKey}?fields=status`);
    const { transitions } = await jira<{
      transitions: Array<{ id: string; to: { name: string; statusCategory: { key: string } } }>;
    }>("GET", `/rest/api/3/issue/${firstKey}/transitions`);
    const target =
      transitions.find((t) => t.to.statusCategory.key === "indeterminate" && t.to.name !== issue.fields.status.name) ??
      transitions.find((t) => t.to.name !== issue.fields.status.name);
    expect(target, `${firstKey} has no transition out of ${issue.fields.status.name}.`);
    await jira("POST", `/rest/api/3/issue/${firstKey}/transitions`, { transition: { id: target.id } });
    let assigned = true;
    try {
      await jira("PUT", `/rest/api/3/issue/${firstKey}/assignee`, { accountId: reviewer.accountId });
    } catch {
      assigned = false;
    }
    const seen = await until("AuditIQ to see the change", 90, async () => {
      await unwrap(api.jira.poll.$post());
      const { finding } = await unwrap(api.findings[":id"].$get({ param: { id: first?.id ?? "" } }));
      const statusOk = finding.jira?.status === target.to.name;
      const assigneeOk = !assigned || finding.jira?.assignee === reviewer.displayName;
      return statusOk && assigneeOk ? finding.jira : null;
    });
    return `${firstKey} moved from ${issue.fields.status.name} to ${seen?.status}${assigned ? `, assigned to ${seen?.assignee}` : " (the reviewer can't assign issues here, so only status was checked)"}.`;
  });

  /** Posts a reviewer comment that @mentions AuditIQ's account the way Jira's editor does. */
  async function askAuditIQ(question: string) {
    await jira("POST", `/rest/api/3/issue/${firstKey}/comment`, {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: settings.accountId, text: `@${settings.displayName}` } },
              { type: "text", text: ` ${question} (smoke test ${stamp})` },
            ],
          },
        ],
      },
    });
  }

  // Jira dates carry the viewer's timezone offset (e.g. -0500), so compare instants, not strings.
  const auditiqReplies = async (since: string) =>
    (await comments(firstKey)).filter(
      (c) =>
        c.author.accountId === settings.accountId &&
        Date.parse(c.created) >= Date.parse(since) &&
        JSON.stringify(c.body).includes("AuditIQ reply"),
    );

  if (process.env.SMOKE_WATCHER === "0") {
    skip("The watcher answers @mentions", "SMOKE_WATCHER=0.");
  } else if (sameAccount) {
    skip(
      "The watcher answers @mentions",
      "The reviewer and AuditIQ use the same Atlassian account. AuditIQ ignores its own comments, so a second account has to ask the question.",
    );
  } else {
    const { mode: originalMode } = await unwrap(api.settings.watcher.$get());
    const setMode = (mode: "off" | "shadow" | "assist") => unwrap(api.settings.watcher.$put({ json: { mode } }));
    try {
      await step("In shadow mode, the watcher drafts a reply and posts nothing", async () => {
        await setMode("shadow");
        const since = new Date(Date.now() - 5000).toISOString();
        await askAuditIQ("which clause raises this, and what do I need to decide?");
        const decision = await until("a watcher decision", 240, async () => {
          await unwrap(api.jira.poll.$post());
          const activity = await unwrap(api.jira.activity.$get());
          return activity.decisions.find((d) => d.issueKey === firstKey && d.createdAt >= since);
        });
        expect(decision.status === "shadow", `The decision was ${decision.status}: ${decision.policy}`);
        expect(!(await auditiqReplies(since)).length, "AuditIQ posted a reply in shadow mode.");
        return `Drafted, not posted: "${(decision.reply ?? "").slice(0, 200)}"`;
      });

      await step("In assist mode, the watcher posts exactly one reply", async () => {
        await setMode("assist");
        const since = new Date(Date.now() - 5000).toISOString();
        await askAuditIQ("does the quoted clause settle this on its own?");
        const replies = await until("AuditIQ's reply in Jira", 240, async () => {
          await unwrap(api.jira.poll.$post());
          const found = await auditiqReplies(since);
          if (found.length) return found;
          const activity = await unwrap(api.jira.activity.$get());
          const decision = activity.decisions.find((d) => d.issueKey === firstKey && d.createdAt >= since);
          if (decision?.status === "rejected")
            throw new CheckFailed(`The watcher declined to reply: ${decision.policy}`);
          return null;
        });
        // Polling again must not post a second copy.
        await unwrap(api.jira.poll.$post());
        await unwrap(api.jira.poll.$post());
        const after = await auditiqReplies(since);
        expect(after.length === 1, `AuditIQ posted ${after.length} replies to one question.`);
        return `Reply ${replies[0]?.id} on ${issueUrl(firstKey)}: "${normalize(adfText(replies[0]?.body)).slice(0, 200)}"`;
      });
    } finally {
      await setMode(originalMode);
    }
  }
}

console.log(`Jira live smoke test against ${appUrl}\n`);
try {
  await main();
} catch (error) {
  if (!(error instanceof StopRun)) {
    checks.push({ step: "Unexpected error", status: "fail", detail: String(error), seconds: 0 });
    console.log(`Unexpected error: ${String(error)}`);
  }
}
await finish();
