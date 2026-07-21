import type { WorkspaceFile } from "../data/forge-mobile-api";

export type FileTreeRow = {
  entry: WorkspaceFile;
  depth: number;
  expanded: boolean;
  loading: boolean;
};

export function sortWorkspaceEntries(entries: WorkspaceFile[]): WorkspaceFile[] {
  return [...entries].sort((a, b) => {
    const dirA = a.kind === "directory" ? 0 : 1;
    const dirB = b.kind === "directory" ? 0 : 1;
    if (dirA !== dirB) return dirA - dirB;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Flatten a lazy-loaded directory tree into rows for FlatList. */
export function flattenFileTree(params: {
  rootEntries: WorkspaceFile[];
  childrenByPath: Record<string, WorkspaceFile[]>;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
}): FileTreeRow[] {
  const rows: FileTreeRow[] = [];

  const walk = (entries: WorkspaceFile[], depth: number) => {
    for (const entry of sortWorkspaceEntries(entries)) {
      const expanded = params.expandedPaths.has(entry.path);
      rows.push({
        entry,
        depth,
        expanded,
        loading: params.loadingPaths.has(entry.path),
      });
      if (entry.kind === "directory" && expanded) {
        const children = params.childrenByPath[entry.path];
        if (children) walk(children, depth + 1);
      }
    }
  };

  walk(params.rootEntries, 0);
  return rows;
}

/** Filter flattened rows by name/path query (case-insensitive). */
export function filterFileTreeRows(rows: FileTreeRow[], query: string): FileTreeRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.entry.name.toLowerCase().includes(needle)
      || row.entry.path.toLowerCase().includes(needle),
  );
}
