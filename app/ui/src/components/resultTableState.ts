import type { TableSort } from "../../../../types.ts";

export const RESULT_TABLE_INDEX_COLUMN_ID = "__rowcall_index__";

export function sortingStateToQuery(
  sorting: ReadonlyArray<{ id: string; desc: boolean }>,
): TableSort | null {
  const selected = sorting[0];
  if (!selected) return null;
  if (selected.id === RESULT_TABLE_INDEX_COLUMN_ID) {
    return { kind: "index", descending: selected.desc };
  }
  const columnIndex = resultTableColumnIndexFromId(selected.id);
  return columnIndex < 0
    ? null
    : { kind: "column", columnIndex, descending: selected.desc };
}

export function resultTableColumnId(index: number): string {
  return "column:" + index;
}

export function resultTableColumnIndexFromId(id: string): number {
  if (!id.startsWith("column:")) return -1;
  const index = Number(id.slice("column:".length));
  return Number.isInteger(index) && index >= 0 ? index : -1;
}
