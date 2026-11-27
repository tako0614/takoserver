/* The legacy model supplies the actual parsers and held-owner kernel reads.
 * Reinclude only the new lease body with mocks for its independently owned IO. */
#define DOCKER_CONTAINER_TERMINAL_OCI_UPLINK_READ_H
#define DOCKER_CONTAINER_TERMINAL_OCI_POLICY_READ_H
#define main prior_admission_main
#include "docker-container-terminal-oci-admission.test.c"
#undef main
#undef DOCKER_CONTAINER_TERMINAL_OCI_UPLINK_READ_H
#undef DOCKER_CONTAINER_TERMINAL_OCI_POLICY_READ_H

enum { READ_LOCK = 124, READ_HOST_NS = 125, READ_SELF_NS = 126, READ_CHILD_PIDFD = 404 };
static struct {
  unsigned int lock_opens, read_locks, clones, kills, waits, host_opens;
  int foreign_lock, wrong_inode, wrong_host, wait_stalls, wrong_wait, cancel_on_wait;
} read_model;

static int probe_openat(int dir, const char *path, int flags) {
  CHECK(dir == 123 && !strcmp(path, "tako-terminal-uplink.lock"));
  CHECK(flags == (O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
  CHECK(++read_model.lock_opens == 1);
  return READ_LOCK;
}

static int probe_open(const char *path, int flags) {
  CHECK(!strcmp(path, "/proc/self/ns/net") && flags == (O_RDONLY | O_CLOEXEC));
  return read_model.host_opens++ ? READ_SELF_NS : READ_HOST_NS;
}

static int probe_fstat(int fd, struct stat *out) {
  if (fd == READ_LOCK) {
    metadata(122, out);
    if (read_model.wrong_inode) out->st_ino++;
    return 0;
  }
  if (fd == READ_HOST_NS || fd == READ_SELF_NS) {
    metadata(121, out);
    if (read_model.wrong_host) out->st_ino++;
    return 0;
  }
  return raw_fstat(fd, out);
}

static int probe_fstatfs(int fd, struct statfs *out) {
  return raw_fstatfs(fd == READ_HOST_NS || fd == READ_SELF_NS ? 121 : fd, out);
}

static int probe_ioctl(int fd, unsigned long op) {
  CHECK(op == NS_GET_NSTYPE);
  return raw_ioctl(fd == READ_HOST_NS || fd == READ_SELF_NS ? 121 : fd, op);
}

static int probe_fcntl(int fd, int op, const struct flock *lock) {
  CHECK(fd == READ_LOCK && op == F_OFD_SETLK && lock->l_type == F_RDLCK);
  CHECK(!lock->l_start && !lock->l_len && lock->l_whence == SEEK_SET);
  CHECK(++read_model.read_locks == 1 && !lock_taken && read_model.waits == 1);
  if (read_model.foreign_lock) { errno = EAGAIN; return -1; }
  return 0;
}

static long probe_syscall(long number, ...) {
  va_list ap; va_start(ap, number);
  if (number == SYS_clone3) {
    struct clone_args *args = va_arg(ap, struct clone_args *);
    CHECK(va_arg(ap, size_t) == sizeof(*args));
    CHECK(args->flags == (CLONE_PIDFD | CLONE_CLEAR_SIGHAND) && args->exit_signal == SIGCHLD);
    CHECK(++read_model.clones == 1 && !read_model.lock_opens && !lock_taken);
    *(int *)(uintptr_t)args->pidfd = READ_CHILD_PIDFD;
    va_end(ap);
    return 5000;
  }
  CHECK(number == SYS_pidfd_send_signal && va_arg(ap, int) == READ_CHILD_PIDFD);
  CHECK(va_arg(ap, int) == SIGKILL && va_arg(ap, void *) == NULL && !va_arg(ap, int));
  CHECK(++read_model.kills == 1);
  va_end(ap);
  return 0;
}

static int probe_poll(struct pollfd *p, nfds_t count, int timeout) {
  CHECK(count == 1 && p->fd == READ_CHILD_PIDFD && p->events == POLLIN && timeout >= 0 && timeout <= 2500);
  if (read_model.wait_stalls) return 0;
  p->revents = POLLIN;
  return 1;
}

static int probe_waitid(idtype_t type, id_t id, siginfo_t *info, int flags) {
  CHECK(type == P_PIDFD && id == READ_CHILD_PIDFD && flags == (WEXITED | WNOHANG));
  CHECK(++read_model.waits == 1);
  info->si_pid = read_model.wrong_wait ? 5001 : 5000;
  info->si_code = read_model.kills ? CLD_KILLED : CLD_EXITED;
  info->si_status = read_model.kills ? SIGKILL : 0;
  if (read_model.cancel_on_wait) tns_oci_note_cancel();
  return 0;
}

#define open probe_open
#define openat probe_openat
#define close raw_close
#define fstat probe_fstat
#define fstatfs probe_fstatfs
#define ioctl probe_ioctl
#define fcntl probe_fcntl
#define syscall probe_syscall
#define socketpair up_socketpair
#define getpid raw_getpid
#define poll probe_poll
#define waitid probe_waitid
#include "../../scripts/native/docker-container-terminal-oci-uplink-read.h"
#undef waitid
#undef poll
#undef getpid
#undef socketpair
#undef syscall
#undef fcntl
#undef ioctl
#undef fstatfs
#undef fstat
#undef close
#undef openat
#undef open

static void read_prepare(struct tns_oci_owner *o, struct tns_owner *b) {
  memset(&read_model, 0, sizeof(read_model));
  memset(&ad, 0, sizeof(ad));
  memset(&rt, 0, sizeof(rt));
  memset(&pol, 0, sizeof(pol));
  prepare(o, b);
  o->retirement_profile = OCI_RETIREMENT_RUNTIME_FIRST;
  int n = snprintf(pol.file, sizeof(pol.file),
    "{\"kind\":\"linux-oci-owned-service@1\",\"artifact\":%s,\"service\":{\"httpPort\":8080,\"healthPath\":\"/ready\"}}", eg.artifact);
  CHECK(n > 0 && (size_t)n < sizeof(pol.file));
  pol.file_size = (size_t)n;
  CHECK(oci_policy_select(o, &o->policy) == 0 && o->policy);
  /* Completed original policy state feeds the partial admission prerequisite.
   * Its current kernel/init/identity check still executes against raw mocks. */
  struct oci_uplink_owner *u = o->uplink;
  u->identity = o->identity;
  u->creator = b->creator;
  u->cookie = 777;
  u->host_cookie = 888;
  u->guest = 409;
  u->host = 410;
  u->guest_port = 1800;
  u->host_port = 1801;
  u->sequence = 97;
  u->netfd = 121;
  u->lock_root = 123;
  u->lock = 122;
  metadata(u->lock, &u->lock_identity);
  u->configured = u->pair_known = 1;
  o->policy->verified = 1;
  o->admission = calloc(1, sizeof(*o->admission));
  CHECK(o->admission);
  o->admission->original = o;
  o->admission_attempt = o->admission_ruleset_reads = o->admission->finished = 1;
  o->command_pid = 4000;
  o->start_attempt = o->start_joined = o->start_ok = 1;
  o->stopped_exe = 603;
  ad.active = ad.birth_drop = ad.exec_changed = 1;
  CHECK(tns_owner_open_admission(b) == 0 && ad.kernel_open);
  o->admission->open_acknowledged = 1;
  ad.birth_drop = 0;
}

static void original_untouched(const struct tns_oci_owner *o, const struct tns_owner *b) {
  const struct oci_uplink_owner *u = o->uplink;
  CHECK(u->lock == 122 && u->host == 410 && u->guest == 409 && u->sequence == 97);
  CHECK(!lock_taken && !u->lock_held && !u->broken && !u->close_unknown && !u->cleaning);
  CHECK(!up.closes[122] && !up.closes[409] && !up.closes[410] && !up.mutations);
  CHECK(b->phase == TNS_HELD && !b->cut_attempted && !o->invalid && !o->policy->runtime && !ad.cuts);
}

static void read_topology_prepare(struct tns_oci_owner *o, struct tns_owner *b) {
  read_prepare(o, b);
  struct oci_uplink_owner *u = o->uplink;
  u->create_sent = u->create_known = u->link_path_captured = u->driver_captured = 1;
  u->host_index = 50;
  u->guest_index = 51;
  u->loopback_index = 1;
  memcpy(u->host_mac, (const unsigned char[]){2,1,2,3,4,5}, 6);
  memcpy(u->guest_mac, (const unsigned char[]){2,1,2,3,4,6}, 6);
  u->driver_facts.driver.cmd = ETHTOOL_GDRVINFO;
  strcpy(u->driver_facts.driver.driver, "raw-original-driver");
  strcpy(u->driver_facts.driver.version, "6.12");
  u->driver_facts.features.cmd = ETHTOOL_GFEATURES;
  u->driver_facts.features.size = 2;
  u->driver_facts.features.blocks[0].available = u->driver_facts.features.blocks[0].requested =
    u->driver_facts.features.blocks[0].active = 1;
  up.created = up.bounded_read_fixture = 1;
  for (size_t side = 0; side < 2; ++side) {
    up.up[side] = up.routes[side] = 1;
    for (size_t family = 0; family < 2; ++family) up.assigned[side][family] = pol.neighbors[side][family] = 1;
  }
  CHECK(oci_policy_network(o->policy, AF_INET, u->expected.local4, 32) == 0);
  CHECK(oci_policy_network(o->policy, AF_INET6, u->expected.local6, 128) == 0);
  CHECK(oci_policy_network(o->policy, AF_INET, u->expected.host4, 32) == 0);
  CHECK(oci_policy_network(o->policy, AF_INET6, u->expected.host6, 128) == 0);
}

static void read_topology_cases(void) {
  for (unsigned int fault = 0; fault < 6; ++fault) {
    struct tns_oci_owner o;
    struct tns_owner b;
    struct oci_uplink_read r = {0};
    struct stat observed, empty;
    memset(&observed, 0xa5, sizeof(observed));
    memset(&empty, 0xa5, sizeof(empty));
    read_topology_prepare(&o, &b);
    CHECK(oci_uplink_read_open(&o, &r, 3000) == 0);
    struct oci_uplink_request forbidden = {0};
    CHECK(oci_uplink_mutate(r.scratch, 0, &forbidden) < 0 && !up.mutations);
    CHECK(oci_uplink_lock(r.scratch) < 0 && oci_uplink_unlock(r.scratch) < 0);
    if (fault == 1) pol.fault = 2; /* Non-permanent original peer. */
    if (fault == 2) up.routes[1] = 0;
    if (fault == 3) up.up[1] = 0;
    if (fault == 4) up.file[0] ^= 1;
    if (fault == 5) o.policy->denied[0].address[0] ^= 1;
    int result = oci_policy_read_topology_current(&o, &r, &observed);
    if (!fault) {
      CHECK(result == 0 && oci_egress_same_stat(&observed, &o.uplink->file_identity));
      CHECK(observed.st_nlink == 1 && observed.st_uid == 0 && (observed.st_mode & 07777) == 0600);
      CHECK(r.scratch->sequence > 10 && !r.scratch->broken);
    } else {
      CHECK(result < 0 && !memcmp(&observed, &empty, sizeof(observed)));
    }
    CHECK(o.policy->denied_count == 4 && r.scratch && oci_uplink_read_close(&r) == 0);
    original_untouched(&o, &b);
    admission_discard(&o);
  }
}

static struct {
  unsigned int pairs, pipes, spawns, go[2], kills[2];
  size_t at[2];
  int cancel_at_host_eof, expire_at_host_eof;
} policy_worker;

static int worker_pair(int domain, int type, int protocol, int pair[2]) {
  CHECK(domain == AF_UNIX && type == (SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK) && !protocol);
  CHECK(policy_worker.pairs < 2 && !read_model.lock_opens);
  pair[0] = 510 + 4 * (int)policy_worker.pairs++;
  pair[1] = pair[0] + 1;
  return 0;
}

static int worker_pipe(int pair[2], int flags) {
  CHECK(flags == (O_CLOEXEC | O_NONBLOCK) && policy_worker.pipes + 1 == policy_worker.pairs);
  pair[0] = 512 + 4 * (int)policy_worker.pipes++;
  pair[1] = pair[0] + 1;
  return 0;
}

static long worker_syscall(long number, ...) {
  va_list ap; va_start(ap, number);
  if (number == SYS_clone3) {
    struct clone_args *args = va_arg(ap, struct clone_args *);
    CHECK(va_arg(ap, size_t) == sizeof(*args) && args->flags == (CLONE_PIDFD | CLONE_CLEAR_SIGHAND));
    CHECK(args->exit_signal == SIGCHLD && !read_model.lock_opens && policy_worker.spawns + 1 == policy_worker.pipes);
    *(int *)(uintptr_t)args->pidfd = 480 + (int)policy_worker.spawns;
    va_end(ap);
    return 7000 + (long)policy_worker.spawns++;
  }
  CHECK(number == SYS_pidfd_send_signal);
  int fd = va_arg(ap, int);
  CHECK(fd >= 480 && fd <= 481 && va_arg(ap, int) == SIGKILL && va_arg(ap, void *) == NULL && !va_arg(ap, int));
  CHECK(!policy_worker.kills[fd-480]++);
  va_end(ap);
  return 0;
}

static ssize_t worker_send(int fd, const void *bytes, size_t size, int flags) {
  CHECK((fd == 510 || fd == 514) && size == 1 && *(const unsigned char *)bytes == 1);
  CHECK(flags == (MSG_NOSIGNAL | MSG_DONTWAIT) && policy_worker.spawns == 2 && read_model.read_locks == 1);
  CHECK(!policy_worker.go[(fd-510)/4]++);
  return 1;
}

static ssize_t worker_read(int fd, void *bytes, size_t size) {
  CHECK(fd == 512 || fd == 516);
  unsigned int side = (unsigned int)(fd-512)/4;
  CHECK(policy_worker.go[side] == 1);
  const char *text = side ? up.host_output[2] : pol.readback;
  size_t total = side ? up.host_size[2] : pol.readback_size;
  size_t n = total - policy_worker.at[side];
  if (n > size) n = size;
  if (n > 199) n = 199;
  if (!n && side && policy_worker.cancel_at_host_eof) tns_oci_note_cancel();
  if (!n && side && policy_worker.expire_at_host_eof) eg.advance_ms = 2000;
  memcpy(bytes, text + policy_worker.at[side], n);
  policy_worker.at[side] += n;
  return (ssize_t)n;
}

#define close raw_close
#define socketpair worker_pair
#define pipe2 worker_pipe
#define syscall worker_syscall
#define poll raw_poll
#define getpid raw_getpid
#define send worker_send
#define read worker_read
#include "../../scripts/native/docker-container-terminal-oci-policy-read.h"
#undef read
#undef send
#undef getpid
#undef poll
#undef syscall
#undef pipe2
#undef socketpair
#undef close

static void read_policy_prepare(struct tns_oci_owner *o, struct tns_owner *b) {
  read_topology_prepare(o, b);
  struct oci_uplink_owner *u = o->uplink;
  struct oci_host_path_owner *host = calloc(1, sizeof(*host));
  CHECK(host);
  u->host_path = host;
  host->uplink = u;
  host->controller = o->controller_pid;
  host->creator = u->creator;
  host->cookie = u->host_cookie;
  host->host_index = u->host_index;
  host->guest_index = u->guest_index;
  host->uplink_index = u->expected.index;
  memcpy(host->claim, o->id, sizeof(host->claim));
  memcpy(host->host_name, u->host_name, sizeof(host->host_name));
  memcpy(host->uplink_name, u->expected.name, sizeof(host->uplink_name));
  CHECK(oci_host_path_program(host) == 0);
  host->verified = 1;
  host->handle = 7001;
  host_raw_output(2);
  CHECK(oci_policy_compile(o->policy) == 0);
  policy_subject = o->policy;
  policy_raw_readback();
  rt.active = 1;
  memset(&policy_worker, 0, sizeof(policy_worker));
}

static void read_policy_cases(void) {
  for (unsigned int fault = 0; fault < 8; ++fault) {
    struct tns_oci_owner o;
    struct tns_owner b;
    struct oci_held_admission_read scope = {0};
    struct oci_held_admission_observation actual, sentinel;
    memset(&actual, 0xa5, sizeof(actual));
    memset(&sentinel, 0xa5, sizeof(sentinel));
    read_policy_prepare(&o, &b);
    if (fault == 1) policy_change(pol.readback, &pol.readback_size, "\"right\":8080", "\"right\":8081");
    if (fault == 2) { char *handle = strstr(up.host_output[2], "7001"); CHECK(handle); handle[3] = '2'; }
    if (fault == 3) rt.fault = 3;
    if (fault == 4) pol.fault = 2;
    if (fault == 5) policy_worker.cancel_at_host_eof = 1;
    if (fault == 6) o.uplink->host_path->verified = 0;
    if (fault == 7) policy_worker.expire_at_host_eof = 1;
    int result = oci_admission_read_published(&o, &scope, 3000, &actual);
    if (!fault) {
      CHECK(result == 0 && !strcmp(actual.init.native_id, o.id));
      CHECK(actual.init.namespace_device == o.identity.device && actual.init.namespace_inode == o.identity.inode);
      CHECK(oci_egress_same_stat(&actual.topology, &o.uplink->file_identity));
      CHECK(policy_worker.go[0] == 1 && policy_worker.go[1] == 1 && rt.joins[0] == 1 && rt.joins[1] == 1);
      CHECK(!policy_worker.kills[0] && !policy_worker.kills[1]);
    } else {
      CHECK(result < 0 && !memcmp(&actual, &sentinel, sizeof(actual)));
      if (fault == 1) CHECK(policy_worker.go[0] == 1 && !policy_worker.go[1]);
      if (fault == 4 || fault == 6) CHECK(!policy_worker.go[0] && !policy_worker.go[1]);
      if (fault == 6) CHECK(!policy_worker.spawns && !read_model.lock_opens);
      if (fault == 7) CHECK(eg.advance_ms == 2000 && policy_worker.go[1] == 1 && policy_worker.kills[1] == 1);
      if (fault == 3) CHECK(scope.workers[0].pidfd == 480 && scope.workers[0].wait_attempted && rt.joins[0] == 1);
    }
    CHECK(!scope.uplink.scratch && !scope.uplink.ready);
    CHECK(o.uplink->host_path->handle == 7001 && !o.uplink->host_path->unknown);
    CHECK(!o.policy->observed_packets[0] && !o.policy->observed_quota);
    original_untouched(&o, &b);
    oci_cancel_requested = 0;
    struct tns_oci_init_reaped reaped;
    CHECK(tns_oci_stop_init(&o, &reaped) == 0 && ad.cuts == 1 && ad.init_signals == 1);
    admission_discard(&o);
  }
}

static void read_cases(void) {
  struct tns_oci_owner o;
  struct tns_owner b;
  struct oci_uplink_read r = {0};
  struct oci_uplink_dump *out = calloc(1, sizeof(*out));
  CHECK(out);
  read_prepare(&o, &b);
  CHECK(oci_uplink_read_open(&o, &r, 3000) == 0 && r.ready);
  CHECK(read_model.read_locks == 1 && read_model.clones == 1 && read_model.waits == 1 && !read_model.kills);
  CHECK(r.scratch->host == 407 && r.scratch->guest == 405 && r.scratch->lock == READ_LOCK);
  CHECK(oci_uplink_read_dump(&r, 0, RTM_GETLINK, out) == 0 && out->done && out->sequence == 1 && out->port == 901);
  CHECK(oci_uplink_read_dump(&r, 1, RTM_GETLINK, out) == 0 && out->done && out->sequence == 2 && out->port == 900);
  up.read_fault = 1;
  CHECK(oci_uplink_read_dump(&r, 0, RTM_GETLINK, out) < 0 && out->failed && r.failed && !r.scratch);
  CHECK(oci_uplink_read_close(&r) == 0 && eg.close_calls[READ_LOCK] == 1);
  CHECK(up.closes[407] == 1 && up.closes[405] == 1 && up.closes[404] == 1);
  original_untouched(&o, &b);
  struct tns_oci_init_reaped reaped;
  CHECK(tns_oci_stop_init(&o, &reaped) == 0 && ad.cuts == 1 && ad.init_signals == 1);
  admission_discard(&o);

  for (int fault = 0; fault < 9; ++fault) {
    read_prepare(&o, &b);
    r = (struct oci_uplink_read){0};
    read_model.foreign_lock = fault == 0;
    read_model.wrong_inode = fault == 1;
    read_model.wrong_host = fault == 2;
    up.malformed = fault == 3;
    up.cookie_fault = fault == 4;
    read_model.wait_stalls = fault == 5;
    read_model.cancel_on_wait = fault == 6;
    if (fault == 8) o.retirement_profile = OCI_RETIREMENT_TRACKED;
    CHECK(oci_uplink_read_open(&o, &r, fault == 7 ? 1000 : 3000) < 0 && !r.ready);
    if (fault == 3) CHECK(up.closes[406] == 1 && up.closes[408] == 1);
    if (fault == 5) {
      CHECK(r.scratch && r.scratch->child_pidfd == READ_CHILD_PIDFD && !read_model.waits && read_model.kills == 1);
      read_model.wait_stalls = 0;
    }
    CHECK(oci_uplink_read_close(&r) == 0 && !r.scratch);
    CHECK(oci_uplink_read_open(&o, &r, 3000) < 0 && errno == EALREADY);
    CHECK(eg.close_calls[READ_LOCK] == (fault < 2 ? 1u : 0u));
    if (fault == 2 || fault >= 7) CHECK(!read_model.clones);
    CHECK(!up.dumps);
    original_untouched(&o, &b);
    admission_discard(&o);
  }

  read_prepare(&o, &b);
  r = (struct oci_uplink_read){0};
  read_model.wrong_wait = 1;
  CHECK(oci_uplink_read_open(&o, &r, 3000) < 0 && r.scratch && r.waited && !r.ready);
  CHECK(read_model.waits == 1 && read_model.kills == 1 && !read_model.lock_opens);
  CHECK(oci_uplink_read_close(&r) < 0 && r.scratch->child_pidfd == READ_CHILD_PIDFD);
  CHECK(read_model.waits == 1 && read_model.kills == 1 && !up.closes[READ_CHILD_PIDFD]);
  original_untouched(&o, &b);
  free(r.scratch); /* Synthetic record after the exact unknown-custody assertions. */
  admission_discard(&o);
  free(out);
}

int main(void) {
  read_cases();
  read_topology_cases();
  read_policy_cases();
  printf("isolated native uplink read model: %lu checks\n", checks);
  return 0;
}
