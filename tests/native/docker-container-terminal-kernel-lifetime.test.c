/* SPDX-License-Identifier: GPL-2.0-only */
#include "../../scripts/native/docker-container-terminal-kernel-lifetime.h"
#include <assert.h>
#include <stdio.h>

static unsigned int checks;
#define CHECK(e) do { assert(e); checks++; } while (0)

int main(void)
{
	struct tako_terminal_lifetime s = {0};
	CHECK(!s.born && !s.net_gone && !s.release_attempted);
	tako_terminal_lifetime_born(&s);
	CHECK(s.born && !s.poisoned && !s.net_gone);
	CHECK(tako_terminal_lifetime_release_attempt(&s));
	CHECK(s.release_attempted && !s.reference_released && !s.net_gone);
	CHECK(!tako_terminal_lifetime_release_attempt(&s));
	tako_terminal_lifetime_reference_put(&s);
	/* External NSFS/runtime/task/socket refs can keep this interval open. */
	CHECK(s.reference_released && !s.net_gone && !s.poisoned);
	for (unsigned int i = 0; i < 32; i++) {
		CHECK(!tako_terminal_lifetime_release_attempt(&s));
		CHECK(!s.net_gone && !s.poisoned);
	}
	tako_terminal_lifetime_net_freed(&s);
	CHECK(s.net_gone && s.reference_released && !s.poisoned);
	tako_terminal_lifetime_net_freed(&s);
	CHECK(s.net_gone && s.poisoned);

	s = (struct tako_terminal_lifetime){0};
	tako_terminal_lifetime_born(&s);
	CHECK(tako_terminal_lifetime_release_attempt(&s));
	/* Actual cleanup callback can race before the original put returns. */
	tako_terminal_lifetime_net_freed(&s);
	CHECK(s.net_gone && !s.reference_released && !s.poisoned);
	tako_terminal_lifetime_reference_put(&s);
	CHECK(s.net_gone && s.reference_released && !s.poisoned);

	s = (struct tako_terminal_lifetime){0};
	tako_terminal_lifetime_born(&s);
	/* Failed namespace setup: real allocation unwind, no returned NSFS FD. */
	tako_terminal_lifetime_net_freed(&s);
	CHECK(s.net_gone && !s.release_attempted && !s.poisoned);
	tako_terminal_lifetime_born(&s);
	CHECK(s.poisoned && s.net_gone);

	s = (struct tako_terminal_lifetime){0};
	CHECK(!tako_terminal_lifetime_release_attempt(&s));
	CHECK(s.poisoned && !s.release_attempted && !s.net_gone);
	tako_terminal_lifetime_reference_put(&s);
	CHECK(s.poisoned && !s.reference_released);
	tako_terminal_lifetime_net_freed(&s);
	CHECK(s.poisoned && !s.net_gone);

	s = (struct tako_terminal_lifetime){0};
	tako_terminal_lifetime_born(&s);
	tako_terminal_lifetime_born(&s);
	CHECK(s.poisoned && s.born && !s.net_gone);
	CHECK(tako_terminal_lifetime_release_attempt(&s));
	tako_terminal_lifetime_reference_put(&s);
	tako_terminal_lifetime_reference_put(&s);
	CHECK(s.poisoned && s.reference_released && !s.net_gone);
	/* None of these events says the untracked skb/queue/offload work ended. */
	printf("PASS %u pure original-ledger lifecycle checks; no kernel execution\n", checks);
	return 0;
}
