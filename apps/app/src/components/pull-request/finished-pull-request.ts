import type { PullRequestState } from "@bb/domain";

const FINISHED_PULL_REQUEST_STATES: readonly PullRequestState[] = [
  "closed",
  "merged",
];

export function isFinishedPullRequest(pullRequest: {
  state: PullRequestState;
}): boolean {
  return FINISHED_PULL_REQUEST_STATES.includes(pullRequest.state);
}
