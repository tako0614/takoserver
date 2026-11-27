/* SPDX-License-Identifier: GPL-2.0-only */
/* Portable opaque-ref model only. No kernel/net/socket/device is executed.
 * The tested helper is byte-identical to the header embedded in the patch;
 * these API stand-ins count raw ownership events, not namespace authority.
 */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static unsigned int checks, event, last_clone, last_free, last_put;
static int fail_clone;
#define CHECK(e) do { assert(e); checks++; } while (0)

struct tako_terminal_owner {
	unsigned int reservations;
	unsigned int poisoned;
	unsigned int poison_event;
};

static struct tako_terminal_owner *tako_terminal_packet_clone(
	struct tako_terminal_owner *held)
{
	CHECK(held && held->reservations);
	last_clone = ++event;
	if (fail_clone)
		return NULL;
	held->reservations++;
	return held;
}

static void tako_terminal_packet_put(struct tako_terminal_owner *held)
{
	CHECK(held && held->reservations);
	last_put = ++event;
	held->reservations--;
}

static void tako_terminal_packet_poison(struct tako_terminal_owner *held)
{
	CHECK(held && held->reservations);
	held->poisoned = 1;
	held->poison_event = ++event;
}

#include "../../scripts/native/docker-container-terminal-kernel-skb-state.h"

/* A model extension allocation has independent held API reservations.
 * Multiple skb-header references can share one extension group. Only the
 * last header frees that group, and only after that free are its refs put.
 */
struct group {
	unsigned int headers;
	struct tako_terminal_skb_refs refs;
};

static struct tako_terminal_owner *reserve_raw(struct tako_terminal_owner *o)
{
	if (o) {
		o->reservations++;
		++event;
	}
	return o;
}

static struct group *allocate_group(struct tako_terminal_skb_refs *held,
				   int allocation_fails)
{
	struct group *g;

	/* The production caller reserves before its fallible slab allocation. */
	CHECK(tako_terminal_skb_refs_any(held));
	if (allocation_fails)
		return NULL;
	g = calloc(1, sizeof(*g));
	CHECK(g != NULL);
	g->headers = 1;
	tako_terminal_skb_refs_merge(&g->refs, held);
	CHECK(!tako_terminal_skb_refs_any(held));
	return g;
}

static void drop_header(struct group *g)
{
	struct tako_terminal_skb_refs held;

	CHECK(g && g->headers);
	if (--g->headers)
		return;
	held = g->refs;
	free(g);
	last_free = ++event;
	tako_terminal_skb_refs_put(&held);
	CHECK(!tako_terminal_skb_refs_any(&held));
	CHECK(last_put > last_free);
}

static struct group *cow_group(struct group *old, int allocation_fails)
{
	struct tako_terminal_skb_refs held = {0};
	struct group *next;
	unsigned int allocation_event;

	CHECK(old && old->headers > 1);
	tako_terminal_skb_refs_clone(&held, &old->refs);
	allocation_event = ++event;
	CHECK(last_clone < allocation_event);
	next = allocate_group(&held, allocation_fails);
	if (!next) {
		/* Failure leaves the original group and all original headers live. */
		tako_terminal_skb_refs_put(&held);
		return NULL;
	}
	drop_header(old);
	return next;
}

