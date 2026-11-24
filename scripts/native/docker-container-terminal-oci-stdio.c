#define _GNU_SOURCE
#include "docker-container-terminal-oci-stdio.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* Dedicated persistent original owner. No mode flag, caller
 * namespace or detached guardian. Only private root-owned stdio is accepted.
 * A born unknown/closed owner stays in this SAME process with its exact FDs. */
static volatile sig_atomic_t interrupted;

static void ocip_interrupt(int signal_number) {
  (void)signal_number;
  interrupted = 1;
  tns_oci_note_cancel();
}

static int64_t ocip_now(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t) < 0) return -1;
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int ocip_private_socket(int fd, int expected_type) {
  int domain = 0, type = 0; socklen_t size = sizeof(domain);
  if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &size) < 0 ||
      size != sizeof(domain) || domain != AF_UNIX) return -1;
  size = sizeof(type);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) < 0 ||
      size != sizeof(type) || type != expected_type) return -1;
  struct ucred peer; size = sizeof(peer);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) < 0 ||
      size != sizeof(peer) || peer.uid != 0 || peer.pid != getppid()) return -1;
  return 0;
}

static int ocip_private_channel(int fd) {
  struct stat st;
  if (fstat(fd, &st) < 0 || st.st_uid != 0) return -1;
  if (S_ISFIFO(st.st_mode)) return tns_ocip_private_fifo(st.st_mode, st.st_uid) ? 0 : -1;
  return S_ISSOCK(st.st_mode) ? ocip_private_socket(fd, SOCK_STREAM) : -1;
}

/* The tracked P gives this single H a dedicated packet socket. Its requests
 * never enter the mutation decoder and its replies never enter H stdout. */
enum { OCIP_LIVE_INIT_FD = 4, OCIP_LIVE_INIT_REPLY = 88, OCIP_LIVE_INIT_TIMEOUT = 1000 };
static const unsigned char ocip_live_init_request[] = "TKOLIVE1";
static const unsigned char ocip_live_init_ok[] = "TKOLIVR1";
static const unsigned char ocip_live_init_refused[] = "TKOLIVN1";
static const unsigned char ocip_live_init_descriptor_request[] = "TKOLIVE2";

static int ocip_live_init_channel(int fd) {
  struct stat st;
  if (fstat(fd, &st) < 0 || st.st_uid || !S_ISSOCK(st.st_mode) ||
      ocip_private_socket(fd, SOCK_SEQPACKET) < 0) return -1;
  return fcntl(fd, F_SETFD, FD_CLOEXEC);
}

static int ocip_live_init_read(int fd, struct tns_oci_owner *owner, int unavailable) {
  unsigned char request[sizeof(ocip_live_init_request) - 1];
  ssize_t n = recv(fd, request, sizeof(request), MSG_DONTWAIT | MSG_TRUNC);
  if (n != (ssize_t)sizeof(request)) return -1;
  if (!memcmp(request, ocip_live_init_descriptor_request, sizeof(request)))
    return tns_ocip_reply_live_init_descriptor(fd, owner, unavailable, &interrupted);
  if (memcmp(request, ocip_live_init_request, sizeof(request))) return -1;
  unsigned char reply[OCIP_LIVE_INIT_REPLY];
  const size_t tag = sizeof(ocip_live_init_ok) - 1;
  struct tns_oci_started observed;
  size_t size = tag;
  if (unavailable || interrupted || !owner || tns_oci_read_live_init(owner, &observed) < 0 ||
      interrupted || observed.native_id[64] || tns_oci_claim(observed.native_id) < 0 ||
      !observed.namespace_device || !observed.namespace_inode) {
    memcpy(reply, ocip_live_init_refused, tag);
  } else {
    memcpy(reply, ocip_live_init_ok, tag);
    memcpy(reply + tag, observed.native_id, 64);
    ocipp_put64(reply + 72, observed.namespace_device);
    ocipp_put64(reply + 80, observed.namespace_inode);
    size = sizeof(reply);
  }
  return send(fd, reply, size, MSG_DONTWAIT | MSG_NOSIGNAL) == (ssize_t)size ? 0 : -1;
}

/* Until stdio is ready, service only complete packets from the original P.
 * Auxiliary read loss leaves the existing stdio/retirement lifecycle intact. */
static void ocip_live_init_wait(int *fd, struct tns_oci_owner *owner, int unavailable) {
  while (*fd >= 0 && !interrupted) {
    struct pollfd events[] = {{.fd = 0, .events = POLLIN}, {.fd = *fd, .events = POLLIN}};
    int ready = poll(events, 2, -1);
    if (ready < 0 && errno == EINTR) continue;
    if (events[0].revents || interrupted) return;
    if (events[1].revents == POLLIN && !ocip_live_init_read(*fd, owner, unavailable)) continue;
    (void)close(*fd);
    *fd = -1;
  }
}

