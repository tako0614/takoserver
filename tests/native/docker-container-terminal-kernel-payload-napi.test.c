/* SPDX-License-Identifier: GPL-2.0-only */
/* Raw malloc/cache-call boundary model, not kernel/native/terminal evidence.
 * The exact whole modified functions and unchanged private helper are tested.
 * Cache return only ends this selected interval; retained raw cache objects
 * below remain allocated after their original reservations have been put.
 * Reproduce from the repository root without an operator-private source copy:
 *
 * tako_napi_include="$(mktemp)"
 * export TAKO_NAPI_TEST_INCLUDE="$tako_napi_include"
 * python3 - <<'PY'
 * import os
 * from pathlib import Path
 * lines = Path("scripts/native/docker-container-terminal-kernel-payload-napi-v6.12.patch").read_text().splitlines(True)
 * text = "".join(x[1:] for x in lines if x[:1] in (" ", "+") and not x.startswith("+++"))
 * start = text.index("void __napi_kfree_skb(")
 * end = text.index("\nEXPORT_SYMBOL(napi_consume_skb);", start)
 * Path(os.environ["TAKO_NAPI_TEST_INCLUDE"]).write_text(text[start:end] + "\n")
 * PY
 * cc -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined \
 *   -DCONFIG_TAKO_TERMINAL=1 \
 *   "-DTAKO_NAPI_ACTUAL_FUNCTIONS=\"$tako_napi_include\"" \
 *   tests/native/docker-container-terminal-kernel-payload-napi.test.c \
 *   -o "$tako_napi_include.test"
 * "$tako_napi_include.test"
 */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef TAKO_NAPI_ACTUAL_FUNCTIONS
#error "Extract the companion patch whole NAPI postimages and select their include"
#endif
#ifndef CONFIG_TAKO_TERMINAL
#error "This dedicated new reference-order regression tests the enabled path"
#endif

#define CHECK(e) do { assert(e); checks++; } while (0)
#define unlikely(e) (e)
#define DEBUG_NET_WARN_ON_ONCE(e) CHECK(!(e))
#define SKB_FCLONE_UNAVAILABLE 0

static unsigned int checks, event, clone_calls, put_calls, groups_freed;
static unsigned int release_calls, cache_calls, nf_calls, dst_calls, orphan_calls;
static unsigned int trace_calls, unref_calls, budget_calls, fclone_calls;
static unsigned int retained_cache_count, retain_cache;
static int fail_clone;

struct tako_terminal_owner {
	unsigned int refs;
	unsigned int pending_boundaries;
	unsigned int poisoned;
	unsigned int poison_event;
	unsigned int last_put;
	unsigned int cache_return;
};

static struct tako_terminal_owner *tako_terminal_packet_clone(
	struct tako_terminal_owner *held)
{
	CHECK(held && held->refs);
	clone_calls++;
	++event;
	if (fail_clone)
		return NULL;
	held->refs++;
	return held;
}

static void tako_terminal_packet_put(struct tako_terminal_owner *held)
{
	CHECK(held && held->refs);
	put_calls++;
	held->last_put = ++event;
	if (!--held->refs && !held->poisoned)
		CHECK(!held->pending_boundaries);
}

static void tako_terminal_packet_poison(struct tako_terminal_owner *held)
{
	CHECK(held && held->refs);
	held->poisoned = 1;
	held->poison_event = ++event;
}

#include "../../scripts/native/docker-container-terminal-kernel-skb-state.h"

struct raw_extension {
	unsigned int headers;
	struct tako_terminal_skb_refs refs;
};

struct raw_payload {
	unsigned int headers;
	unsigned char *bytes;
};

struct sk_buff {
	struct raw_extension *extension;
	struct raw_payload *payload;
	struct tako_terminal_owner *probes[TAKO_TERMINAL_SKB_OWNERS];
	struct sk_buff *cache_child;
	unsigned int users, fclone, slow_gro, stolen, released;
};

