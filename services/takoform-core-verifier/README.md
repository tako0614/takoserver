# Takoform Core verifier

This is the native, route-less verification adapter owned by Takoserver. It
pins `github.com/tako0614/takoform` v1.1.0 (Core commit
`e0e48b864de2a127a255cb0574d37bbb0f1cac29`) and does not implement a second
trust profile.

`POST /v1/verify-set` accepts one bounded raw package set: canonical package
indexes and payload bytes, one Sigstore bundle per package, publisher policy,
trusted root, signed revocation checkpoint and its separate bundle, the exact
expected source commit, and the durable predecessor checkpoint pin. It rejects
duplicate packages/paths before Core, uses `formpackage.VerifyFS`, verifies
every package bundle, requires source/workflow/build commits to equal the
expected source commit, verifies the checkpoint extension, and checks every
package for revocation. There is no partial success response.

`GET /v1/identity` returns the adapter protocol, Core tag, Core commit, and the
artifact digest injected into both the Docker build and route-less Worker
binding. The Worker compares all four fields on every successful verification.
The container runs as uid 65532 from `scratch`, has a private writable `/tmp`
for Core staging, and has outbound internet disabled by its Container class.

These HTTP paths are reachable only through the Worker’s Container Durable
Object binding. They are not public Takoserver routes and issue no Host
admission capability. Namespace grants, repository/owner identities, durable
mutation, and the private admission handle remain in Takoserver Host code.
