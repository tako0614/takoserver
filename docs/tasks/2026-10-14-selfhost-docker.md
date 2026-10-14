# Docker self-host packaging

- Repository: takoserver only; branch `fix/selfhost-docker-20261014`.
- Scope: add a Docker build and Compose target for the documented Bun artifact/control API profile, instructions, and a repeatable local Docker smoke check.
- Trigger: changes distribution/startup packaging. No production publication or existing installation migration is part of this task.
- Baseline: commit `a4273e63` has no Dockerfile or Compose target; `docker build .` fails before building.
- Authority: preserve the existing operator identity, configuration, SQLite migration, and Form support contracts. Keep credentials and Host data outside the build context, use fresh local data only for verification, and publish the backend port on host loopback.
- Sequence: inspect canonical self-host docs; add packaging; build and boot with fresh state; exercise health, discovery, operator sign-in, organization/API-key creation, authenticated v2 reads, and restart persistence; run `bun run check`; open a PR. Do not merge.
- Exclusions: production, D1, other worktrees, existing containers/images, and the complete workerd Worker execution profile.
- Evidence: results and timing are recorded in the operator run's `STATUS-docker.md`; the PR records final validation.
- Docker verification: real Docker-run and Compose Hosts pass health, discovery, operator/organization/API-key onboarding, Form support, authenticated reads, non-root and read-only source checks, private volume permissions, and restart persistence. Runtime version is checked against `.bun-version`. Test resources are stopped and retained, with no pruning or existing-resource deletion.
- Repository gate must use pinned Bun 1.4.0; host Bun 1.4.2 changes generated workflow bootstrap bytes. The full pinned gate is running before handoff.