enum skb_drop_reason { SKB_CONSUMED, RAW_SELECTED_DROP };
static enum skb_drop_reason last_reason;
static struct sk_buff *retained_cache[64];
void __napi_kfree_skb(struct sk_buff *skb, enum skb_drop_reason reason);
void napi_skb_free_stolen_head(struct sk_buff *skb);
void napi_consume_skb(struct sk_buff *skb, int budget);

static void guard(const struct sk_buff *skb)
{
	for (unsigned int i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++)
		CHECK(!skb->probes[i] || skb->probes[i]->refs || skb->probes[i]->poisoned);
}

/* These raw storage operations stand in for existing kernel boundaries.
 * Only the shared helper and actual extracted caller bodies are compiled.
 */
static void tako_skb_snapshot(const struct sk_buff *skb,
			      struct tako_terminal_skb_refs *held)
{
	if (skb->extension) {
		CHECK(skb->extension->headers);
		tako_terminal_skb_refs_clone(held, &skb->extension->refs);
	}
}

static void skb_ext_put_final(struct sk_buff *skb)
{
	struct raw_extension *extension = skb->extension;

	skb->extension = NULL;
	if (extension && !--extension->headers) {
		struct tako_terminal_skb_refs held = extension->refs;

		free(extension);
		groups_freed++;
		++event;
		tako_terminal_skb_refs_put(&held);
	}
}

static void release_payload(struct sk_buff *skb)
{
	struct raw_payload *payload = skb->payload;

	skb->payload = NULL;
	if (payload && !--payload->headers) {
		free(payload->bytes);
		free(payload);
	}
}

static void skb_release_all(struct sk_buff *skb, enum skb_drop_reason reason)
{
	CHECK(!skb->stolen && skb->payload);
	CHECK(reason == SKB_CONSUMED || reason == RAW_SELECTED_DROP);
	last_reason = reason;
	release_calls++;
	skb_ext_put_final(skb);
	/* Metadata puts may precede data and cache-shell processing. */
	guard(skb);
	release_payload(skb);
	skb->released = 1;
	++event;
}

static void nf_reset_ct(struct sk_buff *skb) { nf_calls++; guard(skb); }
static void skb_dst_drop(struct sk_buff *skb) { dst_calls++; guard(skb); }
static void skb_orphan(struct sk_buff *skb) { orphan_calls++; guard(skb); }
static int in_softirq(void) { return 1; }

static int skb_unref(struct sk_buff *skb)
{
	CHECK(skb->users);
	unref_calls++;
	return !--skb->users;
}

static void trace_consume_skb(struct sk_buff *skb, void *caller)
{
	(void)caller;
	trace_calls++;
	guard(skb);
}

/* Out-of-scope original delegation is not replaced by a ready result. These
 * raw unowned guard samples only prove that no new NAPI bookend is entered.
 */
static void delegated_unowned_free(struct sk_buff *skb)
{
	CHECK(!skb->extension);
	for (unsigned int i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++)
		CHECK(!skb->probes[i]);
	release_payload(skb);
	free(skb);
}

static void dev_consume_skb_any(struct sk_buff *skb)
{
	budget_calls++;
	delegated_unowned_free(skb);
}

static void __kfree_skb(struct sk_buff *skb)
{
	fclone_calls++;
	delegated_unowned_free(skb);
}

static void napi_skb_cache_put(struct sk_buff *skb)
{
	struct tako_terminal_owner *probes[TAKO_TERMINAL_SKB_OWNERS];
	struct sk_buff *child = skb->cache_child;

	cache_calls++;
	CHECK(skb->released || skb->stolen);
	if (skb->stolen)
		CHECK(!skb->slow_gro && !skb->extension);
	guard(skb);
	memcpy(probes, skb->probes, sizeof(probes));
	if (child) {
		skb->cache_child = NULL;
		__napi_kfree_skb(child, RAW_SELECTED_DROP);
		guard(skb);
	}
	if (retain_cache) {
		CHECK(retained_cache_count < sizeof(retained_cache) / sizeof(retained_cache[0]));
		retained_cache[retained_cache_count++] = skb;
		memset(skb, 0xa5, sizeof(*skb));
	} else {
		free(skb);
	}
	/* No skb memory is read after the raw recycle/free boundary. This event
	 * denotes only this cache-call return, not final allocator retirement.
	 */
	++event;
	for (unsigned int i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++) {
		struct tako_terminal_owner *probe = probes[i];

		if (probe) {
			CHECK(probe->pending_boundaries);
			CHECK(probe->refs || probe->poisoned);
			probe->pending_boundaries--;
			probe->cache_return = event;
		}
	}
}

