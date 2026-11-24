#ifndef DOCKER_CONTAINER_TERMINAL_NAMESPACE_H
#define DOCKER_CONTAINER_TERMINAL_NAMESPACE_H

#include <stddef.h>
#include <stdint.h>

/* Birth custody only. This interface provides no admission or retirement grant.
 * No function accepts an existing namespace, PID, path, or workload callback. */
struct tns_owner;
struct tns_identity {
  uint64_t device;
  uint64_t inode;
};

/* *slot must be NULL. The attempt is consumed before the first OS effect.
 * Even failure retains a non-NULL slot; only close may subsequently use it.
 * Caller must serialize this private handle and retain it until close succeeds.
 * Requires SIGCHLD default disposition and exclusive reaping of this child. */
int tns_owner_create(struct tns_owner **slot);
int tns_owner_observe(struct tns_owner *owner, struct tns_identity *identity);
/* Original no-field admission effects, consumed once on the held device open.
 * OPEN raw0 is not serving/current/terminal authority. CUT is permanent; a
 * lost response is retained and never resent. Only an actual same-owner sealed
 * readback permits existing identity/cleanup observations after CUT. */
int tns_owner_open_admission(struct tns_owner *owner);
int tns_owner_cut_admission(struct tns_owner *owner);
/* Fresh same-owner uncut identity observation after its original OPEN effect;
 * still not serving/packet-barrier/terminal authority. */
int tns_owner_admission_current(struct tns_owner *owner);
/* Read the already-pinned original namespace and its custodian after OPEN.
 * Refusal leaves the original owner phase available to its ordinary lifecycle. */
int tns_owner_read_admitted_identity(struct tns_owner *owner, struct tns_identity *identity);
/* Read ONLY this original controller's actual current namespace and compare
 * it to the saved pre-birth creator identity, bookended by original guest
 * custody checks. No namespace/PID/FD/path is accepted or exported. */
int tns_owner_observe_creator(struct tns_owner *owner, struct tns_identity *identity);
/* Private OCI composition only: one-use CLOEXEC loan of this actual owner's
 * verified namespace. No namespace/PID/path is accepted. Failure consumes the
 * loan and closes the owner to further observation; no workload is admitted. */
int tns_owner_dup_namespace(struct tns_owner *owner);
/* Stop/join ONLY the original custodian and its transport. The same opaque
 * owner, held kernel device and NSFS descriptors remain in the controller.
 * No namespace release, terminal predicate or retirement grant is produced. */
int tns_owner_stop_custodian(struct tns_owner *owner);
/* Bounded join. Failure retains the handle for a subsequent close/join only. */
int tns_owner_close(struct tns_owner **slot);

/* Factual snapshot of this original retained kernel ledger only. Even
 * net_gone plus zero counts is not complete flow coverage/terminal authority. */
struct tns_lifetime {
  struct tns_identity identity;
  uint64_t net_cookie;
  uint64_t full_ip_sockets, requests, timewait, packet_groups;
  uint32_t born, release_attempted, reference_released, net_gone, poisoned;
};
/* Private OCI composition only, after its original init has actually been
 * reaped. One attempt, original custodian joined before own NSFS/device-ref
 * release. Failure retains the same owner/ledger FD; never replay RELEASE. */
int tns_owner_release_namespace(struct tns_owner *owner,
                                  struct tns_lifetime *lifetime);
/* Continue only this previously started release's unperformed phases. Never
 * resend a custodian signal, reclose an attempted FD or replay a sent ioctl.
 * A previous close error stays unknown: later progress cannot clear it. */
int tns_owner_continue_namespace_release(struct tns_owner *owner,
                                           struct tns_lifetime *lifetime);
/* Read the same original ledger, including after an unknown release return.
 * Accepts no target/PID/nsFD and does not release, wait, grant or free. */
int tns_owner_observe_lifetime(struct tns_owner *owner,
                                 struct tns_lifetime *lifetime);

/* Original tracked-owner destruction only. BEGIN requires this same owner's
 * original custodian joined/own namespace reference released with no unknown
 * close, and caches real identity/release facts before its sole no-field ioctl.
 * Sent UNKNOWN is never re-BEGINed. READ performs exactly one same-FD no-field
 * observation per call, including after unknown BEGIN; pending/error retains
 * the same handle. No old OBSERVE/LIFETIME is used after BEGIN. BEGIN zero is
 * only acknowledged handoff. READ zero is only actual tracked-owner destruction,
 * never full-flow/Core retirement authority.
 * Caller serializes and retains the original opaque owner on every result. */
int tns_owner_begin_tracked_join(struct tns_owner *owner);
int tns_owner_read_tracked_join(struct tns_owner *owner);

