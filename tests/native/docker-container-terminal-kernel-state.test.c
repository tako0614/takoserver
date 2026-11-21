/* SPDX-License-Identifier: GPL-2.0-only */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include "../../scripts/native/docker-container-terminal-kernel-state.h"

static unsigned long checks;
#define CHECK(expr) do { assert(expr); checks++; } while (0)

static void histories(void)
{
	/* Exhaustively interleave full-object birth/clone, final free and cut.
	 * A clone owns a separate count; a cut cannot erase outstanding objects.
	 * Invalid frees poison permanently, even after later valid-looking input.
	 */
	for (unsigned int bits = 0; bits < 65536U; bits++) {
		struct tako_terminal_state s;
		unsigned int word = bits;
		uint64_t live = 0, got = 0, put = 0;
		unsigned int sealed = 0, poisoned = 0;
		tako_terminal_state_init(&s);
		for (unsigned int step = 0; step < 8U; step++) {
			unsigned int op = word & 3U;
			word >>= 2;
			if (op == 0 || op == 1) {
				tako_terminal_state_get(&s);
				if (!poisoned) { live++; got++; }
			} else if (op == 2) {
				tako_terminal_state_put(&s);
				if (!poisoned) {
					if (!live) poisoned = 1;
					else { live--; put++; }
				}
			} else {
				tako_terminal_state_seal(&s);
				sealed = 1;
			}
			CHECK(s.sockets == live);
			CHECK(s.allocations == got);
			CHECK(s.releases == put);
			CHECK(s.sealed == sealed);
			CHECK(s.poisoned == poisoned);
			CHECK(poisoned || got == put + live);
		}
	}
}

static void boundaries(void)
{
	struct tako_terminal_state s;
	unsigned int attempted = 0;
	CHECK(tako_terminal_consume_birth(&attempted));
	CHECK(attempted == 1);
	/* Allocation failure or lost namespace-FD return never resets custody. */
	CHECK(!tako_terminal_consume_birth(&attempted));
	CHECK(!tako_terminal_consume_birth(&attempted));
	attempted = 0;
	CHECK(tako_terminal_consume_birth(&attempted)); /* CUT before CREATE */
	CHECK(!tako_terminal_consume_birth(&attempted));
	tako_terminal_state_init(&s);
	s.sockets = TAKO_TERMINAL_U64_MAX - 1;
	s.allocations = TAKO_TERMINAL_U64_MAX - 1;
	tako_terminal_state_get(&s);
	CHECK(s.sockets == TAKO_TERMINAL_U64_MAX && !s.poisoned);
	tako_terminal_state_get(&s);
	CHECK(s.sockets == TAKO_TERMINAL_U64_MAX && s.poisoned);
	tako_terminal_state_put(&s);
	CHECK(s.sockets == TAKO_TERMINAL_U64_MAX);
	tako_terminal_state_seal(&s);
	CHECK(s.poisoned && s.sealed);
	tako_terminal_state_init(&s);
	s.allocations = TAKO_TERMINAL_U64_MAX;
	tako_terminal_state_get(&s);
	CHECK(s.poisoned && !s.sockets);
	tako_terminal_state_init(&s);
	s.sockets = 1;
	s.releases = TAKO_TERMINAL_U64_MAX;
	tako_terminal_state_put(&s);
	CHECK(s.poisoned && s.sockets == 1);
	tako_terminal_state_init(&s);
	tako_terminal_state_get(&s);
	tako_terminal_state_get(&s);
	tako_terminal_state_seal(&s);
	tako_terminal_state_put(&s);
	CHECK(s.sockets == 1 && s.sealed && !s.poisoned);
	tako_terminal_state_get(&s); /* a late clone remains visible after cut */
	CHECK(s.sockets == 2 && s.allocations == 3 && s.sealed);
	tako_terminal_state_put(&s);
	tako_terminal_state_put(&s);
	CHECK(!s.sockets && s.releases == 3 && s.sealed && !s.poisoned);
	/* Zero here is only this subcounter. No function grants a terminal state. */
}

int main(void)
{
	histories();
	boundaries();
	printf("PASS %lu pure socket-ledger transition checks; no kernel execution\n", checks);
	return 0;
}
