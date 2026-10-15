import type { ObjectStoreAccess } from "./ports.ts";
import { createSelfhostPublicHttpsArtifactFetch } from "./selfhost-public-https-artifact-fetch.ts";
import type { V2ArtifactSource, V2HeldArtifactEntry } from "./takoform-v2/forms/artifact-source.ts";
import { createV2HeldOrPublicArtifactSource } from "./takoform-v2/forms/public-https-artifact-source.ts";

/** Bun-only composition; the portable Form and app never import this transport. */
export function createSelfhostPublicArtifactSource(context: {
  readonly objects: ObjectStoreAccess;
  readonly heldArtifacts: readonly V2HeldArtifactEntry[];
}): V2ArtifactSource {
  return createV2HeldOrPublicArtifactSource({
    objects: context.objects,
    entries: context.heldArtifacts,
    fetchPublic: createSelfhostPublicHttpsArtifactFetch(),
  });
}
