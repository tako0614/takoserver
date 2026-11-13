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

/* Dedicated persistent original owner. No DELETE, mode flag, caller
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

static int ocip_private_channel(int fd) {
  struct stat st;
  if (fstat(fd, &st) < 0 || st.st_uid != 0) return -1;
  if (S_ISFIFO(st.st_mode)) return tns_ocip_private_fifo(st.st_mode, st.st_uid) ? 0 : -1;
  if (!S_ISSOCK(st.st_mode)) return -1;
  int domain = 0, type = 0; socklen_t size = sizeof(domain);
  if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &size) < 0 ||
      size != sizeof(domain) || domain != AF_UNIX) return -1;
  size = sizeof(type);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) < 0 ||
      size != sizeof(type) || type != SOCK_STREAM) return -1;
  struct ucred peer; size = sizeof(peer);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) < 0 ||
      size != sizeof(peer) || peer.uid != 0 || peer.pid != getppid()) return -1;
  return 0;
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

static _Noreturn void ocip_retain(struct tns_oci_owner **owner) {
  /* Protocol is gone; retain this original process, no fork/detach/rebind.
   * SIGCHLD can finish outstanding owned joins. Signals only request another
   * close/join; they cannot reopen, START, delete or release a born owner. */
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
  (void)ocip_cleanup(owner);
  for (;;) {
    interrupted = 0;
    /* Atomic unmask+wait prevents a child-exit notification being lost between
     * the previous join and sleeping. This is owned-child cleanup, no drain. */
    (void)sigsuspend(&prior);
    (void)ocip_cleanup(owner);
  }
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1 || geteuid() != 0 || fcntl(2, F_GETFD) < 0 ||
      ocip_private_channel(0) < 0 || ocip_private_channel(1) < 0) return 77;
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
  for (;;) {
    unsigned char *body = NULL; uint32_t size = 0;
    int result = ocip_read(&body, &size);
    if (result) {
      int frame_error = errno ? errno : EPROTO;
      if (body) { explicit_bzero(body, size); free(body); }
      if (result < 0 && !interrupted) {
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
    if (!result && !interrupted && request->kind == TNS_OCIP_CREATE && first && !sealed) {
      stage = "create";
      result = tns_oci_create(&request->options, &owner);
      if (result < 0) failure = errno ? errno : EPROTO;
      else {
        result = ocip_observed("linux-oci-created-stopped@1", owner);
        if (result < 0) failure = errno ? errno : EPROTO;
      }
    } else if (!result && !interrupted && request->kind == TNS_OCIP_OBSERVE && owner && !sealed) {
      stage = "observe";
      result = ocip_observed("linux-oci-stopped-observation@1", owner);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && request->kind == TNS_OCIP_START && owner && !sealed) {
      stage = "start";
      result = ocip_started("linux-oci-started@1", owner, 1);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && request->kind == TNS_OCIP_OBSERVE_STARTED && owner && !sealed) {
      stage = "observe-started";
      result = ocip_started("linux-oci-started-observation@1", owner, 0);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && request->kind == TNS_OCIP_STOP_INIT && owner && !sealed) {
      stage = "stop-init";
      result = ocip_init_reaped("linux-oci-init-reaped@1", owner, 1);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && request->kind == TNS_OCIP_JOIN_INIT && owner && !namespace_state.entered) {
      /* A failed STOP seals CREATE/START but may only rejoin this original init. */
      stage = "join-init";
      result = ocip_init_reaped("linux-oci-init-reaped-observation@1", owner, 0);
      if (result < 0) failure = errno ? errno : EPROTO;
    } else if (!result && !interrupted && owner && !namespace_state.unusable &&
               ocip_namespace_stage(request->kind)) {
      /* Actual producer init_joined is mandatory, including after a recovered
       * STOP/JOIN. This closes normal requests before any namespace effect. */
      sealed = 1;
      stage = ocip_namespace_stage(request->kind);
      result = ocip_namespace_command(request->kind, owner, &namespace_state);
      if (result < 0) failure = errno ? errno : EPROTO;
      if (result == -3) { stage = "request"; result = -1; }
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
    if (result == -2) break;
    if (result < 0) {
      sealed = 1;
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
  (void)ocip_cleanup(&owner);
  if (owner) ocip_retain(&owner);
  return 0;
}
