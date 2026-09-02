/**
 * Bounds the Host applies before doing work.
 *
 * They live together because several are advertised to callers through support
 * profiles and discovery: a limit a client cannot see is a limit it will hit by
 * surprise.
 */

/** Largest Worker bundle a tenant may commit. Advertised in support profiles. */
export const TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES = 10_485_760;

/** Maximum module entries in one WorkerBundle manifest. */
export const TAKOFORM_MAXIMUM_WORKER_BUNDLE_MODULES = 4_096;

/** Maximum file entries in one StaticAssetBundle or MigrationBundle. */
export const TAKOFORM_MAXIMUM_FILE_BUNDLE_FILES = 16_384;

/** Largest request body the Host will read, before parsing it. */
export const MAXIMUM_REQUEST_BODY_BYTES = 1_048_576;

/** How long a reviewed prepare stays redeemable. */
export const PREPARE_TTL_MILLISECONDS = 5 * 60_000;

/** How long a completed mutation stays replayable under its idempotency key. */
export const REPLAY_TTL_MILLISECONDS = 24 * 60 * 60_000;

/** Rows a single opportunistic sweep may delete, so cleanup stays bounded. */
export const SWEEP_ROW_LIMIT = 64;

/** How long a settled operation remains readable by its id. */
export const OPERATION_TTL_MILLISECONDS = 7 * 24 * 60 * 60_000;

/**
 * How long a deferred *delete* held for provider repair stays authoritative.
 *
 * A held command is repair authority — its provider mutation may have crossed
 * the boundary — so it outlives an ordinary operation by a wide margin, and an
 * apply or an import is held without an end because the native object it may
 * have made is still there. A delete is different: the hold also owns the
 * caller's replay key, so an acceptance that can never settle refuses every
 * later attempt at the same delete for the life of the deployment, which is how
 * a teardown came to be permanently wedged. A month is long enough for an
 * operator to repair one and short enough that a stale acceptance cannot hold a
 * Resource forever. Measured from acceptance, so re-entering the hold cannot
 * push it out.
 */
export const PROVIDER_REPAIR_HOLD_TTL_MILLISECONDS = 30 * 24 * 60 * 60_000;

/** Long enough for one provider call; expired reservations are recoverable. */
export const RESOURCE_CLAIM_RESERVATION_TTL_MILLISECONDS = 5 * 60_000;

/** Long enough for one provider request; ownership remains recoverable after a crash. */
export const PROVIDER_MUTATION_EXECUTION_LEASE_MILLISECONDS = 30_000;
