import http from "node:http";
import { HOST } from "./env.ts";

// An in-memory Jira Cloud that implements the REST v3 endpoints AuditIQ calls, plus
// /__control routes the tests use to add comments, change statuses, inject failures, and
// read back everything AuditIQ wrote. Start it with `node e2e/fake-jira.ts <port>`.

type Comment = { id: string; author: { accountId: string; displayName: string }; body: unknown; created: string };
type Issue = {
  id: string;
  key: string;
  fields: {
    summary: string;
    labels: string[];
    priority: { id: string } | null;
    issuetype: { id: string };
    description: unknown;
    status: { name: string; statusCategory: { key: string } };
    assignee: { displayName: string } | null;
    updated: string;
    comment: { comments: Comment[]; total: number };
  };
};
type Failure = { method: string; pathPrefix: string; status: number; times: number; retryAfter?: number };

export const SERVICE_ACCOUNT = {
  accountId: "svc-auditiq",
  displayName: "AuditIQ Service",
  emailAddress: "auditiq-bot@example.com",
};
export const TOKEN = "fake-jira-token";

const state = {
  issues: new Map<string, Issue>(),
  failures: [] as Failure[],
  requests: [] as Array<{ method: string; path: string; status: number }>,
  nextId: 10000,
};

function reset() {
  state.issues.clear();
  state.failures = [];
  state.requests = [];
  state.nextId = 10000;
}

const now = () => new Date().toISOString();

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Enough JQL for AuditIQ: `project = "X"` and any number of `labels = "y"` clauses. */
function matches(issue: Issue, jql: string): boolean {
  const project = jql.match(/project\s*=\s*"?([A-Z0-9]+)"?/)?.[1];
  if (project && !issue.key.startsWith(`${project}-`)) return false;
  for (const [, label] of jql.matchAll(/labels\s*=\s*"([^"]+)"/g)) {
    if (!issue.fields.labels.includes(label ?? "")) return false;
  }
  return true;
}

function touch(issue: Issue) {
  issue.fields.updated = now();
}

