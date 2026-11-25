// SPDX-License-Identifier: GPL-2.0-only
/* The include contains the UDP and skb free functions extracted from the
 * patched Linux v6.12 sources. The model supplies storage and ref boundaries. */
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>

#ifndef UDP_FINAL_BODIES
#error "Provide the extracted v6.12 UDP and skb free functions"
#endif

#define CONFIG_TAKO_TERMINAL 1
#define IS_ENABLED(option) 0
#define READ_ONCE(value) (value)
#define unlikely(value) (value)
#define likely(value) (value)
#define SKB_EXT_TAKO_TERMINAL 1
#define udp_sk(sk) (sk)
#define DEBUG_NET_WARN_ON_ONCE(condition) assert(!(condition))
#define in_hardirq() false

enum skb_drop_reason { SKB_DROP_REASON_NOT_SPECIFIED, SKB_CONSUMED };
struct sock {
	bool peeking_with_offset;
	int peek_offset;
};
struct packet_group {
	unsigned int refs;
	bool poisoned;
};
struct sk_buff {
	struct packet_group *extension;
	unsigned int users;
	bool head_state;
	bool head;
	void (*destructor)(struct sk_buff *);
	bool data_freed;
	bool shell_freed;
	unsigned int consumed_traces;
	enum skb_drop_reason reason;
};
struct tako_terminal_skb_refs {
	struct packet_group *held;
};

static void sk_peek_offset_bwd(struct sock *sk, int amount)
{
	sk->peek_offset -= amount;
}

static bool skb_unref(struct sk_buff *skb)
{
	assert(!skb->shell_freed && skb->users);
	if (skb->users == 1)
		return true;
	return --skb->users == 0;
}

static bool udp_skb_has_head_state(const struct sk_buff *skb)
{
	return skb->head_state;
}

static inline bool skb_ext_exist(const struct sk_buff *skb, int id)
{
	assert(id == SKB_EXT_TAKO_TERMINAL && !skb->shell_freed);
	return skb->extension != NULL;
}

static void tako_skb_snapshot(struct sk_buff *skb,
			      struct tako_terminal_skb_refs *refs)
{
	refs->held = skb->extension;
	if (refs->held)
		refs->held->refs++;
}

static void tako_terminal_skb_refs_put(struct tako_terminal_skb_refs *refs)
{
	if (refs->held) {
		assert(refs->held->refs > 0);
		refs->held->refs--;
		refs->held = NULL;
	}
}

static void skb_dst_drop(struct sk_buff *skb)
{
	assert(!skb->shell_freed);
	skb->head_state = false;
}

static void skb_ext_put_final(struct sk_buff *skb)
{
	struct tako_terminal_skb_refs refs = { skb->extension };

	skb->extension = NULL;
	tako_terminal_skb_refs_put(&refs);
}

static void skb_ext_put(struct sk_buff *skb)
{
	if (skb->extension)
		skb->extension->poisoned = true;
	skb_ext_put_final(skb);
}

static struct packet_group *expected_live_during_free;

static void skb_release_data(struct sk_buff *skb, enum skb_drop_reason reason)
{
	assert(!skb->shell_freed && !skb->data_freed);
	assert(!expected_live_during_free || expected_live_during_free->refs > 0);
	skb->data_freed = true;
	skb->reason = reason;
}

static void kfree_skbmem(struct sk_buff *skb)
{
	assert(!skb->shell_freed && skb->data_freed);
	assert(!expected_live_during_free || expected_live_during_free->refs > 0);
	skb->shell_freed = true;
}

static void trace_consume_skb(struct sk_buff *skb, void *caller)
{
	(void)caller;
	assert(!skb->shell_freed);
	skb->consumed_traces++;
}

#include UDP_FINAL_BODIES

static void tagged(bool head_state, bool shared)
{
	struct packet_group group = { .refs = shared ? 2 : 1 };
	struct sk_buff skb = {
		.extension = &group, .users = 2, .head_state = head_state, .head = true,
	};
	struct sock sk = { .peeking_with_offset = true, .peek_offset = 30 };

	expected_live_during_free = &group;
	skb_consume_udp(&sk, &skb, -2);
	assert(!skb.shell_freed && skb.consumed_traces == 0);
	assert(group.refs == (shared ? 2 : 1) && !group.poisoned);
	skb_consume_udp(&sk, &skb, 12);
	assert(skb.shell_freed && skb.reason == SKB_CONSUMED);
	assert(skb.consumed_traces == 1 && sk.peek_offset == 20);
	assert(group.refs == (shared ? 1 : 0) && !group.poisoned);
	expected_live_during_free = NULL;
}

int main(void)
{
	tagged(false, false);
	tagged(true, false);
	tagged(false, true);
	for (unsigned int state = 0; state < 2; state++) {
		struct sk_buff skb = { .users = 1, .head_state = state, .head = true };
		struct sock sk = { 0 };

		skb_consume_udp(&sk, &skb, 0);
		assert(skb.shell_freed && !skb.head_state);
		assert(skb.reason == SKB_CONSUMED && skb.consumed_traces == 1);
	}
	struct packet_group group = { .refs = 1 };
	struct sk_buff skb = { .users = 1, .extension = &group, .head = true };

	expected_live_during_free = &group;
	__kfree_skb(&skb);
	assert(skb.shell_freed && skb.reason == SKB_DROP_REASON_NOT_SPECIFIED);
	assert(skb.consumed_traces == 0 && !group.refs && !group.poisoned);
	puts("udp final skb custody: 6 cases passed");
}
