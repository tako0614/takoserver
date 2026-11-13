#ifndef DOCKER_CONTAINER_TERMINAL_OCI_H
#define DOCKER_CONTAINER_TERMINAL_OCI_H

#include "docker-container-terminal-namespace.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* Plain private-channel data. These fields cannot adopt a PID/namespace or
 * grant admission. The native producer opens and verifies its own objects. */
struct tns_oci_text { const unsigned char *data; size_t size; };
struct tns_oci_options {
  const char *allocation_root;
  const char *claim_id;
  const char *installation_id;
  const char *resource_uid;
  const char *incarnation_id;
  uint64_t generation;
  const char *revision;
  const char *source_digest;
  const char *manifest_digest;
  const char *config_digest;
  const char *archive_digest;
  const struct tns_oci_text *args;
  size_t argc;
  const struct tns_oci_text *env;
  size_t envc;
  struct tns_oci_text cwd;
  uint32_t uid;
  uint32_t gid;
  uint64_t memory_bytes;
  uint64_t nano_cpus;
  uint32_t pids_limit;
};
struct tns_oci_owner;
struct tns_oci_created {
  char native_id[65];
  uint64_t namespace_device;
  uint64_t namespace_inode;
};
struct tns_oci_init_reaped {
  char native_id[65];
  uint64_t namespace_device, namespace_inode;
  uint64_t pid_namespace_device, pid_namespace_inode;
};
struct tns_oci_started {
  char native_id[65];
  uint64_t namespace_device;
  uint64_t namespace_inode;
};

/* One-use, including unknown failure. Rootfs/runtime verification precedes the
 * internally owned fresh namespace and exact runc CREATE. */
int tns_oci_create(const struct tns_oci_options *options,
                    struct tns_oci_owner **slot);
int tns_oci_observe(struct tns_oci_owner *owner, struct tns_oci_created *created);
/* Same original owner only, one attempt before spawn. Success is an observed
 * executable transition of the same live init plus fresh original namespace;
 * it grants no network admission, serving, terminal or deletion authority.
 * Unknown/lost ACK consumes the attempt and retains the original owner. */
int tns_oci_start(struct tns_oci_owner *owner, struct tns_oci_started *started);
int tns_oci_observe_started(struct tns_oci_owner *owner,
                              struct tns_oci_started *started);
/* Dedicated single-thread subreaper, default SIGCHLD and exclusive exact-child
 * reaping are required before CREATE; the library never changes caller state.
 * STOP consumes one original-init SIGKILL attempt. JOIN can only join/reap that
 * same pinned init after the attempt, including UNKNOWN; it never resends.
 * Reaped is a task/PIDNS fact, never network terminal/delete authority. */
int tns_oci_stop_init(struct tns_oci_owner *owner,
                        struct tns_oci_init_reaped *reaped);
int tns_oci_join_init(struct tns_oci_owner *owner,
                        struct tns_oci_init_reaped *reaped);
/* Cancels/joins the private runtime command. Once runc CREATE was attempted,
 * original custody remains held: this is not a container-delete operation. */
int tns_oci_cancel(struct tns_oci_owner *owner);
/* Negative, monotonic cancellation only; safe for this private helper's signal
 * handler. It cannot reset an attempt or supply physical permission. */
void tns_oci_note_cancel(void);
/* Join the actual command/namespace custodian; keep born OCI/ns/runtime FDs. */
int tns_oci_close_transport(struct tns_oci_owner *owner);
/* Only a proved never-spawned runtime attempt can release this object. */
int tns_oci_release_uncreated(struct tns_oci_owner **slot);

struct tns_oci_namespace_lifetime {
  char native_id[65];
  struct tns_lifetime lifetime;
};
/* Actual init_joined custody is mandatory. Release only this original owner's
 * loan/custodian/namespace reference; keep kernel ledger/runtime/config and
 * opaque owner. No netGone/count/ACK grants network terminal or deletion. */
int tns_oci_release_namespace(struct tns_oci_owner *owner,
                                struct tns_oci_namespace_lifetime *lifetime);
