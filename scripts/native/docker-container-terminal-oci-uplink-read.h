#ifndef DOCKER_CONTAINER_TERMINAL_OCI_UPLINK_READ_H
#define DOCKER_CONTAINER_TERMINAL_OCI_UPLINK_READ_H

static inline int oci_uplink_read_namespace(int fd, const struct tns_identity *identity) {
  struct stat st;
  struct statfs fs;
  if (fstat(fd, &st) < 0 || fstatfs(fd, &fs) < 0) return -1;
  if ((unsigned long)fs.f_type != (unsigned long)NSFS_MAGIC ||
      ioctl(fd, NS_GET_NSTYPE) != CLONE_NEWNET || (uint64_t)st.st_dev != identity->device ||
      (uint64_t)st.st_ino != identity->inode) { errno = ESTALE; return -1; }
  return 0;
}

static inline int oci_uplink_read_lock_current(const struct oci_uplink_read *r) {
  struct stat st;
  if (oci_uplink_lock_current(r->original) < 0 || fstat(r->scratch->lock, &st) < 0) return -1;
  if (!S_ISREG(st.st_mode) || st.st_uid || (st.st_mode & 07777) != 0600 || st.st_nlink != 1 ||
      !oci_same(&st, &r->original->lock_identity)) { errno = ESTALE; return -1; }
  return 0;
}

static inline int oci_uplink_read_creator_current(const struct tns_identity *creator) {
  int fd = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  int result = oci_uplink_read_namespace(fd, creator);
  int saved = errno;
  int closed = close(fd);
  if (result < 0) { errno = saved; return -1; }
  return closed;
}

static inline int oci_uplink_read_current(const struct oci_uplink_read *r) {
  struct oci_uplink_owner *s = r->scratch, *u = r->original;
  if (!s || r->failed || s->broken || s->read_scope != r ||
      s->original->retirement_profile != OCI_RETIREMENT_RUNTIME_FIRST ||
      s->original->uplink != u || u->controller != s->controller ||
      u->controller != getpid() || u->cookie != s->cookie || u->host_cookie != s->host_cookie ||
      !tns_identity_equal(&u->creator, &s->creator) || !tns_identity_equal(&u->identity, &s->identity)) {
    errno = ESTALE;
    return -1;
  }
  if (oci_egress_left(r->deadline) < 0 || tns_oci_check_original_kernel_admission(s->original) < 0 ||
      oci_uplink_read_lock_current(r) < 0 || oci_uplink_read_namespace(u->netfd, &s->creator) < 0 ||
      oci_uplink_read_namespace(s->netfd, &s->creator) < 0 ||
      oci_uplink_read_creator_current(&s->creator) < 0 ||
      oci_uplink_read_namespace(s->original->network, &s->identity) < 0) return -1;
  uint32_t host_port, guest_port;
  if (oci_uplink_socket_identity(s->host, s->host_cookie, &host_port) < 0 || host_port != s->host_port ||
      oci_uplink_socket_identity(s->guest, s->cookie, &guest_port) < 0 || guest_port != s->guest_port) return -1;
  return oci_egress_left(r->deadline) < 0 ? -1 : oci_not_canceled();
}

/* Keep the CREATE topology in original custody. The admitted proof may export
 * a final fstat identity only from this same retained, exact named FD. */
static inline int oci_uplink_read_topology_identity(const struct oci_uplink_read *r,
                                                   struct stat *identity) {
  struct oci_uplink_owner *u = r->original;
  struct stat actual;
  if (!identity || !r->ready || oci_uplink_read_current(r) < 0 || !u->file_selected ||
      oci_uplink_file_current(u) < 0 || fstat(u->file, &actual) < 0) return -1;
  if (!S_ISREG(actual.st_mode) || actual.st_uid || (actual.st_mode & 07777) != 0600 ||
      actual.st_nlink != 1 || !oci_egress_same_stat(&actual, &u->file_identity)) {
    errno = ESTALE;
    return -1;
  }
  if (oci_uplink_read_current(r) < 0) return -1;
  *identity = actual;
  return 0;
}

static inline int oci_uplink_read_wait(struct oci_uplink_read *r, int timeout) {
  struct oci_uplink_owner *s = r->scratch;
  if (!s->child || s->child_joined) return 0;
  if (r->waited || s->child_pidfd < 0) { errno = EUCLEAN; return -1; }
  struct pollfd p = {.fd = s->child_pidfd, .events = POLLIN};
  int polled = poll(&p, 1, timeout);
  if (polled != 1 || p.revents != POLLIN) {
    if (polled >= 0) errno = polled ? EPROTO : ETIMEDOUT;
    return -1;
  }
  siginfo_t info = {0};
  r->waited = 1;
  if (waitid(P_PIDFD, (id_t)s->child_pidfd, &info, WEXITED | WNOHANG) < 0) return -1;
  if (info.si_pid != s->child ||
      (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED && info.si_code != CLD_DUMPED)) {
    errno = EPROTO; return -1;
  }
  s->child_joined = 1;
  s->child_ok = info.si_code == CLD_EXITED && info.si_status == 0;
  return 0;
}

