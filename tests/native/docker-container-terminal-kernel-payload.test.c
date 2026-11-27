/* SPDX-License-Identifier: GPL-2.0-only */
/* Portable free-boundary model, not kernel/native/namespace qualification.
 * Opaque API stand-ins only count raw references; they create no authority.
 * Reproduce from this repo root using only the companion patch/test/helper:
 *
 * tako_payload_include="$(mktemp)"
 * export TAKO_PAYLOAD_TEST_INCLUDE="$tako_payload_include"
 * python3 - <<'PY'
 * import os
 * from pathlib import Path
 * lines = Path("scripts/native/docker-container-terminal-kernel-payload-v6.12.patch").read_text().splitlines(True)
 * text = "".join(x[1:] for x in lines if x[:1] in (" ", "+") and not x.startswith("+++"))
 * start = text.index("void __kfree_skb(")
 * end = text.index("\n}\n", start) + 3
 * Path(os.environ["TAKO_PAYLOAD_TEST_INCLUDE"]).write_text(text[start:end])
 * PY
 * cc -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined \
 *   -DCONFIG_TAKO_TERMINAL=1 \
 *   "-DTAKO_PAYLOAD_ACTUAL_FUNCTION=\"$tako_payload_include\"" \
 *   tests/native/docker-container-terminal-kernel-payload.test.c \
 *   -o "$tako_payload_include.test"
 * "$tako_payload_include.test"
 *
 * The extracted context-plus-added postimage is compiled without a separate
 * copied implementation or an operator-private path dependency.
 */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

#ifndef TAKO_PAYLOAD_ACTUAL_FUNCTION
#error "Extract the companion patch __kfree_skb postimage and select its include"
#endif
#ifndef CONFIG_TAKO_TERMINAL
#error "This dedicated new reference-order regression tests the enabled path"
#endif

static unsigned int checks, event, clone_calls, put_calls, groups_freed;
static unsigned int payloads_freed, shells_freed;
static int fail_clone;
#define CHECK(e) do { assert(e); checks++; } while (0)

struct tako_terminal_owner {
	unsigned int refs;
	unsigned int live_headers;
	unsigned int poisoned;
	unsigned int poison_event;
	unsigned int last_put;
	unsigned int data_return;
	unsigned int shell_free;
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
		CHECK(!held->live_headers);
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
	struct tako_terminal_owner *probe;
	struct sk_buff *destructor_child;
	unsigned int release_all_returned;
};

enum skb_drop_reason { SKB_DROP_REASON_NOT_SPECIFIED };
void __kfree_skb(struct sk_buff *skb);

/* Raw storage stand-in for the existing private snapshot boundary. The
 * unchanged shared helper performs the actual tested opaque-ref algorithm.
 */
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
	struct tako_terminal_owner *probe = skb->probe;

	CHECK(reason == SKB_DROP_REASON_NOT_SPECIFIED);
	/* Existing destructors may reenter a selected independent free chain.
	 * This is not a model of every frag-list/bulk-free kernel producer.
	 */
	if (skb->destructor_child) {
		struct sk_buff *child = skb->destructor_child;

		skb->destructor_child = NULL;
		__kfree_skb(child);
		CHECK(!probe || probe->refs || probe->poisoned);
	}
	skb->extension = NULL;
	if (extension && !--extension->headers) {
		struct tako_terminal_skb_refs held = extension->refs;

		free(extension);
		groups_freed++;
		++event;
		/* Original group puts still occur after actual metadata free. */
		tako_terminal_skb_refs_put(&held);
	}
	/* A clean original may not reach zero while payload/header processing
	 * remains, even though its extension metadata has just been freed.
	 */
	CHECK(!probe || probe->refs || probe->poisoned);
	CHECK(payload && payload->headers);
	if (!--payload->headers) {
		free(payload->bytes);
		free(payload);
		payloads_freed++;
	}
	skb->payload = NULL;
	if (probe)
		probe->data_return = ++event;
	else
		++event;
	skb->release_all_returned = 1;
}

