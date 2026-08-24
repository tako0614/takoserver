# Frozen Takoform v1 test input

This directory is a test-only, content-addressed snapshot of the unpublished
Takoform v1 candidate at commit
`be686d1bb69e7e65c066fa6310e7f4a46f526420`.

`worker-stable-local-composition.ts` reopens the exact family index, candidate
sets, package indexes, package files, Interface candidate set, Binding
candidate set, and suite manifest. It verifies every recorded size and digest
before the disposable local Host installs anything.

The snapshot does not publish a Takoform package, populate Takoserver's
production catalog, or provide production runtime evidence. Update it only
from a separately reviewed Takoform candidate and update the pinned digests in
the loader in the same change.