/* A pending worker leaves only its private PIDFD owned here. One consuming
 * wait may follow a timeout when ready. An unknown wait is never replayed. */
static inline int oci_uplink_read_close(struct oci_uplink_read *r) {
  struct oci_uplink_owner *s = r->scratch;
  r->ready = 0;
  if (!s) { if (r->close_unknown) errno = EUCLEAN; return r->close_unknown ? -1 : 0; }
  if (s->controller != getpid()) { errno = EPERM; return -1; }
  for (unsigned int i = 0; i < s->received_count; ++i)
    (void)oci_uplink_close_fd(s, &s->received_rights[i]);
  s->received_count = 0;
  int *const owned[] = {&s->channel, &s->guest, &s->host, &s->netfd, &s->lock};
  for (size_t i = 0; i < sizeof(owned) / sizeof(owned[0]); ++i)
    (void)oci_uplink_close_fd(s, owned[i]);
  if (s->child && !s->child_joined) {
    if (!s->kill_attempt) {
      s->kill_attempt = 1;
      if (s->child_pidfd < 0 ||
          (syscall(SYS_pidfd_send_signal, s->child_pidfd, SIGKILL, NULL, 0) < 0 && errno != ESRCH))
        s->close_unknown = 1;
    }
    int left = oci_egress_left(r->deadline);
    if (oci_uplink_read_wait(r, left < 0 ? 0 : left) < 0) return -1;
  }
  (void)oci_uplink_close_fd(s, &s->child_pidfd);
  r->close_unknown = s->close_unknown;
  free(s);
  r->scratch = NULL;
  if (r->close_unknown) { errno = EUCLEAN; return -1; }
  return 0;
}

static inline int oci_uplink_read_guest(struct oci_uplink_read *r) {
  struct oci_uplink_owner *s = r->scratch;
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, pair) < 0) return -1;
  s->channel = pair[0];
  if (oci_egress_left(r->deadline) < 0 || oci_not_canceled() < 0) {
    int saved = errno;
    (void)oci_uplink_close_fd(s, &pair[1]);
    errno = saved;
    return -1;
  }
  struct clone_args args = {.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND, .exit_signal = SIGCHLD,
    .pidfd = (uint64_t)(uintptr_t)&s->child_pidfd};
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (!child) oci_uplink_child(s, pair[1]);
  int saved = errno;
  if (child > 0) s->child = (pid_t)child;
  if (oci_uplink_close_fd(s, &pair[1]) < 0) return -1;
  if (child < 0) { errno = saved; return -1; }
  if (oci_not_canceled() < 0 || oci_uplink_guest_receive(s, r->deadline) < 0) return -1;
  int left = oci_egress_left(r->deadline);
  if (left < 0 || oci_uplink_read_wait(r, left) < 0 || !s->child_ok) return -1;
  if (oci_uplink_close_fd(s, &s->channel) < 0 || oci_uplink_close_fd(s, &s->child_pidfd) < 0) return -1;
  return 0;
}

/* Caller serializes the original H and initializes r to zero. Its one
 * monotonic deadline covers construction, GETs and the positive join. Retain
 * a failed lease while it still owns a pending or unknown worker PIDFD. */
