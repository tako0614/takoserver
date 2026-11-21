/* SPDX-License-Identifier: GPL-2.0-only */
/* Raw malloc/bulkfree boundary regression, not kernel/namespace qualification.
 * Reproduce from this repo root; both function bodies come from public patches:
 *
 * tako_bulk_include="$(mktemp)"
 * export TAKO_BULK_TEST_INCLUDE="$tako_bulk_include"
 * python3 - <<'PY'
 * import os
 * from pathlib import Path
 * def post(name):
 *     lines = Path("scripts/native/" + name).read_text().splitlines(True)
 *     return "".join(x[1:] for x in lines if x[:1] in (" ", "+") and not x.startswith("+++"))
 * direct = post("docker-container-terminal-kernel-payload-v6.12.patch")
 * start = direct.index("void __kfree_skb(")
 * direct = direct[start:direct.index("\n}\n", start) + 3]
 * bulk = post("docker-container-terminal-kernel-payload-bulk-v6.12.patch")
 * bulk = bulk[bulk.index("#define KFREE_SKB_BULK_SIZE"):bulk.index("EXPORT_SYMBOL(kfree_skb_list_reason);")]
 * Path(os.environ["TAKO_BULK_TEST_INCLUDE"]).write_text(direct + "\n" + bulk)
 * PY
 * cc -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined \
 *   -DCONFIG_TAKO_TERMINAL=1 \
 *   "-DTAKO_BULK_ACTUAL_FUNCTIONS=\"$tako_bulk_include\"" \
 *   tests/native/docker-container-terminal-kernel-payload-bulk.test.c \
 *   -o "$tako_bulk_include.test"
 * "$tako_bulk_include.test"
 *
 * No copied replacement function or operator-private locator is required.
 */
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

#ifndef TAKO_BULK_ACTUAL_FUNCTIONS
#error "Extract the companion public patch postimages and select their include"
#endif
#ifndef CONFIG_TAKO_TERMINAL
#error "This new saved-reference-order regression tests the enabled path"
#endif

static unsigned int checks, event, bulk_calls, direct_calls, clone_calls;
static unsigned int bulk_sizes[128], fail_clone_count;
#define CHECK(e) do { assert(e); checks++; } while (0)
#define unlikely(e) (e)
#define __fix_address
#define SKB_FCLONE_UNAVAILABLE 0

struct tako_terminal_owner {
	unsigned int refs, live_headers, poisoned, last_put, shell_free;
};

static struct tako_terminal_owner *tako_terminal_packet_clone(
	struct tako_terminal_owner *owner)
{
	CHECK(owner && owner->refs);
	clone_calls++;
	if (fail_clone_count) {
		fail_clone_count--;
		return NULL;
	}
	owner->refs++;
	return owner;
}

static void tako_terminal_packet_put(struct tako_terminal_owner *owner)
{
	CHECK(owner && owner->refs);
	owner->last_put = ++event;
	if (!--owner->refs && !owner->poisoned)
		CHECK(!owner->live_headers);
}

static void tako_terminal_packet_poison(struct tako_terminal_owner *owner)
{
	CHECK(owner && owner->refs);
	owner->poisoned = 1;
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
	struct sk_buff *next;
	struct raw_extension *extension;
	struct raw_payload *payload;
	struct tako_terminal_owner *probe;
	unsigned int fclone, users, release_returned;
};
enum skb_drop_reason { SKB_DROP_REASON_NOT_SPECIFIED, RAW_LIST_REASON };
static unsigned char raw_cache;
static struct { void *skbuff_cache; } net_hotdata = { &raw_cache };

static void tako_skb_snapshot(const struct sk_buff *skb,
			      struct tako_terminal_skb_refs *held)
{
	if (skb->extension) {
		CHECK(skb->extension->headers);
		tako_terminal_skb_refs_clone(held, &skb->extension->refs);
	}
}

static void skb_release_all(struct sk_buff *skb, enum skb_drop_reason reason)
{
	struct raw_extension *extension = skb->extension;
	struct raw_payload *payload = skb->payload;

	CHECK(reason == RAW_LIST_REASON || reason == SKB_DROP_REASON_NOT_SPECIFIED);
	CHECK(!skb->users && !skb->release_returned);
	skb->extension = NULL;
	if (extension && !--extension->headers) {
		struct tako_terminal_skb_refs held = extension->refs;

		free(extension);
		tako_terminal_skb_refs_put(&held);
	}
	CHECK(!skb->probe || skb->probe->refs || skb->probe->poisoned);
	CHECK(payload && payload->headers);
	if (!--payload->headers) {
		free(payload->bytes);
		free(payload);
	}
	skb->payload = NULL;
	skb->release_returned = 1;
}

static void raw_shell_free(struct sk_buff *skb)
{
	struct tako_terminal_owner *owner = skb->probe;

	CHECK(skb->release_returned);
	CHECK(!owner || owner->refs || owner->poisoned);
	free(skb);
	++event;
	if (owner) {
		CHECK(owner->live_headers);
		owner->live_headers--;
		owner->shell_free = event;
		CHECK(owner->refs || owner->poisoned);
	}
}

static void kfree_skbmem(struct sk_buff *skb)
{
	direct_calls++;
	raw_shell_free(skb);
}

static bool __sk_skb_reason_drop(void *sk, struct sk_buff *skb,
				enum skb_drop_reason reason)
{
	CHECK(!sk && reason == RAW_LIST_REASON);
	CHECK(skb->users);
	return --skb->users == 0;
}

static void skb_poison_list(struct sk_buff *skb)
{
	CHECK(!skb->users);
	skb->next = NULL;
}

static void kmem_cache_free_bulk(void *cache, size_t count, void **array);