static int ocip_io(int fd, void *bytes, size_t size, int writing,
                    int allow_eof, int64_t deadline) {
  size_t used = 0;
  while (used < size) {
    if (interrupted) { errno = ECANCELED; return -1; }
    int64_t now = ocip_now(); if (now < 0) return -1;
    if (now >= deadline) { errno = ETIMEDOUT; return -1; }
    struct pollfd p = {.fd = fd, .events = writing ? POLLOUT : POLLIN};
    int n = poll(&p, 1, (int)(deadline - now));
    if (n < 0) return -1;
    if (!n) { errno = ETIMEDOUT; return -1; }
    if ((p.revents & (POLLERR | POLLNVAL)) ||
        !(p.revents & (writing ? POLLOUT : POLLIN | POLLHUP))) {
      errno = EPIPE; return -1;
    }
    ssize_t count = writing ? write(fd, (unsigned char *)bytes + used, size - used) :
                              read(fd, (unsigned char *)bytes + used, size - used);
    if (count < 0) return -1;
    if (!count) {
      if (!writing && !used && allow_eof) return 1;
      errno = EPROTO; return -1;
    }
    used += (size_t)count;
  }
  return 0;
}

static int ocip_read(unsigned char **body, uint32_t *size) {
  struct pollfd p = {.fd = 0, .events = POLLIN};
  if (interrupted) { errno = ECANCELED; return -1; }
  int n = poll(&p, 1, -1);
  if (n < 0) return -1;
  if (!(p.revents & (POLLIN | POLLHUP))) { errno = EPROTO; return -1; }
  int64_t now = ocip_now(); if (now < 0) return -1;
  int64_t deadline = now + 4000;
  unsigned char prefix[4];
  n = ocip_io(0, prefix, sizeof(prefix), 0, 1, deadline);
  if (n) return n;
  if (tns_ocip_frame(prefix, size) < 0) { errno = EPROTO; return -1; }
  *body = calloc(1, (size_t)*size + 1);
  if (!*body) return -1;
  return ocip_io(0, *body, *size, 0, 0, deadline);
}

static int ocip_reply(const char *body) {
  size_t length = strlen(body);
  if (!length || length > TNS_OCI_MAX_JSON) { errno = EOVERFLOW; return -1; }
  uint32_t size = (uint32_t)length;
  unsigned char prefix[4] = {(unsigned char)(size >> 24), (unsigned char)(size >> 16),
                            (unsigned char)(size >> 8), (unsigned char)size};
  int64_t now = ocip_now(); if (now < 0) return -1;
  if (ocip_io(1, prefix, sizeof(prefix), 1, 0, now + 4000) < 0) return -1;
  return ocip_io(1, (void *)body, length, 1, 0, now + 4000);
}

static int ocip_cleanup(struct tns_oci_owner **owner) {
  if (!*owner) return 0;
  int saved = 0;
  if (tns_oci_close_transport(*owner) < 0) saved = errno;
  if (tns_oci_release_uncreated(owner) < 0 && errno != EBUSY && !saved) saved = errno;
  return saved;
}

static int ocip_error(const char *kind, const char *stage, int error,
                       struct tns_oci_owner *owner) {
  char bytes[256];
  int n = snprintf(bytes, sizeof(bytes),
    "{\"kind\":\"%s\",\"stage\":\"%s\",\"errno\":%d,\"custody\":\"%s\",\"barrier\":\"unproven\"}",
    kind, stage, error, owner ? "retained" : "released-uncreated");
  if (n < 0 || (size_t)n >= sizeof(bytes)) { errno = EOVERFLOW; return -1; }
  return ocip_reply(bytes);
}

static int ocip_observed(const char *kind, struct tns_oci_owner *owner) {
  struct tns_oci_created observation;
  if (tns_oci_observe(owner, &observation) < 0) return -1;
  if (!observation.namespace_device || !observation.namespace_inode ||
      observation.namespace_device > UINT64_C(9007199254740991) ||
      observation.namespace_inode > UINT64_C(9007199254740991)) { errno = EOVERFLOW; return -1; }
  char bytes[384];
  int n = snprintf(bytes, sizeof(bytes),
    "{\"kind\":\"%s\",\"nativeId\":\"%s\",\"namespaceDevice\":%" PRIu64
    ",\"namespaceInode\":%" PRIu64 ",\"barrier\":\"unproven\"}",
    kind, observation.native_id, observation.namespace_device, observation.namespace_inode);
  if (n < 0 || (size_t)n >= sizeof(bytes)) { errno = EOVERFLOW; return -1; }
  return ocip_reply(bytes) < 0 ? -2 : 0; /* Lost reply is never followed by a retry frame. */
}