/* Only an existing release attempt may continue its recorded unperformed
 * phases. A previous close UNKNOWN stays retained even after later progress;
 * sent kernel RELEASE is never retried. No new owner or target is accepted. */
int tns_oci_continue_namespace_release(struct tns_oci_owner *owner,
                                         struct tns_oci_namespace_lifetime *lifetime);
/* Read-only factual same-owner ledger after the release attempt, including
 * unknown ACK. Never resend RELEASE or infer complete lifecycle/serving. */
int tns_oci_observe_namespace_lifetime(struct tns_oci_owner *owner,
                                        struct tns_oci_namespace_lifetime *lifetime);

/* Pure closed data primitives; none is an owner or physical result. */
#define TNS_OCI_MAX_JSON 1048576u
#define TNS_OCI_MAX_STRING 131071u
#define TNS_OCI_MAX_ARGS 1024u
#define TNS_OCI_MAX_ENV 1024u
struct tns_oci_json { char *data; size_t size; size_t used; int failed; };

static inline int tns_oci_utf8(struct tns_oci_text text) {
  if ((!text.data && text.size) || text.size > TNS_OCI_MAX_STRING) return -1;
  size_t i = 0;
  while (i < text.size) {
    unsigned int c = text.data[i++];
    if (!c) return -1;
    if (c < 0x80) continue;
    unsigned int count, value, minimum;
    if (c >= 0xc2 && c <= 0xdf) { count = 1; value = c & 0x1f; minimum = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { count = 2; value = c & 0xf; minimum = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { count = 3; value = c & 7; minimum = 0x10000; }
    else return -1;
    if (count > text.size - i) return -1;
    for (unsigned int k = 0; k < count; ++k) {
      c = text.data[i++];
      if ((c & 0xc0) != 0x80) return -1;
      value = (value << 6) | (c & 0x3f);
    }
    if (value < minimum || value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff)) return -1;
  }
  return 0;
}

static inline void tns_oci_append(struct tns_oci_json *out,
                                   const char *data, size_t size) {
  if (!out || out->failed) return;
  if (!out->data || !out->size || out->used >= out->size ||
      size >= out->size - out->used) { out->failed = 1; return; }
  memcpy(out->data + out->used, data, size);
  out->used += size;
  out->data[out->used] = 0;
}

static inline void tns_oci_literal(struct tns_oci_json *out, const char *s) {
  tns_oci_append(out, s, strlen(s));
}

static inline void tns_oci_string(struct tns_oci_json *out,
                                   struct tns_oci_text text) {
  static const char hex[] = "0123456789abcdef";
  if (tns_oci_utf8(text) < 0) { if (out) out->failed = 1; return; }
  tns_oci_literal(out, "\"");
  for (size_t i = 0; i < text.size; ++i) {
    unsigned int c = text.data[i];
    if (c == 8 || c == 9 || c == 10 || c == 12 || c == 13) {
      char escaped[2] = {'\\', c == 8 ? 'b' : c == 9 ? 't' :
                                c == 10 ? 'n' : c == 12 ? 'f' : 'r'};
      tns_oci_append(out, escaped, sizeof(escaped));
    } else if (c < 0x20) {
      char escaped[6] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 15]};
      tns_oci_append(out, escaped, sizeof(escaped));
    } else if (c == '"' || c == '\\') {
      char escaped[2] = {'\\', (char)c};
      tns_oci_append(out, escaped, sizeof(escaped));
    } else {
      char byte = (char)c;
      tns_oci_append(out, &byte, 1);
    }
  }
  tns_oci_literal(out, "\"");
}

static inline int tns_oci_claim(const char *claim) {
  if (!claim || strlen(claim) != 64) return -1;
  for (size_t i = 0; i < 64; ++i)
    if (!((claim[i] >= '0' && claim[i] <= '9') ||
          (claim[i] >= 'a' && claim[i] <= 'f'))) return -1;
  return 0;
}

