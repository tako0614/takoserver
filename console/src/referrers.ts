import type { ResourceSummary } from "./api.ts";
import { specReferences } from "./references.ts";
import { api } from "./state.ts";

/** How many list pages are read to find what names a Resource. */
export const REFERRER_PAGES = 5;

export interface Referrer {
  readonly resource: ResourceSummary;
  /** Where its spec names the Resource being shown. */
  readonly paths: readonly string[];
}

/**
 * The Resources whose specs name `uid`, from the organization's list. Only
 * the first pages are read, so `complete` says whether the answer covers
 * every Resource and `checked` how many it looked at.
 */
export async function findReferrers(
  organizationId: string,
  uid: string,
): Promise<{
  readonly referrers: readonly Referrer[];
  readonly complete: boolean;
  readonly checked: number;
}> {
  const referrers: Referrer[] = [];
  let cursor: string | null = null;
  let checked = 0;
  for (let page = 0; page < REFERRER_PAGES; page += 1) {
    const read = await api.resources(organizationId, cursor ? { cursor } : {});
    checked += read.resources.length;
    for (const resource of read.resources) {
      const paths = specReferences(resource.spec)
        .filter((reference) => reference.uid === uid)
        .map((reference) => reference.path);
      if (paths.length > 0 && resource.uid !== uid) referrers.push({ resource, paths });
    }
    cursor = read.cursor;
    if (cursor === null) return { referrers, complete: true, checked };
  }
  return { referrers, complete: false, checked };
}
