/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef TAKO_TERMINAL_KERNEL_LIFETIME_H
#define TAKO_TERMINAL_KERNEL_LIFETIME_H

/* Embedded verbatim in the version-pinned kernel patch. Events are wired to
 * fresh net allocation, the original file's one reference put, and the actual
 * final net_free after slab release. None is a terminal/idle predicate.
 * Serialize with the kernel ledger lock; callers cannot supply event flags.
 */
struct tako_terminal_lifetime {
	unsigned int born;
	unsigned int release_attempted;
	unsigned int reference_released;
	unsigned int net_gone;
	unsigned int poisoned;
};

static inline void tako_terminal_lifetime_born(struct tako_terminal_lifetime *s)
{
	if (s->born || s->net_gone) {
		s->poisoned = 1;
		return;
	}
	s->born = 1;
}

static inline int
tako_terminal_lifetime_release_attempt(struct tako_terminal_lifetime *s)
{
	if (!s->born) {
		s->poisoned = 1;
		return 0;
	}
	if (s->release_attempted)
		return 0;
	s->release_attempted = 1;
	return 1;
}

static inline void
tako_terminal_lifetime_reference_put(struct tako_terminal_lifetime *s)
{
	if (!s->release_attempted || s->reference_released) {
		s->poisoned = 1;
		return;
	}
	s->reference_released = 1;
}

static inline void
tako_terminal_lifetime_net_freed(struct tako_terminal_lifetime *s)
{
	/* Creation unwind can free a net before any explicit release attempt;
	 * cleanup work can also finish before put_net returns to its caller.
	 */
	if (!s->born || s->net_gone) {
		s->poisoned = 1;
		return;
	}
	s->net_gone = 1;
}

#endif
