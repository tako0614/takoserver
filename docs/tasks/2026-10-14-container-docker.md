# Container Docker candidate

- Repository: takoserver only, branch `feat/container-docker-selfhost-20261014`, base `82917e20`.
- Authority: implement operator-run `container-parallel-20261014/LANE-A-DOCKER.md` and FINAL `CONTRACT.md`; normal push and draft PR are authorized. No merge, deployment, production, D1, other worktree mutation, or WfP changes.
- Triggers: private invocation authorization and Docker execution/network packaging. New Container and Worker successor URLs remain candidates; do not alter frozen definitions or claim public support before real conformance.
- Sequence: add closed contract validation tests; implement the single public mapping, candidate v2 adapters and scoped streaming broker; strengthen immutable image verification and generation isolation; wire Docker/Linux installation; run focused tests, local Docker acceptance, explicit formatting and the complete pinned repository gate; commit, push, open draft PR, write operator-run result.
- Boundaries: Host owns daemon, private network, capacity, image and generation. No customer credentials, Docker socket in tenant env, secrets injection, Internet egress or native process controls. Retain unknown effects for reconciliation and protect referenced UIDs from deletion.
- Reversal: these are source changes only. Existing installations and their state are not migrated by this task. Local acceptance creates uniquely named resources and cleans up only its recorded owned objects.
- Evidence: `LANE-A-RESULT.md` records the commit, PR, tests, actual backend evidence and remaining qualification gaps.
