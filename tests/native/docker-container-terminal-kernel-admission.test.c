/* SPDX-License-Identifier: GPL-2.0-only */
/* Portable raw-kernel-types test. Build with two caller-selected temporary
 * includes, extracted from the companion kernel-v6.12.patch NEW-file bodies:
 *   net/core/tako_terminal.c -> TAKO_ADMISSION_DRIVER_FILE containing its
 *     tako_terminal_owner / tako_terminal_file structs, and whole original
 *     tako_owner_put, tako_admission_poisoned, tako_terminal_block,
 *     tako_cut_admission, tako_seal, tako_open_admission,
 *     tako_release_namespace, tako_ioctl, tako_release function bodies.
 * For the composed case, first apply ONLY the selected NETDEV patch's
 * net/core/tako_terminal.c hunks by exact source context and prepend its
 * existing TAKO_TERMINAL_DEVICE_ORIGINS definition to the extracted include.
 * The local kernel-uapi.h must match the embedded patch UAPI byte for byte.
 * Keep every selected body byte-identical; discard patch '+' prefixes only.
 * Example compile from repository root after that extraction:
 * cc -std=gnu11 -Wall -Wextra -Werror -Wno-unused-parameter -pthread \
 *   -fsanitize=address,undefined -fno-omit-frame-pointer \
 *   -DTAKO_ADMISSION_DRIVER_FILE='"/chosen/tmp/driver.inc"' \
 *   tests/native/docker-container-terminal-kernel-admission.test.c -o /chosen/tmp/test
 * This compiles actual shared helpers and selected actual driver bodies over
 * raw allocations, locks, PID identity, namespace references and uaccess.
 * GNU C preserves the original kernel's empty-initializer syntax unchanged.
 * It does not build/run a kernel, create a namespace, or replace a successful
 * namespace creator: unsupported CREATE effects abort if reached. Prepared
 * raw contexts are not proof of real kernel birth, traffic, or retirement.
 */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <sched.h>
#include "../../scripts/native/docker-container-terminal-kernel-state.h"
#include "../../scripts/native/docker-container-terminal-kernel-lifetime.h"
#ifndef TAKO_ADMISSION_DRIVER_FILE
#error "Extract the companion patch selected driver bodies into a temporary include"
#endif
#include "../../scripts/native/docker-container-terminal-kernel-uapi.h"

typedef uint64_t u64;
typedef uint8_t u8;
typedef unsigned int refcount_t;
typedef pthread_mutex_t spinlock_t;
struct mutex { pthread_mutex_t raw; };
struct pid { unsigned int number, references; };
struct tako_terminal_owner;
struct net {
	struct tako_terminal_owner *tako_terminal;
	u64 net_cookie;
	struct { u64 inum; } ns;
	unsigned int references;
};
struct file { void *private_data; };
struct inode { unsigned int unused; };

#define NFPROTO_IPV4 2
#define NFPROTO_IPV6 10
#define CAP_SYS_ADMIN 0
#define CAP_NET_ADMIN 1
#define GFP_KERNEL 0
#define __user
static unsigned int init_user_ns;
static struct pid original_pid = { 17, 10000 }, recycled_number_pid = { 17, 10000 };
static struct pid *raw_current = &original_pid;
static unsigned int capabilities = 3;
#define current raw_current
#define task_tgid(task) (task)
static bool ns_capable(const void *ns, unsigned int capability)
{
	assert(ns == &init_user_ns);
	return (capabilities & (1U << capability)) != 0;
}
static void raw_lock(pthread_mutex_t *lock) { assert(!pthread_mutex_lock(lock)); }
static void raw_unlock(pthread_mutex_t *lock) { assert(!pthread_mutex_unlock(lock)); }
#define spin_lock_irqsave(lock, flags) do { (flags) = 0; raw_lock(lock); } while (0)
#define spin_unlock_irqrestore(lock, flags) do { (void)(flags); raw_unlock(lock); } while (0)
#define spin_lock_init(lock) do { assert(!pthread_mutex_init(lock, NULL)); } while (0)
static void mutex_lock(struct mutex *lock) { raw_lock(&lock->raw); }
static void mutex_unlock(struct mutex *lock) { raw_unlock(&lock->raw); }
static void refcount_set(refcount_t *value, unsigned int count) { *value = count; }
static bool refcount_dec_and_test(refcount_t *value)
{
	assert(*value);
	return --*value == 0;
}
static void *kzalloc(size_t size, unsigned int flags)
{
	assert(flags == GFP_KERNEL);
	return calloc(1, size);
}
static void kfree(void *p) { free(p); }
static void put_net(struct net *net)
{
	assert(net->references);
	net->references--;
}
static void put_pid(struct pid *pid)
{
	assert(pid->references);
	pid->references--;
}
static int copy_to_user(void *to, const void *from, size_t size)
{
	memcpy(to, from, size);
	return 0;
}
#define IS_ERR(p) ((uintptr_t)(p) > UINTPTR_MAX - 4095U)
#define PTR_ERR(p) ((long)(intptr_t)(p))
/* Abort-only unresolved namespace/FD effects. No successful owner producer is
 * stubbed into the test: CUT-before-CREATE must refuse before these calls. */
