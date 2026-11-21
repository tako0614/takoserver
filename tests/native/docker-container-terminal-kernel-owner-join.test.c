/* SPDX-License-Identifier: GPL-2.0-only */
/* New portable raw-boundary model only. No real file, namespace, kernel,
 * device, socket or ioctl is opened. Generated bodies are exact formal18+
 * overlay and official v6.12 completion bodies, supplied by the source packet.
 * Raw pthread/heap representations are not a kernel ABI or runtime proof.
 */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include "../../scripts/native/docker-container-terminal-kernel-state.h"
#include "../../scripts/native/docker-container-terminal-kernel-lifetime.h"
#define cmpxchg(p, old, value) __sync_val_compare_and_swap((p), (old), (value))
#include "../../scripts/native/docker-container-terminal-kernel-netdev-state.h"
#include <owner-join-uapi.inc>

typedef uint64_t u64;
typedef atomic_uint refcount_t;
typedef pthread_mutex_t spinlock_t;
struct mutex { pthread_mutex_t raw; };
struct swait_queue_head { pthread_mutex_t lock; };
struct completion { atomic_uint done; struct swait_queue_head wait; };
struct pid { unsigned int refs; };
struct raw_task { struct pid *pid; bool admin, netadmin; };
struct net;
struct inode { unsigned int unused; };
struct file { void *private_data; };
#include <owner-join-structures.inc>
struct net { struct tako_terminal_owner *tako_terminal; unsigned int refs;
             u64 net_cookie; struct { unsigned int inum; } ns; };
struct sock { struct tako_terminal_owner *sk_tako_terminal; };
struct net_device { struct tako_terminal_device_refs tako_terminal_origins; };
static struct pid original_pid, foreign_pid;
static struct raw_task original_task = { &original_pid, true, true };
static struct raw_task other_task = { &foreign_pid, true, true };
static _Thread_local struct raw_task *current = &original_task;
static atomic_uint checks;
#define CHECK(x) do { checks++; assert(x); } while (0)
#define READ_ONCE(x) atomic_load_explicit(&(x), memory_order_relaxed)
#define GFP_KERNEL 0
#define __user
#define CAP_SYS_ADMIN 1
#define CAP_NET_ADMIN 2
static int init_user_ns;
#define spin_lock_init(p) CHECK(pthread_mutex_init((p), NULL) == 0)
#define spin_lock_irqsave(p, f) do { (f) = 0; CHECK(pthread_mutex_lock(p) == 0); } while (0)
#define spin_unlock_irqrestore(p, f) do { (void)(f); CHECK(pthread_mutex_unlock(p) == 0); } while (0)
#define raw_spin_lock_irqsave spin_lock_irqsave
#define raw_spin_unlock_irqrestore spin_unlock_irqrestore
static void mutex_init(struct mutex *m) { CHECK(!pthread_mutex_init(&m->raw, NULL)); }
static void mutex_lock(struct mutex *m) { CHECK(!pthread_mutex_lock(&m->raw)); }
static void mutex_unlock(struct mutex *m) { CHECK(!pthread_mutex_unlock(&m->raw)); }
static void init_swait_queue_head(struct swait_queue_head *w)
{ CHECK(!pthread_mutex_init(&w->lock, NULL)); }
static void refcount_set(refcount_t *p, unsigned int n) { atomic_init(p, n); }
static void refcount_inc(refcount_t *p)
{ unsigned int n = atomic_fetch_add(p, 1); CHECK(n && n < UINT_MAX); }
static bool refcount_dec_and_test(refcount_t *p)
{ unsigned int n = atomic_fetch_sub(p, 1); CHECK(n); return n == 1; }
static struct pid *task_tgid(struct raw_task *task) { return task->pid; }
static bool ns_capable(const int *ns, int cap)
{ CHECK(ns == &init_user_ns); return cap == CAP_SYS_ADMIN ? current->admin : current->netadmin; }
static struct pid *get_pid(struct pid *p) { p->refs++; return p; }
static void put_pid(struct pid *p) { CHECK(p->refs); p->refs--; }
#define IS_ERR(p) ((uintptr_t)(p) >= (uintptr_t)-4095L)
#define ERR_PTR(n) ((void *)(intptr_t)(n))
#define PTR_ERR(p) ((long)(intptr_t)(p))
static int copy_to_user(void *dst, const void *src, size_t n)
{ if (!dst) return 1; memcpy(dst, src, n); return 0; }