static int ocip_started(const char *kind, struct tns_oci_owner *owner, int begin) {
  struct tns_oci_started observation;
  int result = begin ? tns_oci_start(owner, &observation) :
                       tns_oci_observe_started(owner, &observation);
  if (result < 0) return -1;
  if (!observation.namespace_device || !observation.namespace_inode ||
      observation.namespace_device > UINT64_C(9007199254740991) ||
      observation.namespace_inode > UINT64_C(9007199254740991)) { errno = EOVERFLOW; return -1; }
  char bytes[384];
  int n = snprintf(bytes, sizeof(bytes),
    "{\"kind\":\"%s\",\"nativeId\":\"%s\",\"namespaceDevice\":%" PRIu64
    ",\"namespaceInode\":%" PRIu64 ",\"barrier\":\"unproven\"}",
    kind, observation.native_id, observation.namespace_device, observation.namespace_inode);
  if (n < 0 || (size_t)n >= sizeof(bytes)) { errno = EOVERFLOW; return -1; }
  return ocip_reply(bytes) < 0 ? -2 : 0;
}

static int ocip_init_reaped(const char *kind, struct tns_oci_owner *owner, int stop) {
  struct tns_oci_init_reaped observation;
  int result = stop ? tns_oci_stop_init(owner, &observation) :
                      tns_oci_join_init(owner, &observation);
  if (result < 0) return -1;
  uint64_t identities[] = {observation.namespace_device, observation.namespace_inode,
    observation.pid_namespace_device, observation.pid_namespace_inode};
  for (size_t i = 0; i < sizeof(identities) / sizeof(identities[0]); ++i)
    if (!identities[i] || identities[i] > UINT64_C(9007199254740991)) {
      errno = EOVERFLOW; return -1;
    }
  char bytes[512];
  int n = snprintf(bytes, sizeof(bytes),
    "{\"kind\":\"%s\",\"nativeId\":\"%s\",\"namespaceDevice\":%" PRIu64
    ",\"namespaceInode\":%" PRIu64 ",\"pidNamespaceDevice\":%" PRIu64
    ",\"pidNamespaceInode\":%" PRIu64 ",\"barrier\":\"unproven\"}",
    kind, observation.native_id, observation.namespace_device, observation.namespace_inode,
    observation.pid_namespace_device, observation.pid_namespace_inode);
  if (n < 0 || (size_t)n >= sizeof(bytes)) { errno = EOVERFLOW; return -1; }
  return ocip_reply(bytes) < 0 ? -2 : 0;
}

/* These markers serialize private requests only. The opaque producer owns
 * actual init/task/release phases and sticky UNKNOWN; readback grants none. */
struct ocip_namespace_state { int entered, release_requested, unusable; };

static const char *ocip_namespace_stage(enum tns_ocip_kind kind) {
  switch (kind) {
    case TNS_OCIP_RELEASE_NAMESPACE: return "release-namespace";
    case TNS_OCIP_CONTINUE_NAMESPACE_RELEASE: return "continue-namespace-release";
    case TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME: return "observe-namespace-lifetime";
    default: return NULL;
  }
}

static int ocip_namespace_encode(enum tns_ocip_kind kind,
                                   const struct tns_oci_namespace_lifetime *observed,
                                   char *bytes, size_t size) {
  const char *reply;
  switch (kind) {
    case TNS_OCIP_RELEASE_NAMESPACE: reply = "linux-oci-namespace-release-observation@1"; break;
    case TNS_OCIP_CONTINUE_NAMESPACE_RELEASE: reply = "linux-oci-namespace-release-continuation@1"; break;
    case TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME: reply = "linux-oci-namespace-lifetime-observation@1"; break;
    default: errno = EPROTO; return -1;
  }
  if (!observed || !bytes || !size || observed->native_id[64] ||
      tns_oci_claim(observed->native_id) < 0) { errno = EPROTO; return -1; }
  const struct tns_lifetime *o = &observed->lifetime;
  if (!o->identity.device || !o->identity.inode ||
      o->identity.device > UINT64_C(9007199254740991) ||
      o->identity.inode > UINT64_C(9007199254740991)) { errno = EOVERFLOW; return -1; }
  if (!o->net_cookie || o->born != 1 || o->release_attempted > 1 ||
      o->reference_released > 1 || o->net_gone > 1 || o->poisoned > 1 ||
      (o->reference_released && !o->release_attempted) ||
      (o->net_gone && !o->release_attempted)) { errno = EPROTO; return -1; }
  int n = snprintf(bytes, size,
    "{\"kind\":\"%s\",\"nativeId\":\"%s\",\"namespaceDevice\":%" PRIu64
    ",\"namespaceInode\":%" PRIu64 ",\"netCookie\":\"%" PRIu64
    "\",\"fullIpSockets\":\"%" PRIu64 "\",\"requests\":\"%" PRIu64
    "\",\"timewait\":\"%" PRIu64 "\",\"packetGroups\":\"%" PRIu64
    "\",\"born\":%" PRIu32 ",\"releaseAttempted\":%" PRIu32
    ",\"referenceReleased\":%" PRIu32 ",\"netGone\":%" PRIu32
    ",\"poisoned\":%" PRIu32 ",\"barrier\":\"unproven\"}",
    reply, observed->native_id, o->identity.device, o->identity.inode,
    o->net_cookie, o->full_ip_sockets, o->requests, o->timewait, o->packet_groups,
    o->born, o->release_attempted, o->reference_released, o->net_gone, o->poisoned);
  if (n < 0 || (size_t)n >= size) { errno = EOVERFLOW; return -1; }
  return 0;
}