/* Dispose only this original namespace owner's four remaining private FDs
 * (kernel/proc-directory/proc-root/pidfd), after a fresh same-FD tracked READ.
 * Each slot is consumed before close. Any close error is sticky UNKNOWN:
 * retain *slot and continue only still-unattempted closes with this function.
 * No old READ/ioctl is issued after the kernel FD is consumed. After starting,
 * callers MUST NOT return to legacy close or other owner APIs; future OCI
 * binding must preserve this exclusive disposal phase. Zero frees/nulls only
 * this local object after all four known closes; it does not qualify earlier
 * transient/status/control closes, OCI cleanup, slot reuse or terminal. */
int tns_owner_dispose_tracked(struct tns_owner **slot);
/* Selected OCI's released-reference local cleanup only. Original BEGIN's
 * captured release/identity precedes handoff; this does NOT observe completion.
 * Same four consume-before-close slots/UNKNOWN history, exclusive family once
 * started: tracked/generic close cannot erase failure. Zero frees/nulls only
 * local custody, never network/full-traffic/slot/OCI/Core authority. */
int tns_owner_dispose_released(struct tns_owner **slot);

/* Closed internal byte protocol, shared with portable decoder tests.
 * A decoded message is not authority: the constructor verifies its own held
 * pidfd, proc directory, NSFS descriptor, namespace type and actual identity. */
#define TNS_WIRE_SIZE 32u
#define TNS_WIRE_CREATED 1u
#define TNS_WIRE_ERROR 2u
struct tns_wire_message {
  unsigned int kind;
  unsigned int error;
  struct tns_identity identity;
};

enum tns_phase {
  TNS_UNUSED = 0,
  TNS_CREATING = 1,
  TNS_HELD = 2,
  TNS_CLOSING = 3
};

static inline int tns_phase_start(enum tns_phase *phase) {
  if (!phase || *phase != TNS_UNUSED) return -1;
  *phase = TNS_CREATING;
  return 0;
}

static inline int tns_phase_hold(enum tns_phase *phase) {
  if (!phase || *phase != TNS_CREATING) return -1;
  *phase = TNS_HELD;
  return 0;
}

static inline int tns_phase_close(enum tns_phase *phase) {
  if (!phase || (*phase != TNS_CREATING && *phase != TNS_HELD &&
                 *phase != TNS_CLOSING)) return -1;
  *phase = TNS_CLOSING;
  return 0;
}

static inline uint64_t tns_wire_u64(const unsigned char *p) {
  uint64_t value = 0;
  for (unsigned int i = 0; i < 8; ++i) value = (value << 8) | p[i];
  return value;
}

static inline int tns_wire_decode(const unsigned char *p, size_t size,
                                  struct tns_wire_message *result) {
  struct tns_wire_message message;
  if (!p || !result || size != TNS_WIRE_SIZE || p[0] != 'T' ||
      p[1] != 'N' || p[2] != 'S' || p[3] != '1' || p[5] || p[6] ||
      p[7] || p[12] || p[13] || p[14] || p[15]) return -1;
  message.kind = p[4];
  message.error = ((unsigned int)p[8] << 24) | ((unsigned int)p[9] << 16) |
                  ((unsigned int)p[10] << 8) | p[11];
  message.identity.device = tns_wire_u64(p + 16);
  message.identity.inode = tns_wire_u64(p + 24);
  if (message.kind == TNS_WIRE_CREATED) {
    if (message.error || !message.identity.device || !message.identity.inode)
      return -1;
  } else if (message.kind == TNS_WIRE_ERROR) {
    if (!message.error || message.error > 4095 || message.identity.device ||
        message.identity.inode) return -1;
  } else {
    return -1;
  }
  *result = message;
  return 0;
}

static inline int tns_identity_equal(const struct tns_identity *a,
                                      const struct tns_identity *b) {
  return a && b && a->device == b->device && a->inode == b->inode;
}

static inline int tns_birth_matches(const struct tns_identity *creator,
                                    const struct tns_wire_message *message,
                                    const struct tns_identity *actual) {
  return creator && actual && message && creator->device && creator->inode &&
         actual->device && actual->inode &&
         message->kind == TNS_WIRE_CREATED && !message->error &&
         tns_identity_equal(&message->identity, actual) &&
         !tns_identity_equal(creator, actual);
}

/* Refusal-only checks of actual syscall results in the native producer. A
 * caller-supplied scalar set cannot create an owner or supply a namespace. */
static inline int tns_kernel_identity_matches(const struct tns_identity *creator,
                                              const struct tns_identity *actual,
                                              uint64_t cookie, uint64_t inode,
                                              uint64_t expected_cookie) {
  return creator && actual && creator->device && creator->inode &&
         actual->device && actual->inode && cookie && inode &&
         inode == actual->inode && !tns_identity_equal(creator, actual) &&
         (!expected_cookie || cookie == expected_cookie);
}

static inline int tns_kernel_counts_consistent(uint64_t live, uint64_t allocations,
                                               uint64_t releases,
                                               unsigned int sealed,
                                               unsigned int poisoned) {
  return !sealed && !poisoned && allocations >= releases &&
         allocations - releases == live;
}

#endif