static struct net *tako_terminal_new_net(struct tako_terminal_owner *owner)
{
	(void)owner;
	abort();
}
static int tako_namespace_fd(struct net *net) { (void)net; abort(); }

#include TAKO_ADMISSION_DRIVER_FILE

static unsigned long checks;
#define CHECK(expr) do { assert(expr); checks++; } while (0)
struct fixture {
	struct tako_terminal_owner *owner;
	struct tako_terminal_file *ctx;
	struct file file;
	struct net net;
};
static void fixture_init(struct fixture *f)
{
	memset(f, 0, sizeof(*f));
	f->owner = calloc(1, sizeof(*f->owner));
	f->ctx = calloc(1, sizeof(*f->ctx));
	assert(f->owner && f->ctx);
	spin_lock_init(&f->owner->lock);
	assert(!pthread_mutex_init(&f->ctx->lock.raw, NULL));
	f->owner->refs = 2; /* Raw independent ledger ref remains after file close. */
	tako_terminal_state_init(&f->owner->state);
	tako_terminal_state_init(&f->owner->requests);
	tako_terminal_state_init(&f->owner->timewait);
	tako_terminal_state_init(&f->owner->packet_groups);
#ifdef TAKO_TERMINAL_DEVICE_ORIGINS
	tako_terminal_state_init(&f->owner->device_associations);
#endif
	tako_terminal_admission_init(&f->owner->admission);
	tako_terminal_lifetime_born(&f->owner->lifetime);
	f->owner->net_cookie = f->net.net_cookie = 23;
	f->owner->namespace_inum = f->net.ns.inum = 29;
	f->net.tako_terminal = f->owner;
	f->net.references = 2;
	f->ctx->owner = f->owner;
	f->ctx->net = &f->net;
	f->ctx->creator = &original_pid;
	f->ctx->attempted = 1;
	f->file.private_data = f->ctx;
}
static void fixture_dispose(struct fixture *f)
{
	if (f->ctx) {
		assert(!pthread_mutex_destroy(&f->ctx->lock.raw));
		free(f->ctx);
	}
	assert(!pthread_mutex_destroy(&f->owner->lock));
	free(f->owner);
}
static void check_blocked(struct fixture *f, bool expected)
{
	CHECK(tako_terminal_block(&f->net, NFPROTO_IPV4) == expected);
	CHECK(tako_terminal_block(&f->net, NFPROTO_IPV6) == expected);
	CHECK(!tako_terminal_block(&f->net, 0));
}
static void helper_histories(void)
{
	for (unsigned int history = 0; history < 65536U; history++) {
		struct tako_terminal_admission gate;
		struct tako_terminal_state objects;
		unsigned int word = history, open_attempts = 0;
		bool was_cut = false;
		tako_terminal_admission_init(&gate);
		tako_terminal_state_init(&objects);
		CHECK(tako_terminal_admission_blocked(&gate, &objects));
		for (unsigned int step = 0; step < 8; step++) {
			unsigned int event = word & 3U;
			word >>= 2;
			if (event == 0) {
				int opened = tako_terminal_admission_open(&gate, &objects);
				CHECK(opened == (!open_attempts && !was_cut && !objects.sealed && !objects.poisoned));
				open_attempts++;
			} else if (event == 1) {
				tako_terminal_admission_cut(&gate);
				was_cut = true;
			} else if (event == 2) {
				tako_terminal_state_seal(&objects);
			} else {
				tako_terminal_state_put(&objects); /* Actual invalid-free poison. */
			}
			CHECK(!was_cut || (gate.cut && !gate.opened));
			CHECK(!(was_cut || objects.sealed || objects.poisoned) ||
			      tako_terminal_admission_blocked(&gate, &objects));
			CHECK(objects.sockets == 0 && objects.allocations == 0 && objects.releases == 0);
		}
	}
}
static void driver_boundaries(void)
{
	struct fixture f;
	fixture_init(&f);
	check_blocked(&f, true);
	/* Counts do not confer admission or need to be zero to allow it. */
	tako_terminal_state_get(&f.owner->state);
	CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 1) == -EINVAL);
	CHECK(!f.owner->admission.attempted);
	CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0));
	CHECK(f.owner->state.sockets == 1 && f.owner->state.allocations == 1);
	check_blocked(&f, false);
	CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) == -EALREADY);
	CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_CUT, 0));
	check_blocked(&f, true);
	CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) == -EALREADY);
	CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_CUT, 0));
	CHECK(f.owner->state.sockets == 1 && f.owner->state.releases == 0);
	fixture_dispose(&f);

	fixture_init(&f);
	raw_current = &recycled_number_pid; /* Same numeric PID is insufficient. */
	CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) == -EPERM);
	CHECK(!f.owner->admission.attempted);
	raw_current = &original_pid;
	for (unsigned int mask = 0; mask < 3; mask++) {
		capabilities = mask;
		CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) == -EPERM);
	}
	capabilities = 3;
	CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0));
	fixture_dispose(&f);

	for (unsigned int invalid = 0; invalid < 12; invalid++) {
		fixture_init(&f);
		switch (invalid) {
		case 0: tako_terminal_state_put(&f.owner->state); break;
		case 1: tako_terminal_state_seal(&f.owner->state); break;
		case 2: tako_terminal_state_put(&f.owner->requests); break;
		case 3: tako_terminal_state_put(&f.owner->timewait); break;
		case 4: tako_terminal_state_put(&f.owner->packet_groups); break;
		case 5: tako_terminal_lifetime_reference_put(&f.owner->lifetime); break;
		case 6: (void)tako_terminal_lifetime_release_attempt(&f.owner->lifetime); break;
		case 7: f.net.net_cookie++; break;
		case 8: f.net.ns.inum++; break;
		case 9: f.net.tako_terminal = NULL; break;
		case 10: f.ctx->net = NULL; break;
		case 11: f.owner->lifetime.born = 0; break;
		}
		CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) < 0);
		CHECK(!f.owner->admission.opened);
		fixture_dispose(&f);
	}

	for (unsigned int before = 0; before < 2; before++) {
		fixture_init(&f);
		if (!before) CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0));
		CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_RELEASE_NAMESPACE, 0));
		CHECK(f.ctx->net == NULL && f.net.references == 1);
		CHECK(f.owner->lifetime.reference_released == 1);
		CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) == -ENODATA);
		check_blocked(&f, true);
		fixture_dispose(&f);
	}
	fixture_init(&f);
	f.ctx->owner = NULL;
	f.ctx->net = NULL;
	f.ctx->attempted = 0;
	CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) == -ENODATA);
	CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_CUT, 0));
	CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_CREATE, 0) == -EALREADY);
	fixture_dispose(&f);

	fixture_init(&f);
	CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_CUT, 0));
	CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) == -EALREADY);
	fixture_dispose(&f);
	for (unsigned int before = 0; before < 2; before++) {
		fixture_init(&f);
		if (!before) CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0));
		/* Actual close body frees ctx; independent raw ledger ref survives. */
		CHECK(!pthread_mutex_destroy(&f.ctx->lock.raw));
		CHECK(!tako_release(NULL, &f.file));
		f.ctx = NULL;
		CHECK(f.owner->refs == 1 && f.owner->admission.cut);
		check_blocked(&f, true);
		fixture_dispose(&f);
	}
	fixture_init(&f);
	CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0));
	tako_terminal_state_put(&f.owner->packet_groups);
	check_blocked(&f, true);
	CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) < 0);
	fixture_dispose(&f);

