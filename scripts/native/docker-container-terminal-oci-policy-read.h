#ifndef DOCKER_CONTAINER_TERMINAL_OCI_POLICY_READ_H
#define DOCKER_CONTAINER_TERMINAL_OCI_POLICY_READ_H

enum { OCI_ADMISSION_GUEST_READ, OCI_ADMISSION_HOST_READ, OCI_ADMISSION_READS };
struct oci_held_admission_read {
  struct oci_uplink_read uplink;
  struct oci_policy_runtime workers[OCI_ADMISSION_READS];
  pid_t controller;
  int attempted;
};
struct oci_held_admission_observation {
  struct tns_oci_started init;
  struct stat topology;
};

/* These are original policy producers running only their fixed list paths.
 * Fork before the read OFD opens. Go is accepted solely on the owned pair
 * after H acquires that lock and validates the complete original uplink. */
static inline _Noreturn void oci_admission_read_child(struct tns_oci_owner *o, int side,
                                                     int gate, int output, int64_t deadline) {
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != o->controller_pid) _exit(125);
  struct pollfd p = {.fd = gate, .events = POLLIN};
  int left = oci_egress_left(deadline);
  unsigned char go;
  if (left < 0 || poll(&p, 1, left) != 1 || !(p.revents & POLLIN) ||
      (p.revents & ~(POLLIN | POLLHUP)) || oci_egress_left(deadline) < 0 ||
      recv(gate, &go, sizeof(go), MSG_TRUNC | MSG_DONTWAIT) != (ssize_t)sizeof(go) || go != 1)
    _exit(125);
  if (side == OCI_ADMISSION_HOST_READ) oci_host_path_child(o->uplink->host_path, 2, gate, output);
  oci_policy_child(o->policy, 2, gate, output);
}

static inline int oci_admission_read_start(struct tns_oci_owner *o, struct oci_policy_runtime *w,
                                           int side, int64_t deadline) {
  if (tns_oci_once(&w->attempted) < 0 || oci_egress_left(deadline) < 0 || oci_not_canceled() < 0) return -1;
  int gate[2], output[2];
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, gate) < 0) return -1;
  w->incoming = gate[0];
  if (pipe2(output, O_CLOEXEC | O_NONBLOCK) < 0) {
    (void)oci_policy_runtime_close_fd(w, &gate[1]);
    return -1;
  }
  w->outgoing = output[0];
  long child = -1;
  if (oci_egress_left(deadline) >= 0 && oci_not_canceled() == 0) {
    struct clone_args args = {.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND, .exit_signal = SIGCHLD,
      .pidfd = (uint64_t)(uintptr_t)&w->pidfd};
    child = syscall(SYS_clone3, &args, sizeof(args));
    if (!child) {
      if (close(gate[0]) < 0 || close(output[0]) < 0) _exit(125);
      oci_admission_read_child(o, side, gate[1], output[1], deadline);
    }
    if (child > 0) w->pid = (pid_t)child;
  }
  int saved = errno;
  int closed_gate = oci_policy_runtime_close_fd(w, &gate[1]);
  int closed_output = oci_policy_runtime_close_fd(w, &output[1]);
  if (child < 0) { errno = saved; return -1; }
  if (closed_gate < 0 || closed_output < 0) { errno = EUCLEAN; return -1; }
  return 0;
}

static inline int oci_admission_read_collect(struct oci_policy_runtime *w, int64_t deadline,
                                            char *output, size_t *used) {
  if (oci_egress_left(deadline) < 0 || oci_not_canceled() < 0) return -1;
  const unsigned char go = 1;
  if (send(w->incoming, &go, sizeof(go), MSG_NOSIGNAL | MSG_DONTWAIT) != (ssize_t)sizeof(go) ||
      oci_policy_runtime_close_fd(w, &w->incoming) < 0) return -1;
  *used = 0;
  for (;;) {
    struct pollfd p = {.fd = w->outgoing, .events = POLLIN};
    int left = oci_egress_left(deadline);
    if (left < 0 || oci_not_canceled() < 0 || poll(&p, 1, left) != 1 ||
        !(p.revents & (POLLIN | POLLHUP)) || (p.revents & ~(POLLIN | POLLHUP))) return -1;
    ssize_t n = read(w->outgoing, output + *used, OCI_POLICY_JSON_MAX - *used);
    if (n < 0) return -1;
    if (!n) break;
    *used += (size_t)n;
    if (*used == OCI_POLICY_JSON_MAX) { errno = EOVERFLOW; return -1; }
  }
  if (oci_policy_runtime_close_fd(w, &w->outgoing) < 0) return -1;
  int left = oci_egress_left(deadline);
  if (left < 0 || oci_policy_runtime_join(w, left) < 0 || !w->ok || oci_not_canceled() < 0 ||
      oci_policy_runtime_close_fd(w, &w->pidfd) < 0 || w->close_unknown || oci_egress_left(deadline) < 0)
    return -1;
  return 0;
}

