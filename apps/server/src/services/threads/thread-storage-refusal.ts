const RETRY_TEXT =
  "bb tries again about every ten seconds and deletes the files once nothing is working inside them.";
const MAX_PROCESSES_NAMED = 5;

export function describeThreadStorageRefusal(daemonMessage: string): string {
  const processIds = [
    ...new Set(
      [...daemonMessage.matchAll(/\b(?:pid|process) (\d+)/gu)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ]
    .filter((id) => id !== "")
    .slice(0, MAX_PROCESSES_NAMED);
  const named =
    processIds.length === 0
      ? ""
      : ` (${processIds.map((id) => `pid ${id}`).join(", ")})`;
  const what = daemonMessage.includes("could not be established")
    ? `whether a process is still working inside it could not be established${named}`
    : `${processIds.length === 1 ? "a process is" : "processes are"} still working inside it${named}`;
  return `Refusing to delete thread storage: ${what}. Nothing was stopped and nothing was removed. ${RETRY_TEXT}`;
}