int main(void)
{
	struct tako_terminal_owner a = {0}, b = {0};
	struct tako_terminal_skb_refs held = {0};
	struct group *g, *next;
	unsigned int before;

	/* Unowned socket: no mutation, no fabricated reservation. */
	tako_terminal_skb_refs_take(&held, reserve_raw(NULL));
	CHECK(!tako_terminal_skb_refs_any(&held));
	CHECK(!event);

	/* Initial reservation precedes failed allocation. Tracking loss poisons
	 * the still-held original before the unwind put, never useful zero.
	 */
	tako_terminal_skb_refs_take(&held, reserve_raw(&a));
	CHECK(a.reservations == 1);
	CHECK(!allocate_group(&held, 1));
	tako_terminal_skb_refs_poison(&held);
	tako_terminal_skb_refs_put(&held);
	CHECK(a.poisoned && !a.reservations && a.poison_event < last_put);

	a = (struct tako_terminal_owner){0};
	tako_terminal_skb_refs_take(&held, reserve_raw(&a));
	g = allocate_group(&held, 0);
	/* Clones share the blob; freeing either skb cannot prematurely put it. */
	g->headers++;
	before = last_put;
	drop_header(g);
	CHECK(a.reservations == 1 && last_put == before && !a.poisoned);
	g->headers++;
	CHECK(!cow_group(g, 1));
	CHECK(g->headers == 2 && a.reservations == 1 && !a.poisoned);
	next = cow_group(g, 0);
	CHECK(g->headers == 1 && next->headers == 1);
	CHECK(a.reservations == 2 && !a.poisoned);
	drop_header(g);
	CHECK(a.reservations == 1 && !a.poisoned);
	drop_header(next);
	CHECK(!a.reservations && !a.poisoned);

	/* Reset/move retains a reservation across old-group destruction. */
	tako_terminal_skb_refs_take(&held, reserve_raw(&a));
	g = allocate_group(&held, 0);
	tako_terminal_skb_refs_clone(&held, &g->refs);
	drop_header(g);
	CHECK(a.reservations == 1 && !a.poisoned);
	next = allocate_group(&held, 0);
	drop_header(next);
	CHECK(!a.reservations && !a.poisoned);

	/* Copy over a live destination retains both independently held origins. */
	tako_terminal_skb_refs_take(&held, reserve_raw(&a));
	g = allocate_group(&held, 0);
	tako_terminal_skb_refs_clone(&held, &g->refs);
	drop_header(g);
	tako_terminal_skb_refs_take(&held, reserve_raw(&b));
	next = allocate_group(&held, 0);
	CHECK(a.reservations == 1 && b.reservations == 1);
	/* Re-assignment to the same owner unwinds only the duplicate reserve. */
	tako_terminal_skb_refs_take(&next->refs, reserve_raw(&a));
	CHECK(a.reservations == 1 && !a.poisoned && !b.poisoned);
	drop_header(next);
	CHECK(!a.reservations && !b.reservations);

	/* A reset/copy allocation failure must not leave a false clean ledger. */
	tako_terminal_skb_refs_take(&held, reserve_raw(&a));
	g = allocate_group(&held, 0);
	tako_terminal_skb_refs_clone(&held, &g->refs);
	drop_header(g);
	CHECK(!allocate_group(&held, 1));
	tako_terminal_skb_refs_poison(&held);
	tako_terminal_skb_refs_put(&held);
	CHECK(a.poisoned && !a.reservations && a.poison_event < last_put);

	/* Finite origin capacity fails closed for the exact incoming origin;
	 * retained origins remain independent and release only at group free.
	 */
	{
		struct tako_terminal_owner owners[TAKO_TERMINAL_SKB_OWNERS + 1] = {0};

		for (unsigned int i = 0; i < TAKO_TERMINAL_SKB_OWNERS + 1; i++)
			tako_terminal_skb_refs_take(&held, reserve_raw(&owners[i]));
		for (unsigned int i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++)
			CHECK(owners[i].reservations == 1 && !owners[i].poisoned);
		CHECK(!owners[TAKO_TERMINAL_SKB_OWNERS].reservations);
		CHECK(owners[TAKO_TERMINAL_SKB_OWNERS].poisoned);
		CHECK(owners[TAKO_TERMINAL_SKB_OWNERS].poison_event < last_put);
		g = allocate_group(&held, 0);
		drop_header(g);
		for (unsigned int i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++)
			CHECK(!owners[i].reservations && !owners[i].poisoned);
	}

	/* A violated clone assumption poisons the original while still held. */
	a = (struct tako_terminal_owner){0};
	tako_terminal_skb_refs_take(&held, reserve_raw(&a));
	g = allocate_group(&held, 0);
	fail_clone = 1;
	tako_terminal_skb_refs_clone(&held, &g->refs);
	fail_clone = 0;
	CHECK(!tako_terminal_skb_refs_any(&held));
	CHECK(a.reservations == 1 && a.poisoned);
	drop_header(g);
	CHECK(!a.reservations && a.poisoned);

	/* Many independently COW'd groups retain the last origin until all die. */
	for (unsigned int count = 2; count <= 64; count++) {
		struct group *copies[64];

		a = (struct tako_terminal_owner){0};
		tako_terminal_skb_refs_take(&held, reserve_raw(&a));
		g = allocate_group(&held, 0);
		g->headers = count;
		for (unsigned int i = 0; i < count - 1; i++)
			copies[i] = cow_group(g, 0);
		copies[count - 1] = g;
		CHECK(a.reservations == count && !a.poisoned);
		for (unsigned int i = 0; i < count; i++) {
			drop_header(copies[i]);
			CHECK(a.reservations == count - i - 1 && !a.poisoned);
		}
	}
	printf("PASS %u pure skb opaque-reference checks; no kernel execution\n", checks);
	return 0;
}
