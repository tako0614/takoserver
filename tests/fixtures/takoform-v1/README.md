# Frozen Takoform v1 test input

This directory is a test-only, content-addressed snapshot of the unpublished
Takoform v1 candidate integrated on `main` at commit
`c08651d9b39d1be34e4b803c3d32fdca82e3653e`.

`worker-stable-local-composition.ts` reopens the exact family index, candidate
sets, package indexes, package files, Interface candidate set, Binding
candidate set, and suite manifest. It verifies every recorded size and digest
before the disposable local Host installs anything.

The snapshot does not publish a Takoform package, populate Takoserver's
production catalog, or provide production runtime evidence. Update it only
from a separately reviewed Takoform candidate and update the pinned digests in
the loader in the same change.