/* Exact actual __kfree body plus new bulk struct/functions, never a mirror. */
#include TAKO_BULK_ACTUAL_FUNCTIONS

static void kmem_cache_free_bulk(void *cache, size_t count, void **array)
{
	CHECK(cache == net_hotdata.skbuff_cache);
	CHECK(count && count <= KFREE_SKB_BULK_SIZE);
	CHECK(bulk_calls < sizeof(bulk_sizes) / sizeof(bulk_sizes[0]));
	bulk_sizes[bulk_calls++] = count;
	for (size_t i = 0; i < count; i++) {
		raw_shell_free(array[i]);
		/* The real allocator may change its array: saved refs must be
		 * independent, and no postfree packet read can use these slots.
		 */
		array[i] = NULL;
	}
}

static struct sk_buff *new_raw_skb(struct tako_terminal_owner *owner)
{
	struct sk_buff *skb = calloc(1, sizeof(*skb));

	CHECK(skb != NULL);
	skb->users = 1;
	skb->probe = owner;
	skb->payload = calloc(1, sizeof(*skb->payload));
	CHECK(skb->payload != NULL);
	skb->payload->headers = 1;
	skb->payload->bytes = malloc(16);
	CHECK(skb->payload->bytes != NULL);
	if (owner) {
		skb->extension = calloc(1, sizeof(*skb->extension));
		CHECK(skb->extension != NULL);
		skb->extension->headers = 1;
		owner->refs++;
		owner->live_headers++;
		tako_terminal_skb_refs_take(&skb->extension->refs, owner);
	}
	return skb;
}

static void check_length(unsigned int count)
{
	struct tako_terminal_owner a = {0}, b = {0};
	struct sk_buff *first = NULL, **tail = &first;
	unsigned int before = bulk_calls, old_direct = direct_calls;

	for (unsigned int i = 0; i < count; i++) {
		*tail = new_raw_skb(i % 3 == 0 ? NULL : i % 2 ? &a : &b);
		tail = &(*tail)->next;
	}
	kfree_skb_list_reason(first, RAW_LIST_REASON);
	CHECK(bulk_calls - before == (count + 15) / 16);
	for (unsigned int i = 0; i < count / 16; i++)
		CHECK(bulk_sizes[before + i] == 16);
	if (count % 16)
		CHECK(bulk_sizes[bulk_calls - 1] == count % 16);
	CHECK(direct_calls == old_direct);
	CHECK(!a.refs && !a.live_headers && !a.poisoned);
	CHECK(!b.refs && !b.live_headers && !b.poisoned);
	if (a.shell_free)
		CHECK(a.shell_free < a.last_put);
	if (b.shell_free)
		CHECK(b.shell_free < b.last_put);
}

int main(void)
{
	struct tako_terminal_owner a = {0}, b = {0};
	struct sk_buff *first = NULL, **tail = &first, *retained[5];
	unsigned int before, old_direct, saved = 0;
	const unsigned int lengths[] = {0, 1, 15, 16, 17, 32, 35};

	for (unsigned int i = 0; i < sizeof(lengths) / sizeof(lengths[0]); i++)
		check_length(lengths[i]);

	/* Existing fclone branch uses unchanged actual __kfree, not a bulk slot. */
	before = bulk_calls;
	old_direct = direct_calls;
	for (unsigned int i = 0; i < 20; i++) {
		*tail = new_raw_skb(&a);
		(*tail)->fclone = i % 3 == 0;
		tail = &(*tail)->next;
	}
	kfree_skb_list_reason(first, RAW_LIST_REASON);
	CHECK(direct_calls - old_direct == 7);
	CHECK(bulk_calls - before == 1 && bulk_sizes[before] == 13);
	CHECK(!a.refs && !a.live_headers && !a.poisoned && a.shell_free < a.last_put);

	/* The original ref-drop guard leaves external holders unfreed. */
	a = (struct tako_terminal_owner){0};
	first = NULL;
	tail = &first;
	for (unsigned int i = 0; i < 20; i++) {
		*tail = new_raw_skb(&a);
		if (i % 4 == 0) {
			(*tail)->users = 2;
			retained[saved++] = *tail;
		}
		tail = &(*tail)->next;
	}
	kfree_skb_list_reason(first, RAW_LIST_REASON);
	CHECK(a.live_headers == 5 && a.refs == 5 && !a.poisoned);
	for (unsigned int i = 0; i < saved; i++) {
		retained[i]->next = NULL;
		kfree_skb_list_reason(retained[i], RAW_LIST_REASON);
	}
	CHECK(!a.refs && !a.live_headers && !a.poisoned);

	/* Shared extension/payload model keeps the source group to its last
	 * header; per-bulk saved refs survive even if allocator scribbles array.
	 */
	a = (struct tako_terminal_owner){0};
	first = new_raw_skb(&a);
	first->next = malloc(sizeof(*first));
	CHECK(first->next != NULL);
	*first->next = *first;
	first->next->next = NULL;
	first->extension->headers++;
	first->payload->headers++;
	a.live_headers++;
	kfree_skb_list_reason(first, RAW_LIST_REASON);
	CHECK(!a.refs && !a.live_headers && !a.poisoned);

	/* Actual lost snapshot poisons only its original; no clean early zero. */
	a = (struct tako_terminal_owner){0};
	first = new_raw_skb(&a);
	first->next = new_raw_skb(&b);
	fail_clone_count = 1;
	kfree_skb_list_reason(first, RAW_LIST_REASON);
	CHECK(a.poisoned && !a.refs && !a.live_headers && a.last_put < a.shell_free);
	CHECK(!b.poisoned && !b.refs && !b.live_headers && b.shell_free < b.last_put);
	CHECK(clone_calls > 0);
	printf("PASS %u exact-function bulk free-order checks; no kernel execution\n", checks);
	return 0;
}
