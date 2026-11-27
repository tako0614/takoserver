/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef TAKO_TERMINAL_KERNEL_NETDEV_STATE_H
#define TAKO_TERMINAL_KERNEL_NETDEV_STATE_H

/* Embedded verbatim in include/linux/tako_terminal_netdev_state.h.
 * Each published slot owns a genuine independent device-association ledger
 * reservation. Slots only grow; migration never replaces or releases history.
 * Kernel cmpxchg publishes initialized refs; readers use smp_load_acquire.
 * Final device-allocation free is exclusive and puts a saved local copy only
 * AFTER the allocation has been freed. This is not a namespace/terminal test.
 */
#ifdef __KERNEL__
#include <linux/atomic.h>
#include <linux/types.h>
#else
#include <stddef.h>
#endif

#define TAKO_TERMINAL_DEVICE_ORIGINS 4
struct tako_terminal_owner;

void tako_terminal_device_put(struct tako_terminal_owner *owner);
void tako_terminal_device_poison(struct tako_terminal_owner *owner);

struct tako_terminal_device_refs {
	struct tako_terminal_owner *owners[TAKO_TERMINAL_DEVICE_ORIGINS];
};

/* Consume one already-reserved real association, including duplicate unwind.
 * A failed CAS returns the actual published owner, so a concurrent duplicate
 * cannot skip to a later slot and consume another history entry.
 */
static inline void tako_terminal_device_refs_take(
	struct tako_terminal_device_refs *refs, struct tako_terminal_owner *owner)
{
	unsigned int i;

	if (!owner)
		return;
	for (i = 0; i < TAKO_TERMINAL_DEVICE_ORIGINS; i++) {
		struct tako_terminal_owner *previous;

		previous = cmpxchg(&refs->owners[i], NULL, owner);
		if (!previous)
			return;
		if (previous == owner) {
			tako_terminal_device_put(owner);
			return;
		}
	}
	/* There is no retained ref for this fifth original: poison it BEFORE
	 * dropping the reservation. Previously published history stays held.
	 */
	tako_terminal_device_poison(owner);
	tako_terminal_device_put(owner);
}

static inline void tako_terminal_device_refs_put(
	struct tako_terminal_device_refs *refs)
{
	unsigned int i;

	for (i = 0; i < TAKO_TERMINAL_DEVICE_ORIGINS; i++) {
		struct tako_terminal_owner *owner = refs->owners[i];

		refs->owners[i] = NULL;
		if (owner)
			tako_terminal_device_put(owner);
	}
}

#endif
