/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef TAKO_TERMINAL_KERNEL_SKB_STATE_H
#define TAKO_TERMINAL_KERNEL_SKB_STATE_H

/* Exact bytes embedded as include/linux/tako_terminal_skb_state.h in the
 * companion v6.12 patch. API declarations must precede this header. These
 * are already-held opaque original ledger refs, never namespace authority.
 * A fixed bound fails closed by poisoning the owner that cannot be retained.
 */
#define TAKO_TERMINAL_SKB_OWNERS 4

struct tako_terminal_skb_refs {
	struct tako_terminal_owner *owners[TAKO_TERMINAL_SKB_OWNERS];
};

/* Consume one genuine reservation; duplicate reservations are safe unwind. */
static inline void tako_terminal_skb_refs_take(
	struct tako_terminal_skb_refs *refs, struct tako_terminal_owner *owner)
{
	unsigned int i, empty = TAKO_TERMINAL_SKB_OWNERS;

	if (!owner)
		return;
	for (i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++) {
		if (refs->owners[i] == owner) {
			tako_terminal_packet_put(owner);
			return;
		}
		if (!refs->owners[i] && empty == TAKO_TERMINAL_SKB_OWNERS)
			empty = i;
	}
	if (empty < TAKO_TERMINAL_SKB_OWNERS) {
		refs->owners[empty] = owner;
		return;
	}
	/* Tracking loss precedes the unwind put, permanently refusing useful 0. */
	tako_terminal_packet_poison(owner);
	tako_terminal_packet_put(owner);
}

/* dst is zero-initialized. Reserve before any fallible group allocation. */
static inline void tako_terminal_skb_refs_clone(
	struct tako_terminal_skb_refs *dst,
	const struct tako_terminal_skb_refs *src)
{
	unsigned int i;

	for (i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++) {
		struct tako_terminal_owner *owner = src->owners[i];
		struct tako_terminal_owner *held;

		if (!owner)
			continue;
		held = tako_terminal_packet_clone(owner);
		if (!held)
			tako_terminal_packet_poison(owner);
		tako_terminal_skb_refs_take(dst, held);
	}
}

static inline void tako_terminal_skb_refs_poison(
	const struct tako_terminal_skb_refs *refs)
{
	unsigned int i;

	for (i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++)
		if (refs->owners[i])
			tako_terminal_packet_poison(refs->owners[i]);
}

/* Only after the actual extension group free, or failed allocation unwind. */
static inline void tako_terminal_skb_refs_put(struct tako_terminal_skb_refs *refs)
{
	unsigned int i;

	for (i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++) {
		struct tako_terminal_owner *owner = refs->owners[i];

		refs->owners[i] = 0;
		if (owner)
			tako_terminal_packet_put(owner);
	}
}

/* Move held reservations, retaining other origins on the live destination. */
static inline void tako_terminal_skb_refs_merge(
	struct tako_terminal_skb_refs *dst, struct tako_terminal_skb_refs *held)
{
	unsigned int i;

	for (i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++) {
		struct tako_terminal_owner *owner = held->owners[i];

		held->owners[i] = 0;
		tako_terminal_skb_refs_take(dst, owner);
	}
}

static inline int tako_terminal_skb_refs_any(
	const struct tako_terminal_skb_refs *refs)
{
	unsigned int i;

	for (i = 0; i < TAKO_TERMINAL_SKB_OWNERS; i++)
		if (refs->owners[i])
			return 1;
	return 0;
}

#endif