/* -1 is an operation-bound retained refusal; -2 is lost framing; -3 is a
 * hard request/codec refusal. None retries a physical producer or a reply. */
static int ocip_namespace_command(enum tns_ocip_kind kind, struct tns_oci_owner *owner,
                                    struct ocip_namespace_state *state) {
  if (!state || !owner || state->unusable || !ocip_namespace_stage(kind)) {
    errno = EPROTO; return -3;
  }
  state->entered = 1;
  if (interrupted) { state->unusable = 1; errno = ECANCELED; return -2; }
  struct tns_oci_namespace_lifetime observed;
  int result;
  if (kind == TNS_OCIP_RELEASE_NAMESPACE) {
    if (state->release_requested) { errno = EALREADY; return -1; }
    state->release_requested = 1; /* Spent request before the actual original call. */
    result = tns_oci_release_namespace(owner, &observed);
  } else {
    if (!state->release_requested) { state->unusable = 1; errno = EPROTO; return -3; }
    if (kind == TNS_OCIP_CONTINUE_NAMESPACE_RELEASE)
      result = tns_oci_continue_namespace_release(owner, &observed);
    else result = tns_oci_observe_namespace_lifetime(owner, &observed);
  }
  if (interrupted) { state->unusable = 1; errno = ECANCELED; return -2; }
  if (result < 0) return -1;
  if (result) { state->unusable = 1; errno = EPROTO; return -3; }
  char bytes[1024];
  if (ocip_namespace_encode(kind, &observed, bytes, sizeof(bytes)) < 0) {
    state->unusable = 1; return -3;
  }
  if (ocip_reply(bytes) < 0) { state->unusable = 1; return -2; }
  return 0;
}

static int ocip_namespace_retained_error(struct ocip_namespace_state *state,
                                          const char *stage) {
  if (state->entered && !state->unusable &&
      (!strcmp(stage, "release-namespace") || !strcmp(stage, "continue-namespace-release") ||
       !strcmp(stage, "observe-namespace-lifetime"))) return 1;
  if (strcmp(stage, "stop-init") && strcmp(stage, "join-init")) state->unusable = 1;
  return 0;
}

/* Routing markers never replace the opaque producers' actual phase facts.
 * Once entered, no old observation or generic cleanup may use retired FDs. */
struct ocip_retirement_state {
  int entered, unusable, begin_requested, read_known;
  int delete_requested, delete_known, dispose_requested, disposed;
  int runtime_first, begin_known; /* fixed H mode / actual handoff zero only */
};

static const char *ocip_retirement_stage(enum tns_ocip_kind kind) {
  switch (kind) {
    case TNS_OCIP_BEGIN_TRACKED_JOIN: return "begin-tracked-join";
    case TNS_OCIP_READ_TRACKED_JOIN: return "read-tracked-join";
    case TNS_OCIP_DELETE_BORN: return "delete-born";
    case TNS_OCIP_JOIN_BORN_DELETE: return "join-born-delete";
    case TNS_OCIP_DISPOSE_BORN: return "dispose-born";
    case TNS_OCIP_CONTINUE_BORN_DISPOSAL: return "continue-born-disposal";
    default: return NULL;
  }
}

static int ocip_retirement_reply(enum tns_ocip_kind kind) {
  const char *reply;
  switch (kind) {
    case TNS_OCIP_BEGIN_TRACKED_JOIN: reply = "linux-oci-tracked-join-handoff@1"; break;
    case TNS_OCIP_READ_TRACKED_JOIN: reply = "linux-oci-tracked-owner-destruction@1"; break;
    case TNS_OCIP_DELETE_BORN: reply = "linux-oci-born-delete-observation@1"; break;
    case TNS_OCIP_JOIN_BORN_DELETE: reply = "linux-oci-born-delete-join-observation@1"; break;
    case TNS_OCIP_DISPOSE_BORN: reply = "linux-oci-local-disposal@1"; break;
    case TNS_OCIP_CONTINUE_BORN_DISPOSAL: reply = "linux-oci-local-disposal-continuation@1"; break;
    default: errno = EPROTO; return -1;
  }
  char bytes[160];
  int n = snprintf(bytes, sizeof(bytes), "{\"kind\":\"%s\",\"barrier\":\"unproven\"}", reply);
  if (n < 0 || (size_t)n >= sizeof(bytes)) { errno = EOVERFLOW; return -1; }
  return ocip_reply(bytes);
}

