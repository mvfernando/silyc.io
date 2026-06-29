export type UserSortKey = "created_at" | "last_sign_in_at";
export type SortDir = "asc" | "desc";

export type SortableUser = {
  id: string;
  created_at: string;
  last_sign_in_at: string | null;
};

export function sortUsers<T extends SortableUser>(
  list: T[],
  key: UserSortKey,
  dir: SortDir,
): T[] {
  return [...list].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const at = av ? new Date(av).getTime() : 0;
    const bt = bv ? new Date(bv).getTime() : 0;
    return dir === "desc" ? bt - at : at - bt;
  });
}

export function paginate<T>(list: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const rows = list.slice(safePage * pageSize, safePage * pageSize + pageSize);
  return { rows, totalPages, safePage };
}

export function applySortChange(
  prev: { sortKey: UserSortKey; sortDir: SortDir; page: number },
  next: Partial<{ sortKey: UserSortKey; sortDir: SortDir }>,
) {
  const sortKey = next.sortKey ?? prev.sortKey;
  const sortDir = next.sortDir ?? prev.sortDir;
  const changed = sortKey !== prev.sortKey || sortDir !== prev.sortDir;
  return { sortKey, sortDir, page: changed ? 0 : prev.page };
}