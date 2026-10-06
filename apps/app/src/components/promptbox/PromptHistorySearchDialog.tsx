import { useCallback, useEffect, useRef } from "react";
import type { PromptDraftState } from "@bb/client-core";
import { Dialog, DialogContent, DialogTitle } from "@bb/shared-ui/dialog";
import { PromptHistorySearchBodySplit } from "./PromptHistorySearchBodySplit";

interface PromptHistorySearchDialogProps {
  open: boolean;
  projectId: string;
  onOpenChange: (open: boolean) => void;
  onInsert: (draft: PromptDraftState) => void;
  onAfterClose: () => void;
}

export function PromptHistorySearchDialog({
  open,
  projectId,
  onOpenChange,
  onInsert,
  onAfterClose,
}: PromptHistorySearchDialogProps) {
  const insertionEpoch = useRef(0);
  useEffect(
    () => () => {
      insertionEpoch.current += 1;
    },
    [],
  );
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) insertionEpoch.current += 1;
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );
  const beginInsertion = useCallback(() => {
    const epoch = insertionEpoch.current;
    return (draft: PromptDraftState) => {
      if (insertionEpoch.current !== epoch) return false;
      onInsert(draft);
      return true;
    };
  }, [onInsert]);
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        className="top-[12%] max-w-[880px] translate-y-0 gap-0 p-0 shadow-lg sm:rounded-xl"
        onAfterCloseAutoFocus={onAfterClose}
        data-testid="prompt-history-search"
      >
        <DialogTitle className="sr-only">Search prompt history</DialogTitle>
        <PromptHistorySearchBodySplit
          open={open}
          projectId={projectId}
          onClose={() => handleOpenChange(false)}
          beginInsertion={beginInsertion}
        />
      </DialogContent>
    </Dialog>
  );
}