/* Same -1/-2/-3 meanings as namespace commands; 1 additionally means actual
 * local disposal nullified the original slot and its final reply was written.
 * BEGIN zero acknowledges handoff only. READ zero is tracked destruction only.
 * Neither these facts nor local disposal qualifies full traffic or retirement. */
static int ocip_retirement_command(enum tns_ocip_kind kind,
                                    struct tns_oci_owner **owner,
                                    const struct ocip_namespace_state *ns,
                                    struct ocip_retirement_state *state) {
  if (!state || !owner || !*owner || state->unusable || state->disposed ||
      !ocip_retirement_stage(kind)) { errno = EPROTO; return -3; }
  state->entered = 1;
  if (interrupted) { state->unusable = 1; errno = ECANCELED; return -2; }
  int result;
  if (state->dispose_requested && kind != TNS_OCIP_CONTINUE_BORN_DISPOSAL &&
      kind != TNS_OCIP_DISPOSE_BORN) goto wrong_order;
  if (state->delete_requested && !state->dispose_requested &&
      kind != TNS_OCIP_JOIN_BORN_DELETE && kind != TNS_OCIP_DELETE_BORN &&
      kind != TNS_OCIP_DISPOSE_BORN) goto wrong_order;
  if (kind == TNS_OCIP_BEGIN_TRACKED_JOIN) {
    if (state->begin_requested) { errno = EALREADY; return -1; }
    if (!ns || !ns->release_requested || ns->unusable) goto wrong_order;
    state->begin_requested = 1;
    result = tns_oci_begin_tracked_join(*owner);
  } else if (kind == TNS_OCIP_READ_TRACKED_JOIN) {
    if (!state->begin_requested || state->dispose_requested) goto wrong_order;
    result = tns_oci_read_tracked_join(*owner);
    if (!result) state->read_known = 1;
  } else if (kind == TNS_OCIP_DELETE_BORN) {
    if (state->dispose_requested) goto wrong_order;
    if (state->delete_requested) { errno = EALREADY; return -1; }
    if (!state->read_known) goto wrong_order;
    state->delete_requested = 1;
    result = tns_oci_delete_born(*owner);
    if (!result) state->delete_known = 1;
  } else if (kind == TNS_OCIP_JOIN_BORN_DELETE) {
    if (!state->delete_requested || state->dispose_requested) goto wrong_order;
    result = tns_oci_join_born_delete(*owner);
    if (!result) state->delete_known = 1;
  } else {
    if (kind == TNS_OCIP_DISPOSE_BORN) {
      if (state->dispose_requested) { errno = EALREADY; return -1; }
      if (!state->delete_known) goto wrong_order;
      state->dispose_requested = 1;
    } else if (!state->dispose_requested) goto wrong_order;
    result = tns_oci_dispose_born(owner); /* Actual slot, never a copy alias. */
    if (!result && !*owner) state->disposed = 1;
  }
  if (interrupted) { state->unusable = 1; errno = ECANCELED; return -2; }
  if (result < 0) return -1;
  if (result || (state->dispose_requested && !state->disposed)) goto wrong_order;
  if (ocip_retirement_reply(kind) < 0) { state->unusable = 1; return -2; }
  return state->disposed ? 1 : 0;
wrong_order:
  state->unusable = 1; errno = EPROTO; return -3;
}

/* EOF/cancel/lost reply only advance genuinely already requested phases.
 * Never BEGIN, DELETE or initial DISPOSE here. Unknown original producers keep
 * their own sticky state: observing/joining never authorizes an effect replay. */
static int ocip_cleanup_routed(struct tns_oci_owner **owner,
                                 struct ocip_retirement_state *state) {
  if (!state->entered) return ocip_cleanup(owner);
  if (state->disposed) return 0;
  if (!*owner) return EPROTO;
  int result = 0;
  if (state->dispose_requested) {
    result = state->runtime_first == 2 ? tns_oci_dispose_selected_runtime(owner) :
                                    tns_oci_dispose_born(owner);
    if (!result && !*owner) state->disposed = 1;
  } else if (state->delete_requested && !state->delete_known) {
    result = state->runtime_first ? tns_oci_join_selected_runtime_delete(*owner) :
                                   tns_oci_join_born_delete(*owner);
    if (!result) state->delete_known = 1;
  } else if (state->begin_requested && !state->read_known) {
    result = tns_oci_read_tracked_join(*owner);
    if (!result) state->read_known = 1;
  }
  return result < 0 ? (errno ? errno : EPROTO) : result ? EPROTO : 0;
}