static inline int tns_oci_data(const struct tns_oci_options *options) {
  if (!options || tns_oci_claim(options->claim_id) < 0 || !options->args ||
      !options->argc || options->argc > TNS_OCI_MAX_ARGS ||
      options->envc > TNS_OCI_MAX_ENV || (!options->env && options->envc) ||
      !options->args[0].size || !options->cwd.size ||
      options->cwd.size > 4095 || !options->cwd.data || options->cwd.data[0] != '/' ||
      tns_oci_utf8(options->cwd) < 0 || !options->memory_bytes ||
      options->memory_bytes > UINT64_C(9007199254740991) ||
      options->nano_cpus < UINT64_C(10000000) ||
      options->nano_cpus > UINT64_C(9007199254740991) ||
      !options->pids_limit || options->pids_limit > 2147483647u) return -1;
  size_t total = 0;
  for (size_t i = 0; i < options->argc; ++i) {
    if (tns_oci_utf8(options->args[i]) < 0) return -1;
    total += options->args[i].size;
  }
  for (size_t i = 0; i < options->envc; ++i) {
    struct tns_oci_text text = options->env[i];
    if (tns_oci_utf8(text) < 0) return -1;
    size_t eq = 0;
    while (eq < text.size && text.data[eq] != '=') ++eq;
    if (!eq || eq == text.size) return -1;
    for (size_t j = 0; j < i; ++j) {
      struct tns_oci_text prior = options->env[j];
      if (prior.size > eq && prior.data[eq] == '=' &&
          !memcmp(prior.data, text.data, eq)) return -1;
    }
    total += text.size;
  }
  return total <= TNS_OCI_MAX_JSON / 2 ? 0 : -1;
}

static inline struct tns_oci_text tns_oci_cstring(const char *s) {
  struct tns_oci_text text = {(const unsigned char *)s, s ? strlen(s) : 0};
  return text;
}

static inline int tns_oci_digest(const char *digest) {
  return digest && strlen(digest) == 71 && !memcmp(digest, "sha256:", 7) &&
         tns_oci_claim(digest + 7) == 0 ? 0 : -1;
}

static inline int tns_oci_metadata(const struct tns_oci_options *o) {
  if (!o || tns_oci_claim(o->claim_id) < 0 || !o->generation ||
      o->generation > UINT64_C(9007199254740991)) return -1;
  const char *fields[] = {o->installation_id, o->resource_uid,
                          o->incarnation_id, o->revision};
  for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); ++i) {
    if (!fields[i] || !*fields[i] || strlen(fields[i]) > 1024 ||
        tns_oci_utf8(tns_oci_cstring(fields[i])) < 0) return -1;
  }
  return tns_oci_digest(o->source_digest) || tns_oci_digest(o->manifest_digest) ||
         tns_oci_digest(o->config_digest) || tns_oci_digest(o->archive_digest) ? -1 : 0;
}

static inline void tns_oci_receipt(const struct tns_oci_options *o,
                                    struct tns_oci_json *out) {
  if (tns_oci_metadata(o) < 0) { out->failed = 1; return; }
  const char *keys[] = {"claimId", "installationId", "resourceUid", "incarnationId"};
  const char *values[] = {o->claim_id, o->installation_id, o->resource_uid, o->incarnation_id};
  tns_oci_literal(out, "{\"kind\":\"linux-oci-owned-artifact@1\"");
  for (size_t i = 0; i < 4; ++i) {
    tns_oci_literal(out, ",\""); tns_oci_literal(out, keys[i]);
    tns_oci_literal(out, "\":"); tns_oci_string(out, tns_oci_cstring(values[i]));
  }
  tns_oci_literal(out, ",\"generation\":");
  char digits[20]; size_t used = 0; uint64_t value = o->generation;
  do { digits[used++] = (char)('0' + value % 10); value /= 10; } while (value);
  while (used) tns_oci_append(out, digits + --used, 1);
  const char *tail_keys[] = {"revision", "sourceDigest", "manifestDigest", "configDigest", "archiveDigest"};
  const char *tail_values[] = {o->revision, o->source_digest, o->manifest_digest, o->config_digest, o->archive_digest};
  for (size_t i = 0; i < 5; ++i) {
    tns_oci_literal(out, ",\""); tns_oci_literal(out, tail_keys[i]);
    tns_oci_literal(out, "\":"); tns_oci_string(out, tns_oci_cstring(tail_values[i]));
  }
  tns_oci_literal(out, "}");
}