/* Only read-worker FDs and processes may be acted on here. Unknown wait
 * custody remains in the supplied scope for its H, with no read lock held. */
static inline int oci_admission_read_close(struct oci_held_admission_read *r) {
  if (!r->attempted) return 0;
  if (r->controller != getpid()) { errno = EPERM; return -1; }
  int closed = oci_uplink_read_close(&r->uplink);
  for (int side = 0; side < OCI_ADMISSION_READS; ++side) {
    struct oci_policy_runtime *w = &r->workers[side];
    if (w->pid && !w->joined && !w->killed) {
      w->killed = 1;
      if (w->pidfd < 0 || (syscall(SYS_pidfd_send_signal, w->pidfd, SIGKILL, NULL, 0) < 0 && errno != ESRCH))
        w->close_unknown = 1;
    }
    (void)oci_policy_runtime_close_fd(w, &w->incoming);
    (void)oci_policy_runtime_close_fd(w, &w->outgoing);
    int left = oci_egress_left(r->uplink.deadline);
    if (w->pid && !w->joined && oci_policy_runtime_join(w, left < 0 ? 0 : left) < 0) closed = -1;
    if (!w->pid || w->joined) (void)oci_policy_runtime_close_fd(w, &w->pidfd);
    if (w->close_unknown) closed = -1;
  }
  if (closed < 0) errno = EUCLEAN;
  return closed;
}

static inline int oci_admission_read_host_current(struct oci_uplink_read *r,
                                                  struct oci_host_path_owner *host) {
  struct oci_uplink_owner *scratch = r->scratch;
  struct oci_host_path_owner view = *host;
  view.uplink = scratch;
  scratch->host_path = &view;
  int result = oci_host_path_current(&view, 0);
  scratch->host_path = NULL;
  return result;
}

/* Original admitted policy plus topology and exact init under one bounded
 * scope. No input supplies an expected table, topology pathname, or PID. */
static inline int oci_admission_read_published(struct tns_oci_owner *o, struct oci_held_admission_read *r,
                                                int64_t deadline, struct oci_held_admission_observation *out) {
  if (!o || !r || !out || r->attempted) { errno = EINVAL; return -1; }
  r->attempted = 1;
  r->controller = getpid();
  for (int side = 0; side < OCI_ADMISSION_READS; ++side)
    r->workers[side].pidfd = r->workers[side].incoming = r->workers[side].outgoing = -1;
  struct oci_uplink_read *u = &r->uplink;
  if (oci_uplink_read_prepare(o, u, deadline) < 0) goto fail;
  struct oci_host_path_owner *host = u->original->host_path;
  if (!host || host->uplink != u->original || !host->verified || !host->handle ||
      host->unknown || host->close_unknown || host->removed) { errno = EUCLEAN; goto fail; }
  for (int side = 0; side < OCI_ADMISSION_READS; ++side)
    if (oci_admission_read_start(o, &r->workers[side], side, deadline) < 0) goto fail;
  if (oci_uplink_read_lock(u) < 0) goto fail;
  u->scratch->lock_held = 1; /* The private shared OFD is held. Mutators reject this view. */
  struct oci_held_admission_observation actual = {0};
  if (oci_policy_read_topology_current(o, u, &actual.topology) < 0 || oci_admission_read_host_current(u, host) < 0)
    goto fail;
  struct oci_policy_owner *policy = malloc(sizeof(*policy));
  char *bytes = malloc(OCI_POLICY_JSON_MAX);
  size_t size = 0;
  int result = -1;
  if (policy && bytes) {
    *policy = *o->policy;
    if (oci_admission_read_collect(&r->workers[OCI_ADMISSION_GUEST_READ], deadline, bytes, &size) == 0 &&
        oci_policy_readback(policy, bytes, size) == 0 && oci_uplink_read_current(u) == 0 &&
        oci_admission_read_collect(&r->workers[OCI_ADMISSION_HOST_READ], deadline, bytes, &size) == 0 &&
        oci_host_path_readback(host, bytes, size, 0) == 0)
      result = 0;
  }
  free(bytes);
  free(policy);
  if (result < 0 || oci_policy_read_topology_current(o, u, &actual.topology) < 0 ||
      oci_admission_read_host_current(u, host) < 0 || oci_admission_read_close(r) < 0 ||
      oci_egress_left(deadline) < 0 || tns_oci_check_original_kernel_admission(o) < 0 ||
      tns_oci_read_live_init(o, &actual.init) < 0 || oci_egress_left(deadline) < 0) goto fail;
  *out = actual;
  return 0;
fail: {
  int saved = errno ? errno : EPROTO;
  (void)oci_admission_read_close(r);
  errno = saved;
  return -1;
}
}
#endif
