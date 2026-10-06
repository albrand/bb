import { defineSplit } from "@/lib/define-split";
import type { PromptHistorySearchBodyProps } from "./PromptHistorySearchBody";

export const PromptHistorySearchBodySplit =
  defineSplit<PromptHistorySearchBodyProps>({
    id: "prompt-history-search-body",
    load: () =>
      import("./PromptHistorySearchBody").then(
        (module) => module.PromptHistorySearchBody,
      ),
    loading: () => (
      <div
        role="status"
        aria-label="Loading prompt history"
        className="h-[min(26rem,60dvh)]"
      />
    ),
    tier: "intent",
    mountWhen: ({ open }) => open,
    keepMounted: true,
  });
