# AuditIQ

## Quick start

### Docker

```bash
git clone <this repository> auditiq && cd auditiq
docker compose up -d
```

Open http://localhost:5180 and follow [First-time setup](#first-time-setup).

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

AuditIQ listens on `127.0.0.1:5180` by default. Put a reverse proxy with TLS in front of it and set `BASE_URL` to the address people use.

## First-time setup

You need three things before you start:

- **A Jira Cloud site** with a project for findings to land in. Jira's Free plan works, and covers up to 10 users.
- **An Atlassian account for AuditIQ to act as**, with permission to create issues in that project. A dedicated account such as `auditiq-bot@yourcompany.com` keeps AuditIQ's work easy to spot and its permissions narrow. Your own account works too, but then your own @mentions won't reach the [Jira watcher](#the-jira-watcher).
- **A way to run models.** That's a Claude or Codex CLI login on the server, or an Anthropic or OpenAI API key.

### 1. Create the owner account

The first time you open AuditIQ, it asks you to **Create the owner account**. Enter your name, your email, and a password of at least 10 characters. This account is an admin. After this, people can only join with an invite link.

### 2. Connect Jira (setup step 1 of 2)

First, create an API token for AuditIQ's Atlassian account:

1. Sign in as that account at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Select **Create API token**. Classic and scoped tokens both work.
3. Name it `AuditIQ` and check **Expires on**. Atlassian sets it about a week out by default. Pick a later date, up to a year away, or AuditIQ loses its connection when the token expires.
4. Select **Create**, then copy the token. Atlassian shows it only once.

Atlassian sometimes asks you to re-verify your identity before it creates a token. Select **Verify your identity** in the dialog, enter the code Atlassian emails you, and create the token again.

Then fill in the Jira page in AuditIQ:

1. Enter the **Site URL** (`https://your-site.atlassian.net`), the account's **Email**, and the **API token**, then select **Save and test**. AuditIQ shows which Jira account it connected as.
2. Under **Where findings go**, choose the **Project**, the **Issue type** (Task works well), and the **Jira priority for each finding level**. Leave a level blank to create those issues without a priority.
3. Select **Save and continue**.

AuditIQ tags every issue it creates with the `auditiq` label plus one label per finding (`auditiq-fnd-...`). It uses that label to find issues it already created, so it needs no custom fields or Jira admin changes. Don't remove the labels.

Each issue holds the finding's reasoning, its required action, the contract term and quoted clauses, the contract's number or file name, and a link back to AuditIQ. The contract file and the full analysis stay on your server.

### 3. Choose an AI provider (setup step 2 of 2)

Under **Run analyses with**, pick Claude or Codex, then choose the model and effort. Medium effort suits most contracts. AuditIQ uses the server's CLI login for that provider if there is one, and the API key otherwise. [AI providers](#ai-providers) explains both. Select **Finish setup**.

### 4. Invite your team

Under **Settings > Members**, enter a teammate's email, pick a role, and select **Invite**. Then send them the link from **Copy link**. AuditIQ needs no mail server. There are two roles:

- **Reviewers** upload contracts, run analyses, and publish findings.
- **Admins** can also change settings and manage members.

## Reviewing a contract

1. **Upload it.** On **Contracts**, select **Upload contract**, or drop a file anywhere on the page. Extraction starts on its own.
2. **Wait for extraction.** Runs happen on the server, so you can close the tab, and a teammate who opens the contract sees the same progress. The contract list shows where each contract stands: **Extraction ready**, then **Ready for review**, then **All findings in Jira**.
3. **Run the accounting review.** Open the contract, switch to the **Accounting review** step, and select **Run accounting review**. It builds on the extraction, so it's available once extraction finishes.
4. **Review the findings.** Each finding shows its required action, its reasoning, and the clauses it quotes. The workspace has two resizable panes, and the **Review**, **Read**, and **Triage** presets arrange them for common jobs. A finding whose quotes don't match the contract is **held back**. It shows the reason and can't be published.
5. **Publish.** Verified findings that aren't in Jira yet start out checked. Uncheck any you want to leave out, select **Publish to Jira**, and confirm. The dialog links to each new issue.
6. **Work the issues in Jira.** AuditIQ checks Jira every minute and mirrors each issue's status, assignee, and comments. **Jira activity** shows recent changes, the watcher's decisions, and publishes waiting on a retry. **Check Jira now** checks right away.

The URL holds the workspace layout and the selected finding, so a link opens exactly what you were looking at. **Findings** lists the findings from every contract in one place.

## The Jira watcher

People can ask AuditIQ about a finding from inside the Jira issue. They @mention AuditIQ's Jira account in a comment, or write `@AuditIQ`. Choose the mode under **Settings > Jira watcher**:

- **Off**: AuditIQ ignores mentions.
- **Shadow**: AuditIQ records the reply it would post, and posts nothing. Start here, and read its drafts on **Jira activity**.
- **Assist**: AuditIQ posts replies.

AuditIQ only posts a reply that relies on the finding's verified quotes alone, clears a confidence bar, stays under 1,500 characters, and fits a budget of three replies per issue per hour. It refuses comments that look like prompt injection before any model call.

AuditIQ ignores comments from its own Atlassian account, so it never answers itself. If it acts as your personal account, it ignores your mentions too. Give it a dedicated account if people should be able to ask it questions.

## Keeping the Jira connection working

- **The token expired.** Create a new one as in [step 2](#2-connect-jira-setup-step-1-of-2). Then go to **Settings > Jira**, paste it into **API token**, and select **Save and test**.
- **Jira says "Your Jira Cloud subscription has been deactivated due to inactivity".** Atlassian switches off free sites that go unused for a while, and emails the site admin before it does. To turn the site back on, go to [admin.atlassian.com](https://admin.atlassian.com), open **Billing > Subscriptions**, select the **Inactive** tab, and select **Reactivate** next to Jira. It stays on the Free plan. Atlassian restores your data if you reactivate within 15 days of the shutdown, and deletes it after that. Jira's API can take a couple of minutes to answer again.
- **Issues stopped syncing.** **Jira activity** shows the error from the last check. **Save and test** under **Settings > Jira** checks the connection again.

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

### AI providers

**Settings > AI provider** picks between Claude (Anthropic) and Codex (OpenAI) and sets the model and effort. For each provider, AuditIQ uses:

1. **The CLI login on the server**, if there is one. Run `pnpm cli-login claude` or `pnpm cli-login codex` as the user AuditIQ runs as, or use an existing `claude` or `codex` login. For Codex, the host's configured model provider carries over too, so a Codex set up to go through a proxy keeps working.
2. **An API key** otherwise, from Settings or the environment.

The settings page shows which one is in use and why a provider isn't ready. Admins can let reviewers switch provider for a single run.

Analysis runs are isolated from the host's own agent setup. Claude runs with no tools, no settings files, and no skills. Codex runs in a private home directory with its shell, apps, plugins, and web search turned off, so the host's AGENTS.md and MCP servers never reach an AuditIQ prompt. The model only sees the contract and the instructions AuditIQ gives it.

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
