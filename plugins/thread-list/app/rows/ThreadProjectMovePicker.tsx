import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { SidebarThread } from "../model/sidebar-thread.js";

export function ThreadProjectMovePicker({
  thread,
  surface,
  onCloseMenu,
}: {
  thread: SidebarThread;
  surface: "context" | "dropdown";
  onCloseMenu: () => void;
}) {
  const sdk = useSdk();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<
    Awaited<ReturnType<typeof sdk.projects.list>>
  >([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return projects.filter((project) =>
      project.name.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [projects, query]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setLoading(true);
      setError(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void sdk.projects
      .list({ includePersonal: true })
      .then((result) => {
        if (!cancelled) setProjects(result);
      })
      .catch(() => {
        if (!cancelled) setError("Projects could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sdk]);

  const moveToProject = async (projectId: string) => {
    if (projectId === thread.projectId || moving) return;
    setMoving(true);
    setError(null);
    try {
      await sdk.threads.experimental_moveToProject({
        threadId: thread.id,
        projectId,
      });
      toast.success("Thread moved to project");
      setOpen(false);
      onCloseMenu();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Thread could not be moved.";
      setError(message);
      toast.error(message);
    } finally {
      setMoving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <Item
          className="flex items-center gap-2"
          onSelect={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <Icon name="FolderOpen" aria-hidden="true" />
          Move to project…
        </Item>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-2rem))] max-h-[min(32rem,calc(100dvh-2rem))] overflow-hidden p-0"
        mobileTitle="Move to project"
        mobileClassName="max-h-[85dvh] p-0"
      >
        <div className="flex min-h-0 flex-col gap-3 p-4">
          <div>
            <h2 className="font-medium text-foreground">Move to project</h2>
            <p className="text-sm text-muted-foreground">
              Choose where this thread should appear.
            </p>
          </div>
          <Input
            aria-label="Search projects"
            placeholder="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div
            className="min-h-0 space-y-1 overflow-y-auto"
            role="listbox"
            aria-label="Projects"
          >
            {loading ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                Loading projects…
              </p>
            ) : null}
            {!loading && filteredProjects.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No matching projects.
              </p>
            ) : null}
            {filteredProjects.map((project) => {
              const isCurrent = project.id === thread.projectId;
              return (
                <Button
                  key={project.id}
                  type="button"
                  variant="ghost"
                  className="min-h-11 w-full justify-start gap-2 px-3"
                  role="option"
                  aria-selected={isCurrent}
                  disabled={isCurrent || moving}
                  onClick={() => void moveToProject(project.id)}
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    {project.name}
                  </span>
                  {isCurrent ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Current
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
