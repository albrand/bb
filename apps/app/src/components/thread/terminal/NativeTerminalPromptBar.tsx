import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { PromptInput } from "@bb/domain";
import type { UploadedPromptAttachment } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { useSendNativeTerminalMessage } from "@/hooks/queries/native-terminal-queries";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";

interface NativeTerminalPromptBarProps {
  projectId: string;
  providerLabel: string;
  threadId: string;
}

function attachmentPromptInput(
  attachment: UploadedPromptAttachment,
): PromptInput {
  if (attachment.type === "localImage") {
    return {
      type: "localImage",
      path: attachment.path,
      ...(attachment.sourceProjectId === undefined
        ? {}
        : { sourceProjectId: attachment.sourceProjectId }),
    };
  }
  return {
    type: "localFile",
    path: attachment.path,
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.mimeType === undefined
      ? {}
      : { mimeType: attachment.mimeType }),
    ...(attachment.sourceProjectId === undefined
      ? {}
      : { sourceProjectId: attachment.sourceProjectId }),
  };
}

function pastedFiles(
  clipboard: Pick<DataTransfer, "files" | "items">,
): File[] {
  const files = Array.from(clipboard.files ?? []);
  if (files.length > 0) return files;
  return Array.from(clipboard.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file === null ? [] : [file];
  });
}

export function NativeTerminalPromptBar({
  projectId,
  providerLabel,
  threadId,
}: NativeTerminalPromptBarProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<UploadedPromptAttachment[]>(
    [],
  );
  const [pendingUploads, setPendingUploads] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const send = useSendNativeTerminalMessage();
  const upload = useUploadPromptAttachment();
  const message = text.trim();
  const canSend =
    (message.length > 0 || attachments.length > 0) &&
    pendingUploads === 0 &&
    !send.isPending;

  const uploadFiles = async (files: readonly File[]) => {
    setAttachError(null);
    setPendingUploads((count) => count + files.length);
    const failed: string[] = [];
    for (const file of files) {
      try {
        const uploaded = await upload.mutateAsync({ projectId, file });
        setAttachments((current) => [...current, uploaded]);
      } catch {
        failed.push(file.name);
      } finally {
        setPendingUploads((count) => count - 1);
      }
    }
    if (failed.length > 0) {
      setAttachError(`Failed to attach ${failed.join(", ")}`);
    }
  };

  const attachFiles = (files: readonly File[]) => {
    if (files.length === 0) return;
    uploadFiles(files).catch(() => {
      setAttachError("Failed to attach the selected files");
    });
  };

  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canSend) return;
    const sentAttachments = attachments;
    const sentText = text;
    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId,
      threadId,
    });
    const sentDraft = draft.getCurrent();
    const input: PromptInput[] = [
      ...sentAttachments.map(attachmentPromptInput),
      ...(message.length === 0
        ? []
        : [{ type: "text" as const, text: message, mentions: [] }]),
    ];
    send.mutate(
      { input, threadId },
      {
        onSuccess: () => {
          draft.clearIfCurrentMatches(sentDraft);
          setText((current) => (current === sentText ? "" : current));
          setAttachments((current) =>
            current.filter(
              (attachment) => !sentAttachments.includes(attachment),
            ),
          );
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

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    attachFiles(files);
  };

  return (
    <form
      className="flex shrink-0 flex-col gap-1.5 border-t border-border/50 bg-sidebar px-2 py-2"
      data-native-terminal-prompt=""
      onSubmit={submit}
    >
      {attachments.length > 0 || pendingUploads > 0 || attachError !== null ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {attachments.map((attachment, index) => (
            <span
              key={`${attachment.path}-${index}`}
              className="flex max-w-full items-center gap-1 rounded-md border border-border bg-background py-0.5 pr-0.5 pl-2 text-foreground"
            >
              <Icon name="Paperclip" className="size-3 shrink-0" />
              <span className="truncate">{attachment.name}</span>
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => {
                  setAttachments((current) =>
                    current.filter((_, position) => position !== index),
                  );
                }}
              >
                <Icon name="X" className="size-3" />
              </button>
            </span>
          ))}
          {pendingUploads > 0 ? (
            <span className="text-muted-foreground">Attaching…</span>
          ) : null}
          {attachError === null ? null : (
            <span role="alert" className="text-destructive">
              {attachError}
            </span>
          )}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label={`Attach images for ${providerLabel}`}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            attachFiles(files);
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-11 shrink-0"
          aria-label="Attach image"
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="Paperclip" className="size-4" />
        </Button>
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
          onPaste={onPaste}
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
      </div>
    </form>
  );
}