static void kfree_skbmem(struct sk_buff *skb)
{
	struct tako_terminal_owner *probe = skb->probe;

	CHECK(skb->release_all_returned);
	CHECK(!probe || probe->refs || probe->poisoned);
	free(skb);
	shells_freed++;
	++event;
	if (probe) {
		CHECK(probe->live_headers);
		probe->live_headers--;
		probe->shell_free = event;
		CHECK(probe->refs || probe->poisoned);
	}
}

/* No rewritten copy of the new function is maintained in this test. */
#include TAKO_PAYLOAD_ACTUAL_FUNCTION

static struct sk_buff *new_raw_skb(struct tako_terminal_owner *owner)
{
	struct sk_buff *skb = calloc(1, sizeof(*skb));

	CHECK(skb != NULL);
	skb->payload = calloc(1, sizeof(*skb->payload));
	CHECK(skb->payload != NULL);
	skb->payload->headers = 1;
	skb->payload->bytes = malloc(32);
	CHECK(skb->payload->bytes != NULL);
	skb->probe = owner;
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

static struct sk_buff *share_raw_skb(struct sk_buff *source)
{
	struct sk_buff *copy = malloc(sizeof(*copy));

	CHECK(copy != NULL);
	*copy = *source;
	copy->destructor_child = NULL;
	if (copy->extension)
		copy->extension->headers++;
	copy->payload->headers++;
	if (copy->probe)
		copy->probe->live_headers++;
	return copy;
}

int main(void)
{
	struct tako_terminal_owner a = {0}, b = {0};
	struct sk_buff *skb, *shared;
	unsigned int before_clones, before_puts, before_shells;

	/* Actual function body retains through metadata, payload and shell free. */
	skb = new_raw_skb(&a);
	__kfree_skb(skb);
	CHECK(!a.refs && !a.live_headers && !a.poisoned);
	CHECK(a.data_return < a.shell_free && a.shell_free < a.last_put);
	CHECK(groups_freed == 1 && payloads_freed == 1 && shells_freed == 1);
	CHECK(clone_calls == 1 && put_calls == 2);

	/* An unrelated unowned packet gains no reference or fabricated owner. */
	before_clones = clone_calls;
	before_puts = put_calls;
	skb = new_raw_skb(NULL);
	__kfree_skb(skb);
	CHECK(clone_calls == before_clones && put_calls == before_puts);

	/* Sharing is explicit in this raw boundary model: first header disposal
	 * leaves the real shared group/payload; the final one frees both.
	 */
	a = (struct tako_terminal_owner){0};
	skb = new_raw_skb(&a);
	shared = share_raw_skb(skb);
	__kfree_skb(skb);
	CHECK(a.refs == 1 && a.live_headers == 1 && !a.poisoned);
	__kfree_skb(shared);
	CHECK(!a.refs && !a.live_headers && !a.poisoned);
	CHECK(a.shell_free < a.last_put);

	/* Missing clone cannot manufacture a clean zero: original is poisoned
	 * while still held, before its metadata put and later release work.
	 */
	a = (struct tako_terminal_owner){0};
	skb = new_raw_skb(&a);
	fail_clone = 1;
	__kfree_skb(skb);
	fail_clone = 0;
	CHECK(a.poisoned && !a.refs && !a.live_headers);
	CHECK(a.poison_event < a.last_put && a.last_put < a.shell_free);

	/* Reentrant destructor chains keep per-call saved origins, not a global
	 * current-owner slot. Different and identical origins are both covered.
	 */
	for (unsigned int same = 0; same < 2; same++) {
		a = (struct tako_terminal_owner){0};
		b = (struct tako_terminal_owner){0};
		skb = new_raw_skb(&a);
		skb->destructor_child = new_raw_skb(same ? &a : &b);
		before_shells = shells_freed;
		__kfree_skb(skb);
		CHECK(shells_freed == before_shells + 2);
		CHECK(!a.refs && !a.live_headers && !a.poisoned);
		CHECK(a.shell_free < a.last_put);
		CHECK(!b.refs && !b.live_headers && !b.poisoned);
		if (!same)
			CHECK(b.shell_free < b.last_put && b.last_put < a.shell_free);
	}
	printf("PASS %u exact-function payload free-order checks; no kernel execution\n", checks);
	return 0;
}
