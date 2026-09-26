import { env } from "../env.ts";
import { poll, reconcile } from "./poller.ts";
import { processOutbox } from "./publisher.ts";
import { postPendingReplies } from "./watcher.ts";

// Background Jira work: poll for changes, retry queued publications and replies, and
// periodically check that linked issues still exist. Every task is a no-op until Jira is
// configured, so the timers can start at boot unconditionally.

function logFailure(task: string) {
  return (error: unknown) => console.error(`Jira ${task} failed:`, error instanceof Error ? error.message : error);
}

export function startJiraSync(): void {
  const pollAndReply = async () => {
    await poll();
    await postPendingReplies();
  };
  setTimeout(() => void pollAndReply().catch(logFailure("poll")), 3000).unref();
  setInterval(() => void pollAndReply().catch(logFailure("poll")), env.JIRA_POLL_SECONDS * 1000).unref();
  setInterval(() => void processOutbox().catch(logFailure("publish retry")), 30_000).unref();
  setInterval(() => void reconcile().catch(logFailure("reconcile")), 6 * 3_600_000).unref();
}
