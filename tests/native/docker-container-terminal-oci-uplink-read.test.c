/* The legacy model supplies the actual parsers and held-owner kernel reads.
 * Reinclude only the new lease body with mocks for its independently owned IO. */
#define DOCKER_CONTAINER_TERMINAL_OCI_UPLINK_READ_H
#define main prior_admission_main
#include "docker-container-terminal-oci-admission.test.c"
#undef main
#undef DOCKER_CONTAINER_TERMINAL_OCI_UPLINK_READ_H

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
  printf("isolated native uplink read model: %lu checks\n", checks);
  return 0;
}
