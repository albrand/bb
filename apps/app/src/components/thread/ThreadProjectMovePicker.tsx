import { useEffect, useMemo, useState } from "react";
import type { Thread } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@bb/shared-ui/popover";
import { sdk } from "@/lib/sdk";

interface ThreadProjectMovePickerProps {
  thread: Pick<Thread, "id" | "projectId">;
  onCloseMenu: () => void;
  onMoveToProject: (projectId: string) => Promise<void>;
  inline?: boolean;
  onBack?: () => void;
}

export function ThreadProjectMovePicker({
  thread,
  onCloseMenu,
  onMoveToProject,
  inline = false,
  onBack,
}: ThreadProjectMovePickerProps) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Awaited<
    ReturnType<typeof sdk.projects.list>
  > | null>(null);
  const [query, setQuery] = useState("");
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (projects ?? []).filter((project) =>
      project.name.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [projects, query]);
  const active = inline || open;
  const loading = active && projects === null;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void sdk.projects
      .list({ includePersonal: true })
      .then((result) => {
        if (!cancelled) setProjects(result);
      })
      .catch(() => {
        if (!cancelled) {
          setProjects([]);
          setError("Projects could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, setProjects]);

  const moveToProject = async (projectId: string) => {
    if (projectId === thread.projectId || moving) return;
    setMoving(true);
    setError(null);
    try {
      await onMoveToProject(projectId);
      setOpen(false);
      onCloseMenu();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Thread could not be moved.",
      );
    } finally {
      setMoving(false);
    }
  };

  const panel = (
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
  );

  if (inline) {
    return (
      <>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onBack?.();
          }}
        >
          <Icon name="ChevronLeft" aria-hidden="true" />
          Back
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {panel}
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <DropdownMenuItem
          className="flex items-center gap-2"
          onSelect={(event) => {
            event.preventDefault();
            setError(null);
            setOpen(true);
          }}
        >
          <Icon name="FolderOpen" aria-hidden="true" />
          Move to project…
        </DropdownMenuItem>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-2rem))] max-h-[min(32rem,calc(100dvh-2rem))] overflow-hidden p-0"
        mobileTitle="Move to project"
        mobileClassName="max-h-[85dvh] p-0"
      >
        {panel}
      </PopoverContent>
    </Popover>
  );
}