static _Noreturn void ocip_retain(struct tns_oci_owner **owner,
                                  struct ocip_retirement_state *state) {
  /* Protocol is gone; retain this original process, no fork/detach/rebind.
   * SIGCHLD can finish outstanding owned joins. Signals only request another
   * close/join; retirement only continues original already-requested phases. */
  close(0); close(1); close(2);
  sigset_t blocked, prior;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGCHLD); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGINT);
  sigemptyset(&prior);
  if (sigprocmask(SIG_BLOCK, &blocked, &prior) < 0) {
    /* Unknown signal capability cannot release an existing native owner. */
    for (;;) (void)pause();
  }
  struct sigaction action; memset(&action, 0, sizeof(action));
  action.sa_handler = ocip_interrupt;
  (void)sigaction(SIGCHLD, &action, NULL);
  /* Recheck after blocking notifications: a child may have exited between
   * the caller's last join and this wait. Only original continuations run. */
  (void)ocip_cleanup_routed(owner, state);
  if (state->disposed && !*owner) _exit(0);
  for (;;) {
    interrupted = 0;
    /* Atomic unmask+wait prevents a child-exit notification being lost between
     * the previous join and sleeping. This is owned-child cleanup, no drain. */
    (void)sigsuspend(&prior);
    (void)ocip_cleanup_routed(owner, state);
    if (state->disposed && !*owner) _exit(0);
  }
}

/* The existing argc1 owner below remains the direct H in either invocation. */
#include "docker-container-terminal-oci-parent.h"

/* Runtime-first is a fixed H mode chosen by its original P before CREATE.
 * Old command IDs/replies are reused; old router/default remain unchanged. */
