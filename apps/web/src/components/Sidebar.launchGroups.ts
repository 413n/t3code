import type { SidebarSection } from "./Sidebar.logic";

// A thread renders under the thread it is grouped under: the thread whose
// agent launched it through T3 MCP tools, or one the user grouped it with.
// This is a view over `groupedUnderThreadId`: each thread keeps its own
// section, actions, and drag state.

const SECTION_ORDER = [
  "pinned",
  "active",
  "working",
  "snoozed",
  "settled",
] as const satisfies readonly SidebarSection[];
const LIVE_SECTIONS: ReadonlySet<SidebarSection> = new Set(["pinned", "active", "working"]);

export interface SidebarLaunchRow<T> {
  readonly thread: T;
  readonly key: string;
  /** The thread's own section. It picks the row look and its actions. */
  readonly section: SidebarSection;
  /** The launcher this row renders under; null for top-level rows. */
  readonly rootKey: string | null;
}

/** One top-level row, or a launcher followed by every thread it launched. */
export interface SidebarLaunchBlock<T> {
  /** The top-level thread's key. */
  readonly key: string;
  /** The row whose place in its section orders the block: the launcher, or
      the live thread the group moved to. */
  readonly leadKey: string;
  readonly rows: readonly SidebarLaunchRow<T>[];
}

export type SidebarLaunchLayout<T> = Readonly<
  Record<SidebarSection, readonly SidebarLaunchBlock<T>[]>
>;

/**
 * Groups each section's threads into blocks. A group renders where its
 * launcher renders. When the launcher is snoozed or settled but a launched
 * thread is still live, the group moves to that thread's place, so live work
 * never hides in a shelf. Threads launched by a launched thread join the same
 * group. Launchers outside the given sections leave their threads top-level.
 */
export function layoutSidebarLaunchGroups<T>(input: {
  readonly sections: Readonly<Record<SidebarSection, readonly T[]>>;
  readonly keyOf: (thread: T) => string;
  readonly launcherKeyOf: (thread: T) => string | null;
}): SidebarLaunchLayout<T> {
  const ordered: SidebarLaunchRow<T>[] = [];
  const rowByKey = new Map<string, SidebarLaunchRow<T>>();
  for (const section of SECTION_ORDER) {
    for (const thread of input.sections[section]) {
      const row = { thread, key: input.keyOf(thread), section, rootKey: null };
      ordered.push(row);
      rowByKey.set(row.key, row);
    }
  }

  const rootOf = (key: string): string => {
    const seen = new Set([key]);
    let current = key;
    for (;;) {
      const launcher = input.launcherKeyOf(rowByKey.get(current)!.thread);
      if (launcher === null || !rowByKey.has(launcher)) return current;
      // A cycle has no top, so its threads stay top-level.
      if (seen.has(launcher)) return key;
      seen.add(launcher);
      current = launcher;
    }
  };

  const childrenByRoot = new Map<string, SidebarLaunchRow<T>[]>();
  const grouped = new Set<string>();
  for (const row of ordered) {
    const rootKey = rootOf(row.key);
    if (rootKey === row.key) continue;
    grouped.add(row.key);
    const children = childrenByRoot.get(rootKey) ?? [];
    children.push({ ...row, rootKey });
    childrenByRoot.set(rootKey, children);
  }

  const rootByAnchor = new Map<string, string>();
  for (const [rootKey, children] of childrenByRoot) {
    const anchor = LIVE_SECTIONS.has(rowByKey.get(rootKey)!.section)
      ? rootKey
      : (children.find((child) => LIVE_SECTIONS.has(child.section))?.key ?? rootKey);
    rootByAnchor.set(anchor, rootKey);
  }

  const layout: Record<SidebarSection, SidebarLaunchBlock<T>[]> = {
    pinned: [],
    active: [],
    working: [],
    snoozed: [],
    settled: [],
  };
  for (const row of ordered) {
    const rootKey = rootByAnchor.get(row.key);
    if (rootKey !== undefined) {
      layout[row.section].push({
        key: rootKey,
        leadKey: row.key,
        rows: [rowByKey.get(rootKey)!, ...childrenByRoot.get(rootKey)!],
      });
    } else if (!grouped.has(row.key) && !childrenByRoot.has(row.key)) {
      layout[row.section].push({ key: row.key, leadKey: row.key, rows: [row] });
    }
  }
  return layout;
}

/** What a collapsed shelf shows: only the open thread's row, on its own. */
export function routeRowOnly<T>(
  blocks: readonly SidebarLaunchBlock<T>[],
  routeKey: string | null,
): SidebarLaunchBlock<T>[] {
  if (routeKey === null) return [];
  for (const block of blocks) {
    const row = block.rows.find((candidate) => candidate.key === routeKey);
    if (row !== undefined) {
      return [{ key: row.key, leadKey: row.key, rows: [{ ...row, rootKey: null }] }];
    }
  }
  return [];
}
