// Where the end-to-end servers listen. IPv6 loopback by default: connecting to a closed
// port there fails immediately everywhere, while some setups (WSL with Tailscale) make
// 127.0.0.1 hang for minutes, which stalls Playwright's startup check.
export const HOST = process.env.E2E_HOST ?? "::1";
const urlHost = HOST.includes(":") ? `[${HOST}]` : HOST;
export const ports = { app: 5198, jira: 5199 };
export const APP = `http://${urlHost}:${ports.app}`;
export const JIRA_URL = `http://${urlHost}:${ports.jira}`;
