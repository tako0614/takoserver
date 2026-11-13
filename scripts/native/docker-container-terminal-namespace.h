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
/* Private OCI composition only: one-use CLOEXEC loan of this actual owner's
 * verified namespace. No namespace/PID/path is accepted. Failure consumes the
 * loan and closes the owner to further observation; no workload is admitted. */
int tns_owner_dup_namespace(struct tns_owner *owner);
/* Bounded join. Failure retains the handle for a subsequent close/join only. */
int tns_owner_close(struct tns_owner **slot);

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

#endif