static inline int oci_uplink_read_open(struct tns_oci_owner *o, struct oci_uplink_read *r,
                                      int64_t deadline) {
  if (!r || r->attempted) { errno = EALREADY; return -1; }
  r->attempted = 1;
  int64_t now = oci_now();
  if (now < 0) return -1;
  if (deadline <= now || deadline - now > 2500) { errno = ETIMEDOUT; return -1; }
  if (!o || o->retirement_profile != OCI_RETIREMENT_RUNTIME_FIRST) { errno = EUCLEAN; return -1; }
  if (tns_oci_check_original_kernel_admission(o) < 0) return -1;
  struct oci_uplink_owner *u = o->uplink;
  if (!u->cookie || !u->host_cookie || u->cookie == u->host_cookie || u->guest < 0 || u->host < 0 ||
      !u->host_port || !u->guest_port) { errno = EUCLEAN; return -1; }
  if (oci_uplink_lock_current(u) < 0) return -1;
  struct oci_uplink_owner *s = calloc(1, sizeof(*s));
  if (!s) return -1;
  r->original = u;
  r->scratch = s;
  r->deadline = deadline;
  s->original = o;
  s->read_scope = r;
  s->identity = u->identity;
  s->creator = u->creator;
  s->cookie = u->cookie;
  s->host_cookie = u->host_cookie;
  s->controller = getpid();
  s->netfd = s->child_pidfd = s->channel = s->guest = s->host = s->lock = s->lock_root = s->file = -1;
  /* Immutable CREATE observations qualify the shared validators. Only this
   * lease receives their independent observations and failure latches. */
  s->expected = u->expected;
  s->driver_facts = u->driver_facts;
  s->driver_captured = u->driver_captured;
  s->link_path = u->link_path;
  s->link_path_captured = u->link_path_captured;
  s->create_sent = u->create_sent;
  s->create_known = u->create_known;
  s->pair_known = u->pair_known;
  s->configured = u->configured;
  s->host_index = u->host_index;
  s->guest_index = u->guest_index;
  s->loopback_index = u->loopback_index;
  memcpy(s->host_mac, u->host_mac, sizeof(s->host_mac));
  memcpy(s->guest_mac, u->guest_mac, sizeof(s->guest_mac));
  memcpy(s->host_name, u->host_name, sizeof(s->host_name));
  memcpy(s->guest_name, u->guest_name, sizeof(s->guest_name));
  s->netfd = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
  if (s->netfd < 0 || oci_uplink_read_namespace(s->netfd, &s->creator) < 0 ||
      oci_uplink_open_route(&s->host) < 0 ||
      oci_uplink_socket_identity(s->host, s->host_cookie, &s->host_port) < 0 ||
      oci_uplink_read_guest(r) < 0) goto fail;
  if (s->host_port == u->host_port || s->guest_port == u->guest_port) { errno = ESTALE; goto fail; }
  /* Join the producer before opening the read OFD. Even a failed or stalled
   * worker cannot inherit and prolong this cooperating read lock. */
  if (oci_egress_left(deadline) < 0 || oci_not_canceled() < 0) goto fail;
  s->lock = openat(u->lock_root, "tako-terminal-uplink.lock",
                   O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (s->lock < 0 || oci_uplink_read_lock_current(r) < 0) goto fail;
  struct flock lock = {.l_type = F_RDLCK, .l_whence = SEEK_SET};
  if (oci_egress_left(deadline) < 0 || fcntl(s->lock, F_OFD_SETLK, &lock) < 0) goto fail;
  if (oci_uplink_read_current(r) < 0) goto fail;
  r->ready = 1;
  return 0;
fail: {
  int saved = errno ? errno : EPROTO;
  r->failed = 1;
  (void)oci_uplink_read_close(r);
  errno = saved;
  return -1;
}
}

static inline int oci_uplink_read_dump_one(struct oci_uplink_read *r, int guest, uint16_t type,
                                          int route_exceptions, struct oci_uplink_dump *out) {
  struct oci_uplink_owner *s = r->scratch;
  int fd = guest ? s->guest : s->host, sent = 0;
  uint32_t expected = guest ? s->guest_port : s->host_port, port;
  uint64_t cookie = guest ? s->cookie : s->host_cookie;
  if (s->sequence == UINT32_MAX) { errno = EOVERFLOW; return -1; }
  if (oci_uplink_socket_identity(fd, cookie, &port) < 0 || port != expected ||
      oci_uplink_dump_exchange(fd, expected, &s->sequence, type, route_exceptions,
                               0, r->deadline, out, &sent) < 0 ||
      oci_uplink_socket_identity(fd, cookie, &port) < 0 || port != expected) return -1;
  return oci_uplink_read_current(r);
}

/* Returns only actual bounded GET bytes validated by the existing parser.
 * Full policy evidence needs both namespaces' live policy and a final join. */
static inline int oci_uplink_read_dump_scoped(struct oci_uplink_read *r, int guest, uint16_t type,
                                             struct oci_uplink_dump *out) {
  if (!r || !out || !r->ready || r->failed || (guest != 0 && guest != 1)) { errno = EINVAL; return -1; }
  memset(out, 0, sizeof(*out));
  if (oci_uplink_read_current(r) < 0 || oci_uplink_read_dump_one(r, guest, type, 0, out) < 0) goto fail;
  if (type == RTM_GETROUTE) {
    unsigned int records = out->records;
    if (oci_uplink_read_dump_one(r, guest, type, 1, out) < 0) goto fail;
    if (records != out->records) { errno = ESTALE; goto fail; }
  }
  return 0;
fail:
  r->failed = 1;
  out->failed = 1;
  if (!errno) errno = EPROTO;
  return -1;
}

static inline int oci_uplink_read_dump(struct oci_uplink_read *r, int guest, uint16_t type,
                                      struct oci_uplink_dump *out) {
  int result = oci_uplink_read_dump_scoped(r, guest, type, out);
  if (result < 0 && r && r->failed) {
    int saved = errno;
    (void)oci_uplink_read_close(r);
    errno = saved;
  }
  return result;
}
#endif
