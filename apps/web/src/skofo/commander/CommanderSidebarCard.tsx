import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BotIcon, MicIcon, PanelRightIcon } from "lucide-react";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { Button } from "../../components/ui/button";
import { Text } from "../../components/ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn, isMacPlatform } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import type { SidebarThreadSummary } from "../../types";
import {
  commanderHasUnreadCompletion,
  type CommanderSidebarStats,
  isCommanderThreadWorking,
  requestCommanderDictation,
} from "./commanderConstants";

export interface CommanderSidebarCardProps {
  readonly thread: SidebarThreadSummary;
  readonly stats: CommanderSidebarStats;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  readonly onOpenToSide: (threadRef: ScopedThreadRef) => void;
}

export function CommanderSidebarCard({
  thread,
  stats,
  isActive,
  onOpen,
  onOpenToSide,
}: CommanderSidebarCardProps) {
  const gt = useGT();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const working = isCommanderThreadWorking(thread);
  const unread = !isActive && commanderHasUnreadCompletion(thread);

  const openCommander = useStableCallback(() => {
    onOpen(threadRef);
  });

  const handleVoiceClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    requestCommanderDictation(threadKey);
    onOpen(threadRef);
  };

  const handleOpenToSideClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onOpenToSide(threadRef);
  };

  // Global jump shortcut: Cmd/Ctrl+Shift+J opens Computer from anywhere.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to global window keydown for the Cmd/Ctrl+Shift+J jump-to-Computer shortcut
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const mod = isMacPlatform(navigator.platform)
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (!mod || !event.shiftKey || event.key.toLowerCase() !== "j") return;
      if (isCommandPaletteOpen() || isModelPickerOpen()) return;
      event.preventDefault();
      openCommander();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openCommander]);

  const subtitle = (() => {
    if (working) return gt("Working...");
    if (stats.blocked > 0) return gt("{count} waiting", { count: stats.blocked });
    if (stats.failed > 0) return gt("{count} failed", { count: stats.failed });
    if (stats.working > 0) return gt("{count} working", { count: stats.working });
    if (stats.active > 0) return gt("{count} active", { count: stats.active });
    return gt("Ready");
  })();

  const dotClassName = working
    ? "bg-primary animate-pulse"
    : stats.blocked > 0
      ? "bg-warning"
      : stats.failed > 0
        ? "bg-destructive"
        : unread
          ? "bg-info"
          : "bg-success";

  const computerName = gt("Computer", { $context: "name of the persistent top-level agent" });
  const shortcutHint = isMacPlatform(typeof navigator === "undefined" ? "" : navigator.platform)
    ? "⌘⇧J"
    : "Ctrl+Shift+J";

  return (
    <div
      data-slot="skofo-commander-card"
      data-active={isActive ? "true" : undefined}
      role="button"
      tabIndex={0}
      aria-current={isActive ? "page" : undefined}
      aria-label={gt("Open Computer ({status}, {shortcut})", {
        status: subtitle,
        shortcut: shortcutHint,
      })}
      onClick={() => onOpen(threadRef)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(threadRef);
        }
      }}
      className={cn(
        "group/commander mt-1.5 flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors select-none",
        isActive
          ? "border-primary/40 bg-accent text-accent-foreground shadow-xs"
          : "border-sidebar-border/80 bg-accent/40 text-sidebar-foreground hover:bg-accent/75",
      )}
    >
      <div className="relative flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary">
        <BotIcon className="size-3.5" />
        <span
          aria-hidden="true"
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar",
            dotClassName,
          )}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
          <Text variant="label" tone="inherit" truncate>
            {computerName}
          </Text>
          {unread ? (
            <span
              aria-label={gt("New reply from Computer")}
              className="size-1.5 shrink-0 rounded-full bg-info"
            />
          ) : null}
        </div>
        <Text variant="caption" tone="muted" truncate>
          {subtitle}
        </Text>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <span className="opacity-0 transition-opacity group-hover/commander:opacity-100 focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={gt("Open Computer to the side")}
                  onClick={handleOpenToSideClick}
                >
                  <PanelRightIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup>{gt("Open to the side")}</TooltipPopup>
          </Tooltip>
        </span>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Talk to Computer")}
                onClick={handleVoiceClick}
              >
                <MicIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup>{gt("Voice input ({shortcut})", { shortcut: shortcutHint })}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
