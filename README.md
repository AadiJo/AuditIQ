# AuditIQ

AuditIQ reads customer contracts and flags what matters for ASC 606 revenue recognition. It extracts the revenue-relevant terms, drafts the accounting analysis, and turns each open question into a Jira issue your team already knows how to work.

Every finding quotes the contract. AuditIQ checks each quote against the clause it claims to come from, and a finding whose quotes don't match stays out of Jira with the reason shown. People make the calls. AuditIQ never resolves, reassigns, or re-prioritizes an issue.

It runs on your own server. Analyses go through Claude or Codex, using the CLI login on that server or an API key.

## What it does

1. **Upload** a contract (DOCX, or PDF with a text layer). AuditIQ numbers every clause (sections, articles, exhibits) so it can check citations later.
2. **Extraction** pulls parties, dates, scope, pricing, obligations, and the issues a reviewer needs to resolve.
3. **Accounting review** works from the extraction and the contract to assess performance obligations, transaction price, allocation, and recognition timing, and raises the judgments that need a person.
4. **Review** the findings next to the contract. Each one shows its required action, its reasoning, and the quoted clauses. The same issue raised by both steps, or by a rerun, stays one finding.
5. **Publish** verified findings to Jira as issues. Publishing again, retrying after an outage, or rerunning an analysis never creates a duplicate issue.
6. **Follow up in Jira.** AuditIQ mirrors each issue's status, assignee, and comments. Optionally, people can mention `@AuditIQ` in a comment and get a short reply grounded in the finding's quotes.

## Quick start

### Docker

```bash
git clone <this repository> auditiq && cd auditiq
docker compose up -d
```

Open http://localhost:5180 and create the owner account. The setup steps walk you through connecting Jira and choosing an AI provider.

Everything AuditIQ stores lives in the `auditiq-data` volume: the database, uploaded contracts, and CLI logins.

To use a Claude or Codex subscription login inside the container instead of an API key:

```bash
docker compose exec auditiq node apps/server/scripts/login.ts claude
docker compose exec auditiq node apps/server/scripts/login.ts codex
```

### On a server without Docker

Requires Node 24 and pnpm 11.

```bash
pnpm install
pnpm build
pnpm start
```

AuditIQ listens on `127.0.0.1:5180` by default. Put a reverse proxy with TLS in front of it and set `BASE_URL` to the address people use. [docs/operations.md](docs/operations.md) has a Caddy example, a systemd unit, and backup instructions.

## Configuration

Almost everything is configured in the app under **Settings**, by an admin. The environment only covers what the server needs before anyone signs in. See [.env.example](.env.example).

| Variable | Default | What it's for |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:5180` | The address people use. Sign-in cookies and invite links depend on it. |
| `DATA_DIR` | `.data` | Database, uploads, and CLI logins. Back this up. |
| `HOST`, `PORT` | `127.0.0.1`, `5180` | Where the server listens. |
| `AUDITIQ_SECRET` | generated | Encrypts stored secrets and signs sessions. Generated into `DATA_DIR` on first start. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | unset | Used only when there's no CLI login on the server. Can also be set in Settings. |
| `JIRA_POLL_SECONDS` | `60` | How often AuditIQ checks Jira for changes. |

### Connecting Jira

AuditIQ works with Jira Cloud.

1. Create an Atlassian account for AuditIQ to act as, such as `auditiq-bot@yourcompany.com`, and give it access to one project. Its work is then easy to spot in Jira, and its permissions stay narrow.
2. Create an API token for that account at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens). Classic and scoped tokens both work.
3. In AuditIQ, go to **Settings > Jira**, enter the site URL, email, and token, then pick the project, the issue type, and which Jira priority each finding level maps to.

AuditIQ tags every issue it creates with the `auditiq` label plus one label per finding (`auditiq-fnd-...`). That label is how it finds existing issues, so no custom fields or Jira admin changes are needed. Don't remove the labels.

What goes to Jira: the finding, its required action, its reasoning, the quoted clauses, and a link back to AuditIQ. The contract file and the full analysis stay on your server.

### AI providers

