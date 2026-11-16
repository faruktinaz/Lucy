/**
 * The spacing scale, in terminal cells. Components never invent paddings: they use these
 * named steps, and the density setting changes padding and gaps, never structure.
 *
 *   0  flush            1  tight (row padding, icon gap)
 *   2  comfortable      3  roomy (overlay padding)      4  section indent in dialogs
 */
import type { Density } from "../theme/ui-theme";

export const SPACE = { none: 0, xs: 1, sm: 2, md: 3, lg: 4 } as const;

/** Fixed sizes of shell chrome. */
export const SIZE = {
  commandBarHeight: 1,
  statusBarHeight: 1,
  tabStripHeight: 1,
  panelHeaderHeight: 1,
  activityBarWidth: 4,
  /** Indentation per tree depth. */
  treeIndent: 2,
  toastWidth: 46,
  maxToasts: 3,
  dialogWidth: 58,
  quickPickWidth: 84,
  quickPickMaxRows: 12,
  menuMinWidth: 26,
} as const;

export interface DensityMetrics {
  readonly density: Density;
  /** Horizontal padding of rows and headers inside side panels. */
  readonly rowPaddingX: number;
  /** Blank rows between a panel header and its content, and between sections. */
  readonly sectionGap: number;
  /** Padding inside floating overlays (dialogs, quick pick, toasts). */
  readonly overlayPaddingX: number;
  readonly overlayPaddingY: number;
  /** Horizontal padding around a tab title in the tab strip. */
  readonly tabPaddingX: number;
  /** Cells between status bar items. */
  readonly statusGap: number;
  /** Blank rows above the content of an empty state. */
  readonly emptyStateTop: number;
}

const COMFORTABLE: DensityMetrics = {
  density: "comfortable",
  rowPaddingX: 1,
  sectionGap: 1,
  overlayPaddingX: 2,
  overlayPaddingY: 1,
  tabPaddingX: 2,
  statusGap: 2,
  emptyStateTop: 2,
};

const COMPACT: DensityMetrics = {
  density: "compact",
  rowPaddingX: 1,
  sectionGap: 0,
  overlayPaddingX: 1,
  overlayPaddingY: 0,
  tabPaddingX: 1,
  statusGap: 1,
  emptyStateTop: 1,
};

export function densityMetrics(density: Density): DensityMetrics {
  return density === "compact" ? COMPACT : COMFORTABLE;
}