#include TAKO_NAPI_ACTUAL_FUNCTIONS

static void attach_owner(struct sk_buff *skb, struct tako_terminal_owner *owner)
{
	unsigned int slot = TAKO_TERMINAL_SKB_OWNERS;

	for (unsigned int i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++)
		if (!skb->probes[i]) { slot = i; break; }
	CHECK(slot < TAKO_TERMINAL_SKB_OWNERS);
	if (!skb->extension) {
		skb->extension = calloc(1, sizeof(*skb->extension));
		CHECK(skb->extension != NULL);
		skb->extension->headers = 1;
	}
	skb->probes[slot] = owner;
	owner->refs++;
	owner->pending_boundaries++;
	tako_terminal_skb_refs_take(&skb->extension->refs, owner);
	skb->slow_gro = 1;
}

static struct sk_buff *new_raw_skb(struct tako_terminal_owner *owner, int stolen)
{
	struct sk_buff *skb = calloc(1, sizeof(*skb));

	CHECK(skb != NULL);
	skb->users = 1;
	skb->stolen = (unsigned int)stolen;
	if (!stolen) {
		skb->payload = calloc(1, sizeof(*skb->payload));
		CHECK(skb->payload != NULL);
		skb->payload->headers = 1;
		skb->payload->bytes = malloc(32);
		CHECK(skb->payload->bytes != NULL);
	}
	if (owner)
		attach_owner(skb, owner);
	return skb;
}

static struct sk_buff *share_raw_skb(struct sk_buff *source)
{
	struct sk_buff *copy = malloc(sizeof(*copy));

	CHECK(copy != NULL);
	*copy = *source;
	copy->cache_child = NULL;
	if (copy->extension)
		copy->extension->headers++;
	if (copy->payload)
		copy->payload->headers++;
	for (unsigned int i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++)
		if (copy->probes[i])
			copy->probes[i]->pending_boundaries++;
	return copy;
}

static void invoke(unsigned int kind, struct sk_buff *skb)
{
	if (kind == 0)
		__napi_kfree_skb(skb, RAW_SELECTED_DROP);
	else if (kind == 1)
		napi_consume_skb(skb, 1);
	else
		napi_skb_free_stolen_head(skb);
}

static void release_raw_cache(void)
{
	while (retained_cache_count)
		free(retained_cache[--retained_cache_count]);
}

