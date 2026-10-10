import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { useSendNativeTerminalMessage } from "@/hooks/queries/native-terminal-queries";

interface NativeTerminalPromptBarProps {
  providerLabel: string;
  threadId: string;
}

export function NativeTerminalPromptBar({
  providerLabel,
  threadId,
}: NativeTerminalPromptBarProps) {
  const inputId = useId();
  const [text, setText] = useState("");
  const send = useSendNativeTerminalMessage();
  const message = text.trim();
  const canSend = message.length > 0 && !send.isPending;

  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canSend) return;
    send.mutate(
      { text: message, threadId },
      {
        onSuccess: () => {
          setText("");
        },
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      className="flex shrink-0 items-end gap-2 border-t border-border/50 bg-sidebar px-2 py-2"
      data-native-terminal-prompt=""
      onSubmit={submit}
    >
      <label className="sr-only" htmlFor={inputId}>
        Message {providerLabel}
      </label>
      <textarea
        id={inputId}
        rows={1}
        value={text}
        enterKeyHint="send"
        placeholder={`Message ${providerLabel}`}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={onKeyDown}
        className="max-h-32 min-h-11 min-w-0 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground field-sizing-content placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
      />
      <Button
        type="submit"
        size="icon"
        className="size-11 shrink-0"
        disabled={!canSend}
        aria-label={`Send to ${providerLabel}`}
      >
        <Icon name="ArrowUp" className="size-4" />
      </Button>
    </form>
  );
}