#ifdef TAKO_TERMINAL_DEVICE_ORIGINS
	/* The selected NETDEV patch contributes this actual state field. A
	 * device-origin overflow poisons it through the shared real counter;
	 * it cannot be ignored by either OPEN or the packet gate. */
	for (unsigned int before = 0; before < 2; before++) {
		fixture_init(&f);
		if (!before) CHECK(!tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0));
		tako_terminal_state_put(&f.owner->device_associations);
		CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) < 0);
		check_blocked(&f, true);
		fixture_dispose(&f);
	}
#endif
	struct net ordinary = {0};
	CHECK(!tako_terminal_block(&ordinary, NFPROTO_IPV4));
	CHECK(!tako_terminal_block(&ordinary, NFPROTO_IPV6));
}
struct race_call { struct fixture *fixture; unsigned int operation; atomic_int *go; long result; };
static void *race_operation(void *argument)
{
	struct race_call *call = argument;
	while (!atomic_load_explicit(call->go, memory_order_acquire)) sched_yield();
	call->result = tako_ioctl(&call->fixture->file, call->operation, 0);
	return NULL;
}
static void open_vs_cut(void)
{
	for (unsigned int i = 0; i < 128; i++) {
		struct fixture f;
		fixture_init(&f);
		atomic_int go = 0;
		struct race_call open = { &f, TAKO_TERMINAL_OPEN, &go, 99 };
		struct race_call cut = { &f, TAKO_TERMINAL_CUT, &go, 99 };
		pthread_t first, second;
		CHECK(!pthread_create(&first, NULL, race_operation, i & 1U ? &open : &cut));
		CHECK(!pthread_create(&second, NULL, race_operation, i & 1U ? &cut : &open));
		atomic_store_explicit(&go, 1, memory_order_release);
		CHECK(!pthread_join(first, NULL));
		CHECK(!pthread_join(second, NULL));
		CHECK(open.result == 0 || open.result == -EALREADY);
		CHECK(cut.result == 0 && f.owner->admission.cut && !f.owner->admission.opened);
		check_blocked(&f, true);
		CHECK(tako_ioctl(&f.file, TAKO_TERMINAL_OPEN, 0) == -EALREADY);
		fixture_dispose(&f);
	}
}
int main(int argc, char **argv)
{
	if (argc == 1) helper_histories();
	else if (argc != 2 || strcmp(argv[1], "--driver")) abort();
	driver_boundaries();
	open_vs_cut();
	printf("%lu admission helper/actual-driver raw-model checks passed\n", checks);
	return 0;
}
