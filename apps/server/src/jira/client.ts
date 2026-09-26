import { z } from "zod";

// Jira Cloud REST v3 over fetch, authenticated with an Atlassian account email and API
// token. Responses are parsed through zod for the fields AuditIQ reads, so a changed Jira
// payload fails loudly here instead of deep inside the publisher.

export type JiraConnection = { baseUrl: string; email: string; token: string };

export class JiraError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const Myself = z.object({
  accountId: z.string(),
  displayName: z.string(),
  emailAddress: z.string().optional(),
  timeZone: z.string().optional(),
});

const Project = z.object({ id: z.string(), key: z.string(), name: z.string() });
const IssueType = z.object({ id: z.string(), name: z.string(), subtask: z.boolean().optional() });
const Priority = z.object({ id: z.string(), name: z.string() });

const AdfDocument = z.unknown();
const Comment = z.object({
  id: z.string(),
  author: z.object({ accountId: z.string().optional(), displayName: z.string().optional() }).optional(),
  body: AdfDocument,
  created: z.string(),
});

const IssueFields = z.object({
  summary: z.string().optional(),
  status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }).optional() }).optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.object({ displayName: z.string().optional() }).nullable().optional(),
  updated: z.string().optional(),
  comment: z.object({ comments: z.array(Comment), total: z.number().optional() }).optional(),
});
export const Issue = z.object({ id: z.string(), key: z.string(), fields: IssueFields });
export type Issue = z.infer<typeof Issue>;
export type JiraComment = z.infer<typeof Comment>;

export const issueFields = ["summary", "status", "labels", "assignee", "updated", "comment"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class JiraClient {
  private readonly connection: JiraConnection;

  constructor(connection: JiraConnection) {
    this.connection = connection;
  }

  /**
   * Sends one request, three attempts at most. A 429 means Jira did nothing, so every call
   * retries it after Retry-After. A 5xx can arrive after Jira already wrote, so only reads
   * (`safe`) retry those; a create or comment fails instead, and the outbox retries it
   * after checking for the issue first.
   */
  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    safe = method === "GET",
  ): Promise<T> {
    const auth = Buffer.from(`${this.connection.email}:${this.connection.token}`).toString("base64");
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${this.connection.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const text = await response.text();
        return schema.parse(text ? JSON.parse(text) : {});
      }
      const retryable = response.status === 429 || (safe && response.status >= 500);
      if (retryable && attempt < 3) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt + Math.random() * 250;
        await sleep(Math.min(delay, 30_000));
        continue;
      }
      throw new JiraError(response.status, await errorMessage(response));
    }
  }

  myself() {
    return this.request("GET", "/rest/api/3/myself", Myself);
  }

  async projects() {
    const page = await this.request(
      "GET",
      "/rest/api/3/project/search?maxResults=100&orderBy=name",
      z.object({ values: z.array(Project) }),
    );
    return page.values;
  }

  async issueTypes(projectKey: string) {
    const page = await this.request(
      "GET",
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=100`,
      z.object({ issueTypes: z.array(IssueType).optional(), values: z.array(IssueType).optional() }),
    );
    return (page.issueTypes ?? page.values ?? []).filter((type) => !type.subtask);
  }

  async priorities() {
    const page = await this.request(
      "GET",
      "/rest/api/3/priority/search?maxResults=100",
      z.object({ values: z.array(Priority) }),
    );
    return page.values;
  }

  /** Runs a JQL search through every page. `/rest/api/3/search` is retired; this is its replacement. */
  async search(jql: string, fields: string[], limit = Number.POSITIVE_INFINITY): Promise<Issue[]> {
    const issues: Issue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request(
        "POST",
        "/rest/api/3/search/jql",
        z.object({ issues: z.array(Issue), nextPageToken: z.string().optional(), isLast: z.boolean().optional() }),
        { jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
        true,
      );
      issues.push(...page.issues);
      nextPageToken =
        page.isLast === false || (page.isLast === undefined && page.nextPageToken) ? page.nextPageToken : undefined;
    } while (nextPageToken && issues.length < limit);
    return issues;
  }

  /** Returns null when the issue is gone or this account can't see it. */
  async issue(key: string): Promise<Issue | null> {
    try {
      return await this.request(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${issueFields.join(",")}`,
        Issue,
      );
    } catch (error) {
      if (error instanceof JiraError && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  }

  /** Every comment on an issue, oldest first, across pages. */
  async comments(key: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    for (let startAt = 0; ; ) {
      const page = await this.request(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
        z.object({ comments: z.array(Comment), total: z.number().optional() }),
      );
      comments.push(...page.comments);
      startAt += page.comments.length;
      if (!page.comments.length || startAt >= (page.total ?? startAt)) return comments;
    }
  }

  createIssue(fields: Record<string, unknown>) {
    return this.request("POST", "/rest/api/3/issue", z.object({ id: z.string(), key: z.string() }), { fields });
  }

  addComment(key: string, body: unknown) {
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, z.object({ id: z.string() }), {
      body,
    });
  }
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string>; message?: string };
    const parts = [
      ...(body.errorMessages ?? []),
      ...Object.entries(body.errors ?? {}).map(([field, message]) => `${field}: ${message}`),
    ];
    if (body.message) parts.push(body.message);
    if (parts.length) return `Jira returned ${response.status}: ${parts.join("; ")}`;
  } catch {
    // Not JSON; fall through.
  }
  return `Jira returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
}

/**
 * Finds where API calls should go. Classic API tokens work against the site URL. Scoped
 * tokens only work through api.atlassian.com, addressed by the site's cloud id.
 */
export async function resolveConnection(siteUrl: string, email: string, token: string) {
  const site = siteUrl.trim().replace(/\/+$/, "");
  // Real sites need https. Plain http is allowed for localhost, which covers the test
  // suite's fake Jira and local proxies.
  if (!/^https:\/\/[^/]+$/.test(site) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(site)) {
    throw new JiraError(400, "Enter the site as https://your-company.atlassian.net.");
  }
  const direct = new JiraClient({ baseUrl: site, email, token });
  try {
    return { baseUrl: site, me: await direct.myself() };
  } catch (error) {
    if (!(error instanceof JiraError) || error.status !== 401) throw error;
  }
  const tenant = await fetch(`${site}/_edge/tenant_info`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? (r.json() as Promise<{ cloudId?: string }>) : null))
    .catch(() => null);
  if (!tenant?.cloudId) throw new JiraError(401, "Jira rejected this email and API token.");
  const baseUrl = `https://api.atlassian.com/ex/jira/${tenant.cloudId}`;
  try {
    return { baseUrl, me: await new JiraClient({ baseUrl, email, token }).myself() };
  } catch (error) {
    if (error instanceof JiraError && error.status === 401)
      throw new JiraError(401, "Jira rejected this email and API token.");
    throw error;
  }
}
