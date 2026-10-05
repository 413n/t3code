import { describe, expect, it } from "vite-plus/test";

import { layoutSidebarLaunchGroups } from "./Sidebar.launchGroups";
import type { SidebarSection } from "./Sidebar.logic";

interface TestThread {
  readonly id: string;
  readonly launchedBy?: string;
}

function layout(sections: Partial<Record<SidebarSection, readonly TestThread[]>>) {
  const result = layoutSidebarLaunchGroups({
    sections: { pinned: [], active: [], working: [], snoozed: [], settled: [], ...sections },
    keyOf: (thread) => thread.id,
    launcherKeyOf: (thread) => thread.launchedBy ?? null,
  });
  // Compact form: one string per block, "root>child(section)", with the
  // block's lead row marked by "*".
  const describeSection = (section: SidebarSection) =>
    result[section].map((block) =>
      block.rows
        .map((row) => {
          const label = row.rootKey === null ? row.key : `${row.key}(${row.section})`;
          return block.rows.length > 1 && row.key === block.leadKey ? `${label}*` : label;
        })
        .join(">"),
    );
  return {
    pinned: describeSection("pinned"),
    active: describeSection("active"),
    settled: describeSection("settled"),
  };
}

describe("layoutSidebarLaunchGroups", () => {
  it("nests launched threads, and threads they launched, under the first launcher", () => {
    expect(
      layout({
        pinned: [{ id: "lead" }],
        active: [{ id: "a", launchedBy: "lead" }, { id: "solo" }, { id: "b", launchedBy: "a" }],
        settled: [{ id: "c", launchedBy: "lead" }],
      }),
    ).toEqual({
      pinned: ["lead*>a(active)>b(active)>c(settled)"],
      active: ["solo"],
      settled: [],
    });
  });

  it("moves a settled launcher's group to its first live thread", () => {
    expect(
      layout({
        active: [{ id: "solo" }, { id: "a", launchedBy: "lead" }],
        settled: [{ id: "lead" }, { id: "b", launchedBy: "lead" }],
      }),
    ).toEqual({
      pinned: [],
      active: ["solo", "lead>a(active)*>b(settled)"],
      settled: [],
    });
  });

  it("keeps threads top-level when their launcher is not listed or the chain loops", () => {
    expect(
      layout({
        active: [
          { id: "orphan", launchedBy: "archived" },
          { id: "x", launchedBy: "y" },
          { id: "y", launchedBy: "x" },
        ],
      }),
    ).toEqual({ pinned: [], active: ["orphan", "x", "y"], settled: [] });
  });
});
