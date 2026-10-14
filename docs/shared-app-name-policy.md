# Shared app name policy

`src/shared-app-name.ts` defines the operator-selected shared app name policy.
The existing Worker endpoint origin reservation API remains the allocation
authority. This helper owns input canonicalization and exact staging Host
parsing; it does not create a reservation, ledger, gateway or schema writer.

Allocation inputs normalize with NFKC and then lowercase. The normalized value
must contain 3–32 ASCII letters, digits or hyphens, with alphanumeric endpoints,
no adjacent hyphens and no reserved name or `-staging` suffix. Whitespace and
trailing dots are invalid allocation input. The canonical input and origin
rules match the staging adapter on Takosumi Hosted PR #59. Client validation
cannot replace server allocation constraints or authorize a reservation.

`sharedAppStagingNameFromHost` receives a raw Host authority before URL or IDNA
processing. It accepts ASCII case differences and one DNS root dot, requires
exactly one label before `app-staging.takos.jp`, and refuses ports. Reserved,
malformed, production and foreign Host values all return null. The gateway must
return its same non-cacheable 404 for those names and for names that the
authoritative ledger marks absent, released or cooling.

This source is preparatory. The reservation API and private gateway do not yet
select this policy. Integration still requires environment-separated global
name uniqueness, 30-day release cooldown, assignment incarnation and primary
generation checks that fence predecessor scripts and stale caches. The owning
public migration path must preserve durable data; no new schema number or
live target is assigned by this helper.