/* Raw allocation/free events, not supplied producer facts. The actual owner
 * destructor must free heap memory before the official complete body wakes.
 */
enum allocation_kind { CTX, OWNER, JOIN };
struct allocation { void *ptr; enum allocation_kind kind; bool live;
                    unsigned int owner_freed, published; };
static struct allocation allocations[1024];
static unsigned int allocation_count, alloc_calls, fail_alloc;
static unsigned int free_owners, free_joins, free_contexts;
static pthread_mutex_t allocation_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t pause_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t pause_cv = PTHREAD_COND_INITIALIZER;
static bool pause_publish, at_publish, allow_publish;
static struct allocation *live_allocation(void *p)
{
    for (unsigned int i = allocation_count; i; i--)
        if (allocations[i-1].ptr == p && allocations[i-1].live) return &allocations[i-1];
    assert(!"unknown/freed raw allocation"); return NULL;
}
static void *kzalloc(size_t size, int flags)
{
    (void)flags; alloc_calls++;
    if (fail_alloc && alloc_calls == fail_alloc) return NULL;
    enum allocation_kind kind;
    if (size == sizeof(struct tako_terminal_file)) kind = CTX;
    else if (size == sizeof(struct tako_terminal_owner)) kind = OWNER;
    else { CHECK(size == sizeof(struct tako_terminal_join)); kind = JOIN; }
    void *p = calloc(1, size); CHECK(p);
    CHECK(!pthread_mutex_lock(&allocation_lock));
    CHECK(allocation_count < 1024);
    allocations[allocation_count++] = (struct allocation){p, kind, true, 0, 0};
    CHECK(!pthread_mutex_unlock(&allocation_lock));
    return p;
}
static void kfree(void *p)
{
    if (!p) return;
    CHECK(!pthread_mutex_lock(&allocation_lock));
    struct allocation *a = live_allocation(p);
    if (a->kind == OWNER) {
        struct tako_terminal_owner *o = p;
        if (o->join) live_allocation(o->join)->owner_freed++;
        CHECK(!pthread_mutex_destroy(&o->lock)); free_owners++;
    } else if (a->kind == JOIN) {
        struct tako_terminal_join *j = p;
        CHECK(a->owner_freed == 1 && a->published == 1);
        CHECK(!atomic_load(&j->refs));
        CHECK(!pthread_mutex_destroy(&j->freed.wait.lock)); free_joins++;
    } else {
        CHECK(!pthread_mutex_destroy(&((struct tako_terminal_file *)p)->lock.raw)); free_contexts++;
    }
    a->live = false;
    free(p); /* actual raw heap free, ASan enabled; no saved owner read later */
    CHECK(!pthread_mutex_unlock(&allocation_lock));
}
static void swake_up_locked(struct swait_queue_head *wait, int flags)
{
    (void)flags;
    struct completion *done = (void *)((char *)wait - offsetof(struct completion, wait));
    struct tako_terminal_join *join = (void *)((char *)done - offsetof(struct tako_terminal_join, freed));
    CHECK(!pthread_mutex_lock(&allocation_lock));
    struct allocation *a = live_allocation(join);
    CHECK(a->owner_freed == 1); /* complete must follow actual owner heap free */
    CHECK(!a->published); a->published++;
    CHECK(!pthread_mutex_unlock(&allocation_lock));
    CHECK(!pthread_mutex_lock(&pause_lock));
    if (pause_publish) {
        at_publish = true; CHECK(!pthread_cond_broadcast(&pause_cv));
        while (!allow_publish) CHECK(!pthread_cond_wait(&pause_cv, &pause_lock));
    }
    CHECK(!pthread_mutex_unlock(&pause_lock));
}
void complete(struct completion *x);
bool completion_done(struct completion *x);
void synchronize_net(void);
#include <owner-join-completion-init.inc>
#include <owner-join-completion.inc>
#include <owner-join-prototypes.inc>
static void put_net(struct net *net);
static int fail_net, fail_namespace_fd;
static struct net *external_net;
static struct net *tako_terminal_new_net(struct tako_terminal_owner *owner)
{
    if (fail_net == 1) return ERR_PTR(-ENOMEM);
    struct net *net = calloc(1, sizeof(*net)); CHECK(net);
    net->refs = 1; net->net_cookie = 0x123456789abcdefULL; net->ns.inum = 12345;
    tako_terminal_net_attach(net, owner);
    if (fail_net == 2) { put_net(net); return ERR_PTR(-ENOMEM); }
    return net;
}
static int tako_namespace_fd(struct net *net)
{
    if (fail_namespace_fd) return -EMFILE;
    CHECK(!external_net); net->refs++; external_net = net;
    return 47; /* raw returned data, not an opened FD or authority */
}
static void put_net(struct net *net)
{
    CHECK(net && net->refs);
    if (--net->refs) return;
    struct tako_terminal_owner *owner = tako_terminal_net_detach(net);
    free(net);
    tako_terminal_net_freed(owner); /* actual saved-owner callback after raw free */
}
static void close_raw_namespace(void)
{ struct net *net = external_net; CHECK(net); external_net = NULL; put_net(net); }
static void might_sleep(void) {}
static bool rtnl_is_locked(void) { return false; }
static void synchronize_rcu(void) {}
static void synchronize_rcu_expedited(void) {}
#include <owner-join-synchronize-net.inc>
#ifndef OWNER_JOIN_DRIVER
#define OWNER_JOIN_DRIVER "owner-join-driver.inc"
#endif
#include OWNER_JOIN_DRIVER