**Settings > AI provider** picks between Claude (Anthropic) and Codex (OpenAI) and sets the model and effort. For each provider, AuditIQ uses:

1. **The CLI login on the server**, if there is one. Run `pnpm cli-login claude` or `pnpm cli-login codex` as the user AuditIQ runs as, or use an existing `claude` or `codex` login. For Codex, the host's configured model provider carries over too, so a Codex set up to go through a proxy keeps working.
2. **An API key** otherwise, from Settings or the environment.

The settings page shows which one is in use and why a provider isn't ready. Admins can let reviewers switch provider for a single run.

Analysis runs are isolated from the host's own agent setup. Claude runs with no tools, no settings files, and no skills. Codex runs in a private home directory with its shell, apps, plugins, and web search turned off, so the host's AGENTS.md and MCP servers never reach an AuditIQ prompt. The model only sees the contract and the instructions AuditIQ gives it.

## Using it

- **Roles.** The first account is the owner, an admin. Admins invite people under **Settings > Members** by copying an invite link, so no mail server is needed. Reviewers upload, run, and publish; admins also manage settings and members.
- **The workspace.** A contract opens in two resizable panes. Each pane can show the analysis, a findings table, one finding in detail, the contract, or its outline. The **Review**, **Read**, and **Triage** presets set up common layouts. The URL holds the layout and the selected finding, so a link opens exactly what you were looking at.
- **Runs** happen on the server. Closing the tab doesn't stop them, and a teammate opening the contract sees the same progress.
- **The Jira watcher** (**Settings > Jira watcher**) answers `@AuditIQ` questions in issue comments. Start in **Shadow** mode, which records what it would say without posting. **Assist** posts replies. A reply is only posted if it relies solely on the finding's verified quotes, passes a confidence bar, and fits a budget of three replies per issue per hour. Comments that look like prompt injection are refused before any model call.

## Development

```bash
pnpm install
pnpm dev            # API on :5180, web app on :5173 with /api proxied
```

The server runs TypeScript directly on Node 24, so it has no build step. Useful commands:

```bash
pnpm typecheck      # every package, plus the e2e and eval code
pnpm lint           # Biome
pnpm e2e            # end-to-end tests
pnpm eval           # score the agents on the test contract (calls models)
pnpm db:generate    # new migration after editing apps/server/src/db/schema.ts
```

[docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

### Tests

The end-to-end suite is the test suite. It starts the real server with the built web app against a fake Jira (`e2e/fake-jira.ts`) and replays model output recorded from real Claude runs (`e2e/fixtures/replay`). It covers setup, both analysis steps, publishing and republishing, Jira outages and rate limits, the watcher's gates, roles, PDFs, and failed runs.

Each run leaves a report in `e2e/.artifacts/report` with a trace and screenshots for every test, plus the fake Jira's full contents as attachments.

The test contract lives in `e2e/fixtures/northwind-msa.md` and is built into DOCX and PDF at test time. To re-record the replay fixtures after changing a prompt or schema, run the server with `AUDITIQ_RECORD_DIR=e2e/fixtures/replay`, then upload the contract and run both steps.

### Evals

`pnpm eval` runs both agents on every signed-in provider and scores them against the 14 ASC 606 issues planted in the Northwind contract (`evals/northwind.expected.json`). It reports recall and citation validity. `pnpm eval --replay` scores the recorded fixtures without calling a model. Reports go to `evals/reports`.

## Security

- Uploaded contracts, analyses, and the audit log stay on your server. Jira receives only the finding summary, the required action, and the quoted clauses.
- Jira tokens and API keys are encrypted at rest with a key derived from `AUDITIQ_SECRET`. The API never returns them, and the stored Jira token is only ever sent to the site it was entered for. Admins see the last four characters.
- Contract text and Jira comments are treated as untrusted. Analysis runs have no tools, and watcher replies pass deterministic checks before anything is posted.
- Every run, publish, Jira write, watcher decision, and settings change is recorded with the person who caused it. **Settings > Audit log** exports it all as JSON.
- Only the first account, or someone holding an invite link, can sign up. Knowing an invited person's email isn't enough. Sign-in is rate limited.
