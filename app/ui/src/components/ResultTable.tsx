import { useQuery } from "@tanstack/react-query";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  type PaginationState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import type {
  ResultStoreIdentity,
  TableCellPreview,
  TablePreview,
} from "../../../../types.ts";
import { queryResultTable } from "../api/execution.ts";
import {
  RESULT_TABLE_INDEX_COLUMN_ID,
  resultTableColumnId,
  resultTableColumnIndexFromId,
  sortingStateToQuery,
} from "./resultTableState.ts";

const PAGE_SIZE = 50;
const tableStateByOutput = new Map<string, ResultTableState>();

type ResultTableState = {
  pageIndex: number;
  sorting: SortingState;
};

type ResultTableRow = {
  index: TableCellPreview | undefined;
  values: TableCellPreview[];
};

export function ResultTable({
  identity,
  nodeId,
  outputName,
  initialTable,
}: {
  identity: ResultStoreIdentity;
  nodeId: string;
  outputName: string;
  initialTable: TablePreview;
}) {
  const stateKey = nodeId + "\u0000" + outputName;
  const [tableState, setTableState] = useState<ResultTableState>(() =>
    tableStateByOutput.get(stateKey) ?? { pageIndex: 0, sorting: [] }
  );
  const pagination: PaginationState = {
    pageIndex: tableState.pageIndex,
    pageSize: PAGE_SIZE,
  };
  const sort = sortingStateToQuery(tableState.sorting);
  const query = useQuery({
    queryKey: [
      "result-table",
      identity.runId,
      identity.documentRevision,
      nodeId,
      outputName,
      pagination.pageIndex,
      sort,
    ],
    queryFn: ({ signal }) =>
      queryResultTable({
        ...identity,
        nodeId,
        outputName,
        offset: pagination.pageIndex * PAGE_SIZE,
        sort,
      }, signal),
    placeholderData: tableState.pageIndex === 0 && sort === null
      ? {
        ok: true as const,
        ...identity,
        nodeId,
        outputName,
        offset: 0,
        sort: null,
        table: initialTable,
      }
      : undefined,
  });
  const tablePreview = query.data?.table ?? {
    ...initialTable,
    rows: [],
    index: initialTable.index ? [] : undefined,
  };

  function updateTableState(next: ResultTableState) {
    tableStateByOutput.set(stateKey, next);
    setTableState(next);
  }

  useEffect(() => {
    const restored = tableStateByOutput.get(stateKey) ?? {
      pageIndex: 0,
      sorting: [],
    };
    setTableState(restored);
  }, [stateKey]);

  useEffect(() => {
    setTableState((current) => {
      const selected = current.sorting[0];
      if (
        !selected || selected.id === RESULT_TABLE_INDEX_COLUMN_ID ||
        resultTableColumnIndexFromId(selected.id) < initialTable.columns.length
      ) {
        return current;
      }
      const next = { pageIndex: 0, sorting: [] };
      tableStateByOutput.set(stateKey, next);
      return next;
    });
  }, [initialTable.columns.length, stateKey]);

  useEffect(() => {
    if (!query.data) return;
    const resolvedPage = Math.floor(query.data.offset / PAGE_SIZE);
    setTableState((current) => {
      if (resolvedPage === current.pageIndex) return current;
      const next = { ...current, pageIndex: resolvedPage };
      tableStateByOutput.set(stateKey, next);
      return next;
    });
  }, [query.data, stateKey]);

  const rows = useMemo<ResultTableRow[]>(
    () =>
      tablePreview.rows.map((values, index) => ({
        index: tablePreview.index?.[index],
        values,
      })),
    [tablePreview],
  );
  const columns = useMemo<ColumnDef<ResultTableRow>[]>(() => {
    const result: ColumnDef<ResultTableRow>[] = [];
    if (tablePreview.index) {
      result.push({
        id: RESULT_TABLE_INDEX_COLUMN_ID,
        accessorFn: (row) => row.index,
        header: tablePreview.indexLabel ?? "index",
        sortDescFirst: false,
      });
    }
    tablePreview.columns.forEach((column, columnIndex) => {
      result.push({
        id: resultTableColumnId(columnIndex),
        accessorFn: (row) => row.values[columnIndex],
        header: column.name,
        meta: { dtype: column.dtype },
        sortDescFirst: false,
      });
    });
    return result;
  }, [tablePreview.columns, tablePreview.index, tablePreview.indexLabel]);
  const table = useReactTable({
    columns,
    data: rows,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: tablePreview.rowCount,
    enableMultiSort: false,
    enableSortingRemoval: true,
    state: { pagination, sorting: tableState.sorting },
    onPaginationChange: (updater) => {
      const next = typeof updater === "function"
        ? updater(pagination)
        : updater;
      updateTableState({ ...tableState, pageIndex: next.pageIndex });
    },
    onSortingChange: (updater) => {
      const next = typeof updater === "function"
        ? updater(tableState.sorting)
        : updater;
      updateTableState({ pageIndex: 0, sorting: next.slice(0, 1) });
    },
  });
  const firstRow = tablePreview.rowCount === 0
    ? 0
    : pagination.pageIndex * PAGE_SIZE + 1;
  const lastRow = Math.min(
    pagination.pageIndex * PAGE_SIZE + tablePreview.rows.length,
    tablePreview.rowCount,
  );

  return (
    <div className="mt-2 overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
      <div className="max-h-[32rem] overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header, columnPosition) => {
                  const sorted = header.column.getIsSorted();
                  const isIndex =
                    header.column.id === RESULT_TABLE_INDEX_COLUMN_ID;
                  const dtype = (
                    header.column.columnDef.meta as
                      | { dtype?: string }
                      | undefined
                  )?.dtype;
                  return (
                    <th
                      key={header.id}
                      className={[
                        "whitespace-nowrap border-b border-r border-zinc-200 bg-zinc-100 last:border-r-0 dark:border-zinc-700 dark:bg-zinc-800",
                        isIndex ? "sticky left-0 z-20" : "",
                      ].join(" ")}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left font-medium hover:text-zinc-950 dark:hover:text-zinc-100"
                        onClick={header.column.getToggleSortingHandler()}
                        title={"Sort by " +
                          String(header.column.columnDef.header)}
                      >
                        <span className="max-w-44 truncate">
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                        </span>
                        <span aria-hidden="true" className="text-[10px]">
                          {sorted === "asc"
                            ? "↑"
                            : sorted === "desc"
                            ? "↓"
                            : "↕"}
                        </span>
                      </button>
                      {dtype && columnPosition > 0 && (
                        <div className="max-w-44 truncate px-2 pb-1 font-mono text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
                          {String(dtype)}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, rowIndex) => (
              <tr
                key={row.id}
                className="odd:bg-white even:bg-zinc-50 dark:odd:bg-zinc-900 dark:even:bg-zinc-800/70"
              >
                {row.getVisibleCells().map((cell) => {
                  const isIndex =
                    cell.column.id === RESULT_TABLE_INDEX_COLUMN_ID;
                  return (
                    <td
                      key={cell.id}
                      className={[
                        "whitespace-nowrap border-b border-r border-zinc-100 px-2 py-1.5 last:border-r-0 dark:border-zinc-800",
                        isIndex
                          ? "sticky left-0 z-[1] font-mono text-zinc-500 dark:text-zinc-400"
                          : "",
                        isIndex && rowIndex % 2 === 0
                          ? "bg-white dark:bg-zinc-900"
                          : "",
                        isIndex && rowIndex % 2 !== 0
                          ? "bg-zinc-50 dark:bg-zinc-800"
                          : "",
                      ].join(" ")}
                    >
                      <TableCell
                        value={cell.getValue() as TableCellPreview}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
        <span>
          {tablePreview.rowCount === 0
            ? "No rows"
            : firstRow.toLocaleString() + "–" + lastRow.toLocaleString() +
              " of " + tablePreview.rowCount.toLocaleString()}
        </span>
        <div className="flex items-center gap-2">
          {query.isFetching && <span>Loading…</span>}
          <button
            type="button"
            className="rounded border border-zinc-300 bg-white px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900"
            disabled={!table.getCanPreviousPage() || query.isFetching}
            onClick={() => table.previousPage()}
          >
            Previous
          </button>
          <span>
            Page {(pagination.pageIndex + 1).toLocaleString()} of{" "}
            {Math.max(1, table.getPageCount()).toLocaleString()}
          </span>
          <button
            type="button"
            className="rounded border border-zinc-300 bg-white px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900"
            disabled={!table.getCanNextPage() || query.isFetching}
            onClick={() => table.nextPage()}
          >
            Next
          </button>
        </div>
      </div>
      {query.isError && (
        <p className="border-t border-red-200 bg-red-50 px-2 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {query.error instanceof Error
            ? query.error.message
            : "The interactive table could not be loaded."}
        </p>
      )}
    </div>
  );
}

function TableCell({ value }: { value: TableCellPreview }) {
  if (value === null) {
    return (
      <span className="font-mono text-zinc-400 dark:text-zinc-500">null</span>
    );
  }
  if (typeof value === "boolean") {
    return <span className="font-mono">{value ? "true" : "false"}</span>;
  }
  if (typeof value === "number") {
    return <span className="font-mono">{String(value)}</span>;
  }
  if (typeof value === "string") {
    return <span title={value}>{value}</span>;
  }
  if (value.kind === "nan") {
    return (
      <span className="font-mono text-zinc-400 dark:text-zinc-500">NaN</span>
    );
  }
  return <span className="font-mono" title={value.value}>{value.value}</span>;
}