int main(void)
{
	struct tako_terminal_owner a, b;
	struct sk_buff *skb, *shared;
	unsigned int clones, puts, caches, releases, nf, dst, orphan, delegated;

	for (unsigned int mode = 0; mode < 2; mode++) {
		retain_cache = mode;
		for (unsigned int kind = 0; kind < 3; kind++) {
			/* All selected whole function bodies retain through the raw
			 * cache's last shell access and return, including real free.
			 */
			a = (struct tako_terminal_owner){0};
			skb = new_raw_skb(&a, kind == 2);
			clones = clone_calls;
			invoke(kind, skb);
			CHECK(!a.refs && !a.pending_boundaries && !a.poisoned);
			CHECK(a.cache_return < a.last_put);
			CHECK(clone_calls == clones + 1);
			if (kind < 2)
				CHECK(last_reason == (kind == 0 ? RAW_SELECTED_DROP : SKB_CONSUMED));
			if (mode)
				CHECK(retained_cache_count != 0);
			release_raw_cache();

			/* Unowned normal/slow-GRO-false packets gain no new owner. */
			clones = clone_calls;
			puts = put_calls;
			nf = nf_calls; dst = dst_calls; orphan = orphan_calls;
			invoke(kind, new_raw_skb(NULL, kind == 2));
			CHECK(clone_calls == clones && put_calls == puts);
			if (kind == 2)
				CHECK(nf_calls == nf && dst_calls == dst && orphan_calls == orphan);
			release_raw_cache();

			/* Snapshot failure poisons an original before early metadata
			 * puts; an apparently clean zero is never manufactured.
			 */
			a = (struct tako_terminal_owner){0};
			skb = new_raw_skb(&a, kind == 2);
			fail_clone = 1;
			invoke(kind, skb);
			fail_clone = 0;
			CHECK(a.poisoned && !a.refs && !a.pending_boundaries);
			CHECK(a.poison_event < a.last_put && a.last_put < a.cache_return);
			release_raw_cache();

			/* Every saved original origin, rather than only one current
			 * owner slot, remains held through the selected interval.
			 */
			a = (struct tako_terminal_owner){0};
			b = (struct tako_terminal_owner){0};
			skb = new_raw_skb(&a, kind == 2);
			attach_owner(skb, &b);
			invoke(kind, skb);
			CHECK(!a.refs && !b.refs && !a.poisoned && !b.poisoned);
			CHECK(a.cache_return < a.last_put && b.cache_return < b.last_put);
			release_raw_cache();
		}

		/* Shared extension and data storage are freed by their actual
		 * last raw header, not confused with each selected call's end.
		 */
		a = (struct tako_terminal_owner){0};
		skb = new_raw_skb(&a, 0);
		shared = share_raw_skb(skb);
		__napi_kfree_skb(skb, RAW_SELECTED_DROP);
		CHECK(a.refs == 1 && a.pending_boundaries == 1 && !a.poisoned);
		napi_consume_skb(shared, 1);
		CHECK(!a.refs && !a.pending_boundaries && !a.poisoned);
		CHECK(a.cache_return < a.last_put);
		release_raw_cache();

		/* Nested cache work holds per-call refs for same and different
		 * originals, without a global current-owner or synthetic join.
		 */
		for (unsigned int same = 0; same < 2; same++) {
			a = (struct tako_terminal_owner){0};
			b = (struct tako_terminal_owner){0};
			skb = new_raw_skb(&a, 0);
			skb->cache_child = new_raw_skb(same ? &a : &b, 0);
			napi_consume_skb(skb, 1);
			CHECK(!a.refs && !b.refs && !a.pending_boundaries && !b.pending_boundaries);
			CHECK(!a.poisoned && !b.poisoned && a.cache_return < a.last_put);
			if (!same)
				CHECK(b.cache_return < b.last_put && b.last_put < a.cache_return);
			release_raw_cache();
		}
	}

	/* Original budget/refcount/fclone branches never take the new snapshot
	 * or enter this NAPI cache, and nonfinal ownership stays on its live skb.
	 */
	clones = clone_calls; puts = put_calls; caches = cache_calls; releases = release_calls;
	delegated = budget_calls;
	napi_consume_skb(new_raw_skb(NULL, 0), 0);
	CHECK(budget_calls == delegated + 1 && cache_calls == caches);
	CHECK(clone_calls == clones && put_calls == puts && release_calls == releases);
	delegated = fclone_calls;
	skb = new_raw_skb(NULL, 0);
	skb->fclone = 1;
	napi_consume_skb(skb, 1);
	CHECK(fclone_calls == delegated + 1 && cache_calls == caches);
	CHECK(clone_calls == clones && put_calls == puts && release_calls == releases);
	a = (struct tako_terminal_owner){0};
	skb = new_raw_skb(&a, 0);
	skb->users = 2;
	napi_consume_skb(skb, 1);
	CHECK(skb->users == 1 && a.refs == 1 && a.pending_boundaries == 1);
	CHECK(clone_calls == clones && put_calls == puts && cache_calls == caches);
	napi_consume_skb(skb, 1);
	CHECK(!a.refs && !a.pending_boundaries && !a.poisoned);
	release_raw_cache();
	CHECK(groups_freed && trace_calls && unref_calls);
	printf("PASS %u exact-function NAPI cache-boundary checks; no kernel execution\n", checks);
	return 0;
}
