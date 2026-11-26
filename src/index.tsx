// Local Contrast, a Safelight extension (GPL-3.0-or-later).
//
// A port of darktable's local contrast (src/iop/bilat.c with
// src/common/locallaplacian.c and src/common/bilateral.c; Copyright (C)
// 2012-2026 darktable developers): local contrast and tonal compression on
// L*, by a local laplacian filter or a bilateral grid. Registers the display
// stage (stage.ts) and the Develop panel (Panel.tsx), which also edits a
// mask's in the Masking panel.

import { LocalContrastPanel, TITLE } from "./Panel";
import { DRAW_KEYS, EDIT_KEYS, EXT_ID, qualified, rederivePatch, resetPatch } from "./params";
import { api, initRuntime, type DevelopView, type Host } from "./rt";
import { localContrastStage } from "./stage";

export const PANEL_ID = `${EXT_ID}.panel`;

let unsubscribe: (() => void) | null = null;

function reset(): void {
  const dev = api.stores.useDevelopStore.getState();
  dev.setDynParams(resetPatch());
  void dev.commitEdit(`${TITLE} reset`);
}

export function activate(host: Host): void {
  initRuntime(host);
  host.registerProcessingStage(localContrastStage());
  host.registerPanel({
    id: PANEL_ID,
    title: TITLE,
    component: LocalContrastPanel,
    defaultDock: { module: "develop", direction: "right", width: 280 },
    modules: ["develop"],
    onReset: reset,
    mask: { component: LocalContrastPanel, owns: [...EDIT_KEYS, ...DRAW_KEYS].map(qualified) },
  });

  unsubscribe?.();
  // A bag whose draw counts disagree with its edit (a preset or paste that
  // carried only some keys) is re-derived live, the photo's and each mask's.
  unsubscribe = host.stores.useDevelopStore.subscribe((state: DevelopView, prev: DevelopView) => {
    if (state.params.masks !== prev.params.masks) {
      for (const mask of state.params.masks) {
        if (prev.params.masks.some((m) => m.id === mask.id && m.bag === mask.bag)) continue;
        const patch = mask.bag ? rederivePatch(mask.bag) : null;
        if (patch) state.updateMaskBag(mask.id, patch);
      }
    }
    if (state.paramBag === prev.paramBag) return;
    const patch = rederivePatch(state.paramBag);
    if (patch) state.setDynParams(patch);
  });
}

/** The host sweeps the stage and the panel after every deactivate. */
export function deactivate(): void {
  unsubscribe?.();
  unsubscribe = null;
}