static long io(struct file *f, unsigned int command)
{ return tako_ioctl(f, command, 0); }
static struct file born(void)
{
    struct file f = {0}; CHECK(tako_open(NULL, &f) == 0);
    CHECK(io(&f, TAKO_TERMINAL_CREATE) == 47); return f;
}
static void release_namespace(struct file *f)
{
    CHECK(io(f, TAKO_TERMINAL_CUT) == 0);
    CHECK(io(f, TAKO_TERMINAL_RELEASE_NAMESPACE) == 0);
    CHECK(io(f, TAKO_TERMINAL_RELEASE_NAMESPACE) == -EALREADY);
}
static void close_file(struct file *f)
{ CHECK(tako_release(NULL, f) == 0); f->private_data = NULL; }
static void pending(struct file *f)
{ CHECK(io(f, TAKO_TERMINAL_OWNER_JOIN_READ) == -EAGAIN); }
static void joined(struct file *f)
{
    CHECK(io(f, TAKO_TERMINAL_OWNER_JOIN_READ) == 0);
    CHECK(io(f, TAKO_TERMINAL_OWNER_JOIN_READ) == 0);
}
static void tracked_objects(void)
{
    struct file f = born(); struct tako_terminal_file *ctx = f.private_data;
    struct net *net = ctx->net;
    struct tako_terminal_owner *owner = ctx->owner;
    struct tako_terminal_owner *packet = tako_terminal_packet_reserve(net);
    struct sock *sk = calloc(1, sizeof(*sk)); CHECK(sk);
    tako_terminal_sock_attach(sk, tako_terminal_sock_reserve(net, AF_INET));
    struct net_device *dev = calloc(1, sizeof(*dev)); CHECK(dev);
    tako_terminal_device_record(dev, net);
    tako_terminal_device_record(dev, net); /* actual duplicate unwind */
    struct tako_terminal_observation snapshot;
    CHECK(tako_ioctl(&f, TAKO_TERMINAL_OBSERVE, (unsigned long)&snapshot) == 0);
    CHECK(snapshot.full_ip_sockets == 1);
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == -EBUSY);
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_READ) == -ENODATA);
    release_namespace(&f);
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == 0);
    CHECK(ctx->join_attempted && !ctx->owner && ctx->attempted);
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == -EALREADY);
    unsigned int before = alloc_calls;
    CHECK(io(&f, TAKO_TERMINAL_CREATE) == -EALREADY && before == alloc_calls);
    pending(&f); close_raw_namespace(); pending(&f);
    /* Actual owner survived raw net heap free. Late clone derives only from
     * held original ledger, never a reconstructed net/PID/namespace. */
    CHECK(owner->lifetime.net_gone);
    struct tako_terminal_owner *late = tako_terminal_packet_clone(packet);
    tako_terminal_packet_put(packet); pending(&f);
    struct tako_terminal_owner *saved = tako_terminal_sock_detach(sk);
    free(sk); tako_terminal_sock_put(saved); pending(&f);
    struct tako_terminal_device_refs saved_refs = dev->tako_terminal_origins;
    free(dev); tako_terminal_device_refs_put(&saved_refs); pending(&f);
    unsigned int before_free = free_owners;
    tako_terminal_packet_put(late);
    CHECK(free_owners == before_free + 1); joined(&f);
    CHECK(io(&f, TAKO_TERMINAL_OBSERVE) == -ENODATA);
    CHECK(io(&f, TAKO_TERMINAL_LIFETIME) == -ENODATA);
    close_file(&f);
}
static void snapshot_not_join(void)
{
    struct file f = born(); struct tako_terminal_lifetime_observation life;
    release_namespace(&f); close_raw_namespace();
    CHECK(tako_ioctl(&f, TAKO_TERMINAL_LIFETIME, (unsigned long)&life) == 0);
    CHECK(life.net_gone && !life.full_ip_sockets && !life.packet_groups);
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_READ) == -ENODATA);
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == 0); joined(&f); close_file(&f);
}
static void sticky_cases(void)
{
    for (unsigned int kind = 0; kind < 8; kind++) {
        struct file f = born(); struct tako_terminal_file *ctx = f.private_data;
        struct tako_terminal_owner *o = ctx->owner;
        struct tako_terminal_owner *held = tako_terminal_packet_reserve(ctx->net);
        if (kind == 0) tako_terminal_packet_poison(held);
        if (kind == 1) tako_terminal_device_poison(o);
        if (kind == 2) o->state.poisoned = 1;
        if (kind == 3) o->requests.poisoned = 1;
        if (kind == 4) o->timewait.poisoned = 1;
        if (kind == 5) o->lifetime.poisoned = 1;
        release_namespace(&f); close_raw_namespace();
        CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == 0);
        if (kind == 6) o->namespace_inum++; /* explicit raw identity fault */
        if (kind == 7) o->net_cookie++;
        pending(&f); tako_terminal_packet_put(held);
        CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_READ) == -EUCLEAN);
        CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_READ) == -EUCLEAN);
        close_file(&f);
    }
}
static void guards(void)
{
    struct file empty = {0};
    current = &other_task; other_task.admin = false;
    CHECK(tako_open(NULL, &empty) == -EPERM); other_task.admin = true;
    current = &original_task; CHECK(tako_open(NULL, &empty) == 0);
    CHECK(io(&empty, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == -ENODATA);
    CHECK(io(&empty, TAKO_TERMINAL_OWNER_JOIN_READ) == -ENODATA);
    close_file(&empty);
    struct file f = born(); struct tako_terminal_file *ctx = f.private_data;
    for (unsigned int command = TAKO_TERMINAL_OWNER_JOIN_BEGIN;
         command <= TAKO_TERMINAL_OWNER_JOIN_READ; command++) {
        CHECK(tako_ioctl(&f, command, 1) == -EINVAL);
        current = &other_task; CHECK(io(&f, command) == -EPERM);
        current = &original_task;
        original_task.admin = false; CHECK(io(&f, command) == -EPERM);
        original_task.admin = true; original_task.netadmin = false;
        CHECK(io(&f, command) == -EPERM); original_task.netadmin = true;
    }
    release_namespace(&f); close_raw_namespace();
    ctx->owner->admission.cut = 0;
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == -EUCLEAN);
    CHECK(!ctx->join_attempted && ctx->owner);
    ctx->owner->admission.cut = 1;
    ctx->join->birth_inum++;
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == -EUCLEAN);
    ctx->join->birth_inum--; /* restore injected raw fault only */
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == 0); joined(&f);
    current = &other_task; CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_READ) == -EPERM);
    current = &original_task; joined(&f); close_file(&f);
}
static void failures(void)
{
    for (unsigned int failure = 1; failure <= 3; failure++) {
        struct file f = {0}; fail_alloc = alloc_calls + failure;
        int open_result = tako_open(NULL, &f);
        if (failure == 1) CHECK(open_result == -ENOMEM && !f.private_data);
        else {
            CHECK(open_result == 0); CHECK(io(&f, TAKO_TERMINAL_CREATE) == -ENOMEM);
            CHECK(io(&f, TAKO_TERMINAL_CREATE) == -EALREADY);
            CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == -ENODATA);
            close_file(&f);
        }
        fail_alloc = 0;
    }
    for (int failure = 1; failure <= 2; failure++) {
        struct file f = {0}; CHECK(tako_open(NULL, &f) == 0); fail_net = failure;
        CHECK(io(&f, TAKO_TERMINAL_CREATE) == -ENOMEM); fail_net = 0;
        CHECK(io(&f, TAKO_TERMINAL_CREATE) == -EALREADY);
        CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == -EUCLEAN);
        close_file(&f);
    }
    struct file f = {0}; CHECK(tako_open(NULL, &f) == 0); fail_namespace_fd = 1;
    CHECK(io(&f, TAKO_TERMINAL_CREATE) == -EMFILE); fail_namespace_fd = 0;
    CHECK(io(&f, TAKO_TERMINAL_CREATE) == -EALREADY);
    CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == -EBUSY);
    release_namespace(&f); CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == 0);
    joined(&f); close_file(&f);
}
static void *last_packet_put(void *arg) { tako_terminal_packet_put(arg); return NULL; }
static void close_races(void)
{
    for (unsigned int overlap = 0; overlap < 3; overlap++) {
        struct file f = born(); struct tako_terminal_file *ctx = f.private_data;
        struct tako_terminal_owner *held = tako_terminal_packet_reserve(ctx->net);
        release_namespace(&f); close_raw_namespace();
        if (overlap != 2) CHECK(io(&f, TAKO_TERMINAL_OWNER_JOIN_BEGIN) == 0);
        unsigned int before_free = free_joins;
        if (!overlap || overlap == 2) {
            close_file(&f); CHECK(free_joins == before_free);
            tako_terminal_packet_put(held); CHECK(free_joins == before_free + 1);
        } else {
            CHECK(!pthread_mutex_lock(&pause_lock));
            pause_publish = true; at_publish = allow_publish = false;
            CHECK(!pthread_mutex_unlock(&pause_lock));
            pthread_t thread; CHECK(!pthread_create(&thread, NULL, last_packet_put, held));
            CHECK(!pthread_mutex_lock(&pause_lock));
            while (!at_publish) CHECK(!pthread_cond_wait(&pause_cv, &pause_lock));
            CHECK(!pthread_mutex_unlock(&pause_lock));
            /* Publisher holds completion lock, but independent owner-anchor
             * reference prevents file close from freeing completion storage. */
            close_file(&f); CHECK(free_joins == before_free);
            CHECK(!pthread_mutex_lock(&pause_lock)); allow_publish = true;
            CHECK(!pthread_cond_broadcast(&pause_cv)); CHECK(!pthread_mutex_unlock(&pause_lock));
            CHECK(!pthread_join(thread, NULL)); CHECK(free_joins == before_free + 1);
            pause_publish = false;
        }
    }
}
int main(void)
{
    CHECK(sizeof(struct tako_terminal_observation) == 48);
    CHECK(sizeof(struct tako_terminal_lifetime_observation) == 72);
    CHECK(sizeof(struct tako_terminal_owner) != sizeof(struct tako_terminal_file));
    CHECK(sizeof(struct tako_terminal_owner) != sizeof(struct tako_terminal_join));
    CHECK(sizeof(struct tako_terminal_file) != sizeof(struct tako_terminal_join));
    tracked_objects(); snapshot_not_join(); sticky_cases(); guards(); failures(); close_races();
    CHECK(!external_net && !original_pid.refs && !foreign_pid.refs);
    for (unsigned int i = 0; i < allocation_count; i++) CHECK(!allocations[i].live);
    CHECK(free_owners && free_joins && free_contexts);
    printf("PASS %u raw checks; owner frees=%u anchor frees=%u contexts=%u\n",
           checks, free_owners, free_joins, free_contexts);
    return 0;
}
