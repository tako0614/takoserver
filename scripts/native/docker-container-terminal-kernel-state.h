/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef TAKO_TERMINAL_KERNEL_STATE_H
#define TAKO_TERMINAL_KERNEL_STATE_H

/* Embedded unchanged as include/linux/tako_terminal_state.h in the v6.12
 * patch. Callers serialize every transition with the kernel owner's lock.
 * Reserve before full socket/clone allocation, release only after actual
 * memory free (or failed allocation unwind). In-flight reservations count.
 * There is intentionally no idle, complete, ready, or retirement predicate.
 */
#ifdef __KERNEL__
#include <linux/types.h>
typedef u64 tako_terminal_u64;
#else
#include <stdint.h>
typedef uint64_t tako_terminal_u64;
#endif

#define TAKO_TERMINAL_U64_MAX ((tako_terminal_u64)~(tako_terminal_u64)0)

/* The private device context calls this before allocation, including failed
 * allocation and lost-return cases. It cannot authorize a second birth. */
static inline int tako_terminal_consume_birth(unsigned int *attempted)
{
	if (*attempted)
		return 0;
	*attempted = 1;
	return 1;
}

struct tako_terminal_state {
	tako_terminal_u64 sockets;
	tako_terminal_u64 allocations;
	tako_terminal_u64 releases;
	unsigned int poisoned;
	unsigned int sealed;
};

static inline void tako_terminal_state_init(struct tako_terminal_state *s)
{
	s->sockets = 0;
	s->allocations = 0;
	s->releases = 0;
	s->poisoned = 0;
	s->sealed = 0;
}

static inline void tako_terminal_state_get(struct tako_terminal_state *s)
{
	if (s->poisoned)
		return;
	if (s->sockets == TAKO_TERMINAL_U64_MAX ||
	    s->allocations == TAKO_TERMINAL_U64_MAX) {
		s->poisoned = 1;
		return;
	}
	s->sockets++;
	s->allocations++;
}

static inline void tako_terminal_state_put(struct tako_terminal_state *s)
{
	if (s->poisoned)
		return;
	if (!s->sockets || s->releases == TAKO_TERMINAL_U64_MAX) {
		s->poisoned = 1;
		return;
	}
	s->sockets--;
	s->releases++;
}

static inline void tako_terminal_state_seal(struct tako_terminal_state *s)
{
	/* Sealing never prevents counting late kernel allocations or clones. */
	s->sealed = 1;
}

/* Only the original device context may invoke OPEN, under its owner lock.
 * No observed count/boolean is an admission input. CUT is permanent and
 * neither transition erases an outstanding object or grants retirement.
 */
struct tako_terminal_admission {
	unsigned int attempted;
	unsigned int opened;
	unsigned int cut;
};

static inline void tako_terminal_admission_init(struct tako_terminal_admission *s)
{
	s->attempted = 0;
	s->opened = 0;
	s->cut = 0;
}

static inline int tako_terminal_admission_open(struct tako_terminal_admission *s,
					      const struct tako_terminal_state *objects)
{
	if (s->attempted)
		return 0;
	s->attempted = 1;
	if (s->cut || objects->sealed || objects->poisoned)
		return 0;
	s->opened = 1;
	return 1;
}

static inline void tako_terminal_admission_cut(struct tako_terminal_admission *s)
{
	s->attempted = 1;
	s->cut = 1;
	s->opened = 0;
}

static inline int tako_terminal_admission_blocked(
	const struct tako_terminal_admission *s, const struct tako_terminal_state *objects)
{
	return !s->opened || s->cut || objects->sealed || objects->poisoned;
}

#endif
