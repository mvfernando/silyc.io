import { describe, it, expect } from "vitest";
import { sortUsers, paginate, applySortChange } from "@/lib/admin-users-sort";

const mk = (id: string, created: string, last: string | null = null) => ({
  id,
  created_at: created,
  last_sign_in_at: last,
});

const users = [
  mk("a", "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z"),
  mk("b", "2026-03-01T00:00:00Z", null),
  mk("c", "2026-02-01T00:00:00Z", "2026-06-10T00:00:00Z"),
  mk("d", "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z"),
];

describe("sortUsers", () => {
  it("sorts by created_at desc (newest first)", () => {
    expect(sortUsers(users, "created_at", "desc").map((u) => u.id)).toEqual(["d", "b", "c", "a"]);
  });
  it("sorts by created_at asc (oldest first)", () => {
    expect(sortUsers(users, "created_at", "asc").map((u) => u.id)).toEqual(["a", "c", "b", "d"]);
  });
  it("treats null last_sign_in_at as epoch 0", () => {
    const desc = sortUsers(users, "last_sign_in_at", "desc");
    expect(desc[0].id).toBe("c");
    expect(desc[desc.length - 1].id).toBe("b");
  });
  it("does not mutate the source array", () => {
    const snapshot = users.map((u) => u.id);
    sortUsers(users, "created_at", "asc");
    expect(users.map((u) => u.id)).toEqual(snapshot);
  });
});

describe("paginate", () => {
  it("clamps page above the total", () => {
    const big = Array.from({ length: 7 }, (_, i) => ({ id: String(i) }));
    const r = paginate(big, 99, 3);
    expect(r.totalPages).toBe(3);
    expect(r.safePage).toBe(2);
    expect(r.rows.map((x) => x.id)).toEqual(["6"]);
  });
  it("returns single page when list fits in pageSize", () => {
    const r = paginate(users, 0, 25);
    expect(r.totalPages).toBe(1);
    expect(r.rows).toHaveLength(4);
  });
  it("returns at least 1 total page for empty lists", () => {
    const r = paginate([], 0, 25);
    expect(r.totalPages).toBe(1);
    expect(r.rows).toEqual([]);
  });
});

describe("applySortChange (page reset rule)", () => {
  const initial = { sortKey: "created_at" as const, sortDir: "desc" as const, page: 3 };

  it("resets page when sort direction toggles desc -> asc", () => {
    expect(applySortChange(initial, { sortDir: "asc" })).toEqual({
      sortKey: "created_at",
      sortDir: "asc",
      page: 0,
    });
  });

  it("resets page when sort key changes", () => {
    expect(applySortChange(initial, { sortKey: "last_sign_in_at" })).toEqual({
      sortKey: "last_sign_in_at",
      sortDir: "desc",
      page: 0,
    });
  });

  it("keeps page when nothing actually changes", () => {
    expect(applySortChange(initial, { sortDir: "desc" })).toEqual(initial);
    expect(applySortChange(initial, { sortKey: "created_at" })).toEqual(initial);
  });

  it("resets page on combined key+dir change", () => {
    expect(
      applySortChange(initial, { sortKey: "last_sign_in_at", sortDir: "asc" }),
    ).toEqual({ sortKey: "last_sign_in_at", sortDir: "asc", page: 0 });
  });
});