static int ocip_runtime_retirement_command(enum tns_ocip_kind kind,
                                            struct tns_oci_owner **owner,
                                            const struct ocip_namespace_state *ns,
                                            struct ocip_retirement_state *state) {
  if (!state || !state->runtime_first || !owner || !*owner || state->unusable || state->disposed ||
      !ocip_retirement_stage(kind)) { errno = EPROTO; return -3; }
  state->entered = 1;
  if (interrupted) { state->unusable = 1; errno = ECANCELED; return -2; }
  int result;
  if (state->dispose_requested && kind != TNS_OCIP_CONTINUE_BORN_DISPOSAL)
    goto wrong_order;
  if (kind == TNS_OCIP_DELETE_BORN) {
    if (state->delete_requested) { errno = EALREADY; return -1; }
    if (!ns || !ns->release_requested || ns->unusable || state->begin_requested)
      goto wrong_order;
    state->delete_requested = 1;
    result = tns_oci_delete_selected_runtime(*owner);
    if (!result) state->delete_known = 1;
  } else if (kind == TNS_OCIP_JOIN_BORN_DELETE) {
    if (!state->delete_requested || state->begin_requested || state->dispose_requested)
      goto wrong_order;
    result = tns_oci_join_selected_runtime_delete(*owner);
    if (!result) state->delete_known = 1;
  } else if (kind == TNS_OCIP_BEGIN_TRACKED_JOIN) {
    if (state->begin_requested) { errno = EALREADY; return -1; }
    if (!state->delete_known || !ns || !ns->release_requested || ns->unusable)
      goto wrong_order;
    state->begin_requested = 1;
    result = tns_oci_begin_tracked_join(*owner);
    if (!result) state->begin_known = 1;
  } else if (kind == TNS_OCIP_READ_TRACKED_JOIN) {
    if (!state->begin_requested || state->dispose_requested) goto wrong_order;
    result = tns_oci_read_tracked_join(*owner);
    if (!result) state->read_known = 1;
  } else {
    if (kind == TNS_OCIP_DISPOSE_BORN) {
      if (state->dispose_requested) { errno = EALREADY; return -1; }
      if (!state->delete_known || (state->runtime_first == 2 ? !state->begin_known : !state->read_known)) goto wrong_order;
      state->dispose_requested = 1;
    } else if (!state->dispose_requested) goto wrong_order;
    result = state->runtime_first == 2 ? tns_oci_dispose_selected_runtime(owner) :
                                       tns_oci_dispose_born(owner);
    if (!result && !*owner) state->disposed = 1;
  }
  if (interrupted) { state->unusable = 1; errno = ECANCELED; return -2; }
  if (result < 0) return -1;
  if (result || (state->dispose_requested && !state->disposed)) goto wrong_order;
  if (ocip_retirement_reply(kind) < 0) { state->unusable = 1; return -2; }
  return state->disposed ? 1 : 0;
wrong_order:
  state->unusable = 1; errno = EPROTO; return -3;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--persistent-parent")) return ocipp_main();
  if (argc == 2 && !strcmp(argv[1], "--persistent-parent-peer")) return ocipp_peer_main();
  if (argc == 2 && !strcmp(argv[1], "--persistent-parent-peer-runtime")) return ocipp_runtime_peer_main();
  if (argc == 2 && !strcmp(argv[1], "--persistent-parent-peer-local-cleanup")) return ocipp_local_peer_main();
  if (argc == 2 && !strcmp(argv[1], "--persistent-parent-peer-application-owner")) return ocipp_application_peer_main();
  if (argc == 2 && !strcmp(argv[1], "--persistent-parent-peer-runtime-application-owner")) return ocipp_runtime_application_peer_main();
  if (argc == 2 && !strcmp(argv[1], "--parent-peer-read-result")) return ocipp_connector_main();
  if (argc == 2 && !strcmp(argv[1], "--parent-peer-read-application-owner")) return ocipp_application_connector_main();
  if (argc == 2 && !strcmp(argv[1], "--parent-peer-read-live-init")) return ocipp_live_init_connector_main();
  if (argc == 2 && !strcmp(argv[1], "--parent-peer-manage-init")) return ocipp_connector_management_main();
  int live_init_fd = argc == 2 && !strcmp(argv[1], "--selected-runtime-live-init-owner") ?
    OCIP_LIVE_INIT_FD : -1;
  int runtime_first = argc == 2 && !strcmp(argv[1], "--selected-runtime-local-cleanup-owner") ? 2 :
                      live_init_fd >= 0 || (argc == 2 && !strcmp(argv[1], "--selected-runtime-owner")) ? 1 : 0;
  if ((argc != 1 && !runtime_first) || geteuid() != 0 || fcntl(2, F_GETFD) < 0 ||
      ocip_private_channel(0) < 0 || ocip_private_channel(1) < 0 ||
      (live_init_fd >= 0 && ocip_live_init_channel(live_init_fd) < 0)) return 77;
  int input_flags = fcntl(0, F_GETFL), output_flags = fcntl(1, F_GETFL);
  if (input_flags < 0 || output_flags < 0 ||
      fcntl(0, F_SETFL, input_flags | O_NONBLOCK) < 0 ||
      fcntl(1, F_SETFL, output_flags | O_NONBLOCK) < 0) return 77;
  struct sigaction action; memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_IGN;
  if (sigaction(SIGPIPE, &action, NULL) < 0) return 77;
  action.sa_handler = ocip_interrupt;
  if (sigaction(SIGTERM, &action, NULL) < 0 || sigaction(SIGINT, &action, NULL) < 0)
    return 77;
  /* This dedicated single-thread owner exclusively waits its exact children. */
  action.sa_handler = SIG_DFL;
  int subreaper = 0;
  if (sigaction(SIGCHLD, &action, NULL) < 0 ||
      prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) < 0 ||
      prctl(PR_GET_CHILD_SUBREAPER, &subreaper, 0, 0, 0) < 0 || subreaper != 1) return 77;
  sigset_t controls; sigemptyset(&controls);
  sigaddset(&controls, SIGTERM); sigaddset(&controls, SIGINT); sigaddset(&controls, SIGCHLD);
  if (sigprocmask(SIG_UNBLOCK, &controls, NULL) < 0) return 77;
  struct tns_oci_owner *owner = NULL;
  unsigned int attempt = 0; int sealed = 0;
  struct ocip_namespace_state namespace_state = {0};
  struct ocip_retirement_state retirement_state = {.runtime_first = runtime_first};
  int cleanup_done = 0;
  for (;;) {
    ocip_live_init_wait(&live_init_fd, owner, sealed || namespace_state.entered || retirement_state.entered);
    unsigned char *body = NULL; uint32_t size = 0;
    int result = ocip_read(&body, &size);
    if (result) {
      int frame_error = errno ? errno : EPROTO;
      if (body) { explicit_bzero(body, size); free(body); }
      if (result < 0 && !interrupted && !retirement_state.entered) {
        (void)ocip_cleanup(&owner);
        (void)ocip_error("linux-oci-refused@1", "frame", frame_error, owner);
      }
      break;
    }
    int first = tns_oci_once(&attempt) == 0;
    struct tns_ocip_request *request = calloc(1, sizeof(*request));
    if (!request) { explicit_bzero(body, size); free(body); break; }
    result = tns_ocip_decode(body, size, request);
    const char *stage = "request"; int failure = EPROTO;
    if (!result && !interrupted && request->kind == TNS_OCIP_CREATE && first && !sealed && !retirement_state.entered) {
      stage = "create";
      result = runtime_first == 2 ? tns_oci_create_selected_local_cleanup(&request->options, &owner) :
               runtime_first ? tns_oci_create_selected_runtime(&request->options, &owner) :
                               tns_oci_create(&request->options, &owner);
      if (result < 0) failure = errno ? errno : EPROTO;
      else {
        result = ocip_observed("linux-oci-created-stopped@1", owner);
        if (result < 0) failure = errno ? errno : EPROTO;
      }
    } else if (!result && !interrupted && request->kind == TNS_OCIP_OBSERVE && owner && !sealed && !retirement_state.entered) {
      stage = "observe";
      result = ocip_observed("linux-oci-stopped-observation@1", owner);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && request->kind == TNS_OCIP_START && owner && !sealed && !retirement_state.entered) {
      stage = "start";
      result = ocip_started("linux-oci-started@1", owner, 1);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && request->kind == TNS_OCIP_OBSERVE_STARTED && owner && !sealed && !retirement_state.entered) {
      stage = "observe-started";
      result = ocip_started("linux-oci-started-observation@1", owner, 0);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && request->kind == TNS_OCIP_STOP_INIT && owner && !sealed && !retirement_state.entered) {
      stage = "stop-init";
      result = ocip_init_reaped("linux-oci-init-reaped@1", owner, 1);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && request->kind == TNS_OCIP_JOIN_INIT && owner && !namespace_state.entered && !retirement_state.entered) {
      /* A failed STOP seals CREATE/START but may only rejoin this original init. */
      stage = "join-init";
      result = ocip_init_reaped("linux-oci-init-reaped-observation@1", owner, 0);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && owner && !namespace_state.unusable &&
               !retirement_state.entered && ocip_namespace_stage(request->kind)) {
      /* Actual producer init_joined is mandatory, including after a recovered
       * STOP/JOIN. This closes normal requests before any namespace effect. */
      sealed = 1;
      stage = ocip_namespace_stage(request->kind);
      result = ocip_namespace_command(request->kind, owner, &namespace_state);
      if (result < 0) failure = errno ? errno : EPROTO;
      if (result == -3) { stage = "request"; result = -1; }
    } else if (!result && !interrupted && owner &&
               ocip_retirement_stage(request->kind)) {
      sealed = 1;
      stage = ocip_retirement_stage(request->kind);
      result = runtime_first ?
        ocip_runtime_retirement_command(request->kind, &owner, &namespace_state, &retirement_state) :
        ocip_retirement_command(request->kind, &owner, &namespace_state, &retirement_state);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && request->kind == TNS_OCIP_CANCEL && retirement_state.entered) {
      retirement_state.unusable = 1;
      sealed = 1;
      int cleanup_error = ocip_cleanup_routed(&owner, &retirement_state);
      cleanup_done = 1;
      interrupted = 0;
      if (retirement_state.disposed && !owner)
        (void)ocip_retirement_reply(TNS_OCIP_CONTINUE_BORN_DISPOSAL);
      else if (owner)
        (void)ocip_error("linux-oci-cancel-observation@1", "cancel", cleanup_error, owner);
      explicit_bzero(body, size); free(body);
      explicit_bzero(request, sizeof(*request)); free(request);
      break;
    } else if (!result && request->kind == TNS_OCIP_CANCEL) {
      namespace_state.unusable = 1; /* Close never resynchronizes namespace IO. */
      sealed = 1; int cleanup_error = ocip_cleanup(&owner);
      interrupted = 0;
      result = ocip_error("linux-oci-cancel-observation@1", "cancel", cleanup_error, owner);
      explicit_bzero(body, size); free(body);
      explicit_bzero(request, sizeof(*request)); free(request);
      if (result < 0 || !owner) break;
      continue;
    } else {
      result = -1;
      if (interrupted) failure = ECANCELED;
      else if (request->kind == TNS_OCIP_CREATE && !first) failure = EALREADY;
    }
    explicit_bzero(body, size); free(body);
    explicit_bzero(request, sizeof(*request)); free(request);
    if (result == -2 || result == 1) break;
    if (result < 0) {
      sealed = 1;
      if (retirement_state.entered) {
        /* A decoded original operation refusal can retain the channel. A
         * wrong request, framing loss or reply loss never resynchronizes it. */
        int bound = !strcmp(stage, "begin-tracked-join") || !strcmp(stage, "read-tracked-join") ||
          !strcmp(stage, "delete-born") || !strcmp(stage, "join-born-delete") ||
          !strcmp(stage, "dispose-born") || !strcmp(stage, "continue-born-disposal");
        if (!bound || result == -3) retirement_state.unusable = 1;
        interrupted = 0;
        if (!owner || ocip_error("linux-oci-refused@1", stage, failure, owner) < 0 ||
            retirement_state.unusable) break;
        continue;
      }
      if (ocip_namespace_retained_error(&namespace_state, stage)) {
        /* Decoded cleanup refusal preserves this original owner and its real
         * pending phases. Only continue/read may follow; do no extra cleanup. */
      } else if (!strcmp(stage, "stop-init") || !strcmp(stage, "join-init")) {
        /* Preserve the live birth custodian so an unknown STOP can only rejoin
         * this same init. EOF/CANCEL retains the original close semantics. */
        if (owner) (void)tns_oci_cancel(owner);
      } else (void)ocip_cleanup(&owner);
      interrupted = 0;
      if (ocip_error("linux-oci-refused@1", stage, failure, owner) < 0) break;
    }
  }
  if (live_init_fd >= 0) (void)close(live_init_fd);
  if (!cleanup_done) (void)ocip_cleanup_routed(&owner, &retirement_state);
  if (owner) ocip_retain(&owner, &retirement_state);
  return 0;
}
