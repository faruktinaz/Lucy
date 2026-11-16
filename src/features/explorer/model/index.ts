/** UI-independent explorer model. Views bind to `ExplorerViewModel.store` and pull rows with `getRows`. */
export {
  clampIndex,
  findTypeAhead,
  firstChildIndex,
  moveIndex,
  pageIndex,
  parentIndex,
} from "./explorer-navigation";
export { formatCount, gitBadge, gitColor } from "./explorer-row-view";
export type {
  DecorationLookup,
  DeleteConfirmation,
  ExplorerEditRow,
  ExplorerEntryRow,
  ExplorerFilterSummary,
  ExplorerGitBadge,
  ExplorerMoreRow,
  ExplorerNotice,
  ExplorerOpenIntent,
  ExplorerRow,
  ExplorerSnapshot,
  ExplorerState,
  InlineEditMode,
  InlineEditState,
  ValidationMessage,
} from "./explorer-types";
export {
  EDIT_ROW_KEY,
  type ExplorerFileOps,
  ExplorerViewModel,
  type ExplorerViewModelOptions,
} from "./explorer-view-model";
export { validateEntryName } from "./name-validation";