static inline void tns_oci_number(struct tns_oci_json *out, uint64_t value) {
  char digits[20]; size_t used = 0;
  do { digits[used++] = (char)('0' + value % 10); value /= 10; } while (value);
  while (used) tns_oci_append(out, digits + --used, 1);
}

static inline void tns_oci_bundle(const struct tns_oci_options *o,
                                   const char *root, const char *network,
                                   struct tns_oci_json *out) {
  if (tns_oci_data(o) < 0 || !root || !*root || !network || !*network) {
    out->failed = 1; return;
  }
  tns_oci_literal(out, "{\"ociVersion\":\"1.2.1\",\"root\":{\"path\":");
  tns_oci_string(out, tns_oci_cstring(root));
  tns_oci_literal(out, ",\"readonly\":true},\"process\":{\"terminal\":false,\"user\":{\"uid\":");
  tns_oci_number(out, o->uid); tns_oci_literal(out, ",\"gid\":");
  tns_oci_number(out, o->gid); tns_oci_literal(out, "},\"args\":[");
  for (size_t i = 0; i < o->argc; ++i) {
    if (i) tns_oci_literal(out, ",");
    tns_oci_string(out, o->args[i]);
  }
  tns_oci_literal(out, "],\"env\":[");
  for (size_t i = 0; i < o->envc; ++i) {
    if (i) tns_oci_literal(out, ",");
    tns_oci_string(out, o->env[i]);
  }
  tns_oci_literal(out, "],\"cwd\":"); tns_oci_string(out, o->cwd);
  tns_oci_literal(out, ",\"noNewPrivileges\":true,\"capabilities\":{\"bounding\":[],\"effective\":[],\"inheritable\":[],\"permitted\":[],\"ambient\":[]}},\"mounts\":[{\"destination\":\"/proc\",\"type\":\"proc\",\"source\":\"proc\",\"options\":[\"nosuid\",\"noexec\",\"nodev\"]},{\"destination\":\"/dev\",\"type\":\"tmpfs\",\"source\":\"tmpfs\",\"options\":[\"nosuid\",\"strictatime\",\"mode=755\",\"size=65536k\"]},{\"destination\":\"/tmp\",\"type\":\"tmpfs\",\"source\":\"tmpfs\",\"options\":[\"nosuid\",\"nodev\",\"mode=1777\"]}],\"linux\":{\"resources\":{\"memory\":{\"limit\":");
  tns_oci_number(out, o->memory_bytes);
  tns_oci_literal(out, "},\"cpu\":{\"period\":100000,\"quota\":");
  tns_oci_number(out, o->nano_cpus / 10000);
  tns_oci_literal(out, "},\"pids\":{\"limit\":"); tns_oci_number(out, o->pids_limit);
  tns_oci_literal(out, "}},\"namespaces\":[{\"type\":\"pid\"},{\"type\":\"ipc\"},{\"type\":\"uts\"},{\"type\":\"mount\"},{\"type\":\"network\",\"path\":");
  tns_oci_string(out, tns_oci_cstring(network));
  tns_oci_literal(out, "}]}}");
}

static inline int tns_oci_once(unsigned int *attempt) {
  if (!attempt || *attempt) return -1;
  *attempt = 1;
  return 0;
}

/* PID text is accepted only from the actual runtime's exclusive private file,
 * followed by original pidfd/namespace/executable checks in the native owner. */
static inline int tns_oci_pid(const unsigned char *p, size_t size) {
  if (!p || !size || size > 11 || p[0] < '1' || p[0] > '9') return -1;
  if (p[size - 1] == '\n') --size;
  if (!size || size > 10) return -1;
  uint64_t value = 0;
  for (size_t i = 0; i < size; ++i) {
    if (p[i] < '0' || p[i] > '9') return -1;
    value = value * 10 + p[i] - '0';
    if (value > UINT64_C(2147483647)) return -1;
  }
  return (int)value;
}

#endif
