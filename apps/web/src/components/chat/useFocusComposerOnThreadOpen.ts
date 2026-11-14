import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { restoreFocusOnThreadEnter } from "../../lib/terminalFocus";

const neverPreserveFocus = () => false;

/** Restores thread focus, landing the caret a frame after composer entry. */
export function useFocusComposerOnThreadOpen(
  threadRef: ScopedThreadRef | null,
  root: HTMLElement | null,
  enabled: boolean,
  terminalOpen: boolean,
  focusComposer: () => void,
  /** Read on each entry: true leaves focus where it is, as when it already sits in the pane. */
  preserveFocus: () => boolean = neverPreserveFocus,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores DOM focus on thread entry and after the drawer opens or closes
  useEffect(() => {
    if (!threadRef || !enabled || !root) return;
    let frame: number | undefined;
    const leave = restoreFocusOnThreadEnter(
      threadRef,
      {
        root,
        focusComposer: () => {
          frame = window.requestAnimationFrame(() => {
            // Double-clicking a sidebar row opens its thread and its rename field in one gesture.
            if (document.activeElement?.matches("[data-sidebar-row] input")) return;
            focusComposer();
          });
        },
      },
      preserveFocus(),
    );
    return () => {
      leave();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [
    threadRef,
    root,
    enabled,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Drawer visibility changes also restore focus after explicit open/close actions.
    terminalOpen,
    focusComposer,
    preserveFocus,
  ]);
}
