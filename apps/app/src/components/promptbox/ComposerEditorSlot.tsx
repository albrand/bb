import type { RefObject } from "react";
import { useAtomValue } from "jotai";
import { EditorContent, type Editor } from "@tiptap/react";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PromptMentionLinkContext,
  type PromptMentionLinkResolver,
} from "./editor/prompt-mention-link";
import {
  composerEditorHeightAtom,
  COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE,
  getComposerEditorMaxHeightCss,
  resolveComposerEditorMinHeightCss,
  type ComposerEditorLayout,
} from "./composerHeightAtoms";

export type { ComposerEditorLayout } from "./composerHeightAtoms";

export function blurPromptEditor(editor: Editor | null | undefined): void {
  editor?.view.dom.blur();
  window.getSelection()?.removeAllRanges();
}

export function ComposerEditorSlot({
  editor,
  scrollContainerRef,
  inputLocked,
  isCompactLayout,
  minHeight,
  layout,
  resolveMentionLink,
}: {
  editor: Editor | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  inputLocked: boolean;
  isCompactLayout: boolean;
  minHeight: number;
  layout: ComposerEditorLayout;
  resolveMentionLink: PromptMentionLinkResolver | undefined;
}) {
  const userHeightPx = useAtomValue(composerEditorHeightAtom);
  return (
    <div
      ref={scrollContainerRef}
      data-promptbox-editor-scroll=""
      aria-busy={inputLocked || undefined}
      className={cn(
        "w-full overflow-y-auto bg-transparent px-4 pb-1 pr-14 pt-3 outline-none",
        COARSE_POINTER_TEXT_BASE_CLASS,
        "leading-relaxed",
        isCompactLayout && "h-12 overflow-hidden pb-0 pr-14 pt-0",
      )}
      style={{
        minHeight: isCompactLayout
          ? "48px"
          : `var(${COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE}, ${resolveComposerEditorMinHeightCss(
              {
                floorPx: minHeight,
                userHeightPx,
                layout,
              },
            )})`,
        height: isCompactLayout ? "48px" : undefined,
        maxHeight: isCompactLayout
          ? "48px"
          : getComposerEditorMaxHeightCss(layout),
      }}
    >
      <PromptMentionLinkContext.Provider value={resolveMentionLink ?? null}>
        <EditorContent
          editor={editor}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            if (editor === null || editor.isEditable) return;
            event.preventDefault();
            blurPromptEditor(editor);
          }}
          data-promptbox-editor-content=""
          data-promptbox-compact-content={isCompactLayout ? "" : undefined}
          className={cn(
            "h-full min-h-full",
            isCompactLayout && "flex items-center",
            "[&_.ProseMirror]:min-h-full [&_.ProseMirror]:leading-[1.7] [&_.ProseMirror]:outline-none",
            "[&_.ProseMirror_p]:m-0",
            "[&_.ProseMirror_blockquote]:my-1 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-surface-selected-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-muted-foreground",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-subtle-foreground",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:font-light",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:opacity-70",
          )}
        />
      </PromptMentionLinkContext.Provider>
    </div>
  );
}