async function handleControl(req: http.IncomingMessage, res: http.ServerResponse, path: string) {
  if (path === "/__control/state")
    return json(res, 200, { issues: [...state.issues.values()], requests: state.requests });
  if (path === "/__control/reset") {
    reset();
    return json(res, 200, { ok: true });
  }
  const body = await readBody(req);
  if (path === "/__control/fail") {
    state.failures.push(body as unknown as Failure);
    return json(res, 200, { ok: true });
  }
  const issue = state.issues.get(String(body.key));
  if (!issue) return json(res, 404, { error: "no such issue" });
  if (path === "/__control/comment") {
    const author = { accountId: String(body.accountId ?? "user-dana"), displayName: String(body.author ?? "Dana Kim") };
    const text = String(body.text);
    issue.fields.comment.comments.push({
      id: String(state.nextId++),
      author,
      created: now(),
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    });
    issue.fields.comment.total = issue.fields.comment.comments.length;
    touch(issue);
    return json(res, 200, { ok: true });
  }
  if (path === "/__control/transition") {
    issue.fields.status = {
      name: String(body.status),
      statusCategory: { key: String(body.category ?? "indeterminate") },
    };
    if (body.assignee !== undefined)
      issue.fields.assignee = body.assignee ? { displayName: String(body.assignee) } : null;
    touch(issue);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "unknown control route" });
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, path: string, method: string) {
  const expected = `Basic ${Buffer.from(`${SERVICE_ACCOUNT.emailAddress}:${TOKEN}`).toString("base64")}`;
  if (req.headers.authorization !== expected)
    return json(res, 401, { errorMessages: ["Client must be authenticated to access this resource."] });

  const failure = state.failures.find((f) => f.times > 0 && f.method === method && path.startsWith(f.pathPrefix));
  if (failure) {
    failure.times--;
    return json(
      res,
      failure.status,
      { errorMessages: [`Injected ${failure.status}`] },
      failure.retryAfter ? { "Retry-After": String(failure.retryAfter) } : {},
    );
  }

  if (method === "GET" && path === "/rest/api/3/myself") return json(res, 200, { ...SERVICE_ACCOUNT, timeZone: "UTC" });
  if (method === "GET" && path === "/rest/api/3/project/search") {
    return json(res, 200, { values: [{ id: "10000", key: "AISBX", name: "AuditIQ Sandbox" }] });
  }
  if (method === "GET" && path === "/rest/api/3/issue/createmeta/AISBX/issuetypes") {
    return json(res, 200, {
      issueTypes: [
        { id: "10001", name: "Task", subtask: false },
        { id: "10002", name: "Sub-task", subtask: true },
      ],
    });
  }
  if (method === "GET" && path === "/rest/api/3/priority/search") {
    return json(res, 200, {
      values: [
        { id: "2", name: "High" },
        { id: "3", name: "Medium" },
        { id: "4", name: "Low" },
      ],
    });
  }
  if (method === "POST" && path === "/rest/api/3/search/jql") {
    const body = await readBody(req);
    const found = [...state.issues.values()].filter((issue) => matches(issue, String(body.jql)));
    return json(res, 200, { issues: found, isLast: true });
  }
  if (method === "POST" && path === "/rest/api/3/issue") {
    const { fields } = (await readBody(req)) as { fields: Record<string, unknown> };
    const n = state.issues.size + 1;
    const issue: Issue = {
      id: String(state.nextId++),
      key: `AISBX-${n}`,
      fields: {
        summary: String(fields.summary),
        labels: (fields.labels as string[]) ?? [],
        priority: (fields.priority as { id: string }) ?? null,
        issuetype: fields.issuetype as { id: string },
        description: fields.description,
        status: { name: "To Do", statusCategory: { key: "new" } },
        assignee: null,
        updated: now(),
        comment: { comments: [], total: 0 },
      },
    };
    state.issues.set(issue.key, issue);
    return json(res, 201, { id: issue.id, key: issue.key });
  }
  const issueMatch = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/comment)?$/);
  if (issueMatch?.[1]) {
    const issue = state.issues.get(issueMatch[1]);
    if (!issue)
      return json(res, 404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
    if (!issueMatch[2] && method === "GET") return json(res, 200, issue);
    if (issueMatch[2] && method === "GET") return json(res, 200, { comments: issue.fields.comment.comments });
    if (issueMatch[2] && method === "POST") {
      const { body } = (await readBody(req)) as { body: unknown };
      const comment = {
        id: String(state.nextId++),
        author: { accountId: SERVICE_ACCOUNT.accountId, displayName: SERVICE_ACCOUNT.displayName },
        body,
        created: now(),
      };
      issue.fields.comment.comments.push(comment);
      issue.fields.comment.total = issue.fields.comment.comments.length;
      touch(issue);
      return json(res, 201, { id: comment.id });
    }
  }
  return json(res, 404, { errorMessages: [`Fake Jira has no route for ${method} ${path}`] });
}

export function startFakeJira(port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const originalEnd = res.end.bind(res);
    res.end = ((...args: Parameters<typeof res.end>) => {
      if (!url.pathname.startsWith("/__control"))
        state.requests.push({ method, path: url.pathname, status: res.statusCode });
      return originalEnd(...args);
    }) as typeof res.end;
    try {
      if (url.pathname.startsWith("/__control")) await handleControl(req, res, url.pathname);
      else await handleApi(req, res, url.pathname, method);
    } catch (error) {
      json(res, 500, { errorMessages: [String(error)] });
    }
  });
  return new Promise((resolve) => server.listen(port, HOST, () => resolve(server)));
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 5199);
  await startFakeJira(port);
  console.log(`Fake Jira listening on port ${port}`);
}
