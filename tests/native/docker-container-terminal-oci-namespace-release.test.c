#define _GNU_SOURCE
/* Actual namespace+OCI producer bodies under closed pure syscall models.
 * No constructor, real child/signal, device, namespace or runtime is executed. */
#include <assert.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/magic.h>
#include <linux/nsfs.h>
#include <linux/sched.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/eventfd.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/vfs.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "../../scripts/native/docker-container-terminal-oci.h"
#include "../../scripts/native/docker-container-terminal-kernel-uapi.h"

static long raw_syscall(long number, ...);
static int raw_open(const char *path, int flags, ...);
static int raw_openat(int dir, const char *path, int flags, ...);
static int raw_close(int fd);
static int raw_fstat(int fd, struct stat *out);
static int raw_fstatat(int dir, const char *path, struct stat *out, int flags);
static int raw_fstatfs(int fd, struct statfs *out);
static int raw_ioctl(int fd, unsigned long request, ...);
static int raw_poll(struct pollfd *p, nfds_t count, int timeout);
static int raw_waitid(idtype_t type, id_t id, siginfo_t *out, int flags);
static int raw_prctl(int option, ...);
static int raw_sigaction(int number, const struct sigaction *in, struct sigaction *out);
static pid_t raw_getpid(void);
static uid_t raw_geteuid(void);
static ssize_t raw_pread(int fd, void *out, size_t count, off_t offset);
#define syscall raw_syscall
#define open raw_open
#define openat raw_openat
#define close raw_close
#define fstat raw_fstat
#define fstatat raw_fstatat
#define fstatfs raw_fstatfs
#define ioctl raw_ioctl
#define poll raw_poll
#define waitid raw_waitid
#define prctl raw_prctl
#define sigaction(...) raw_sigaction(__VA_ARGS__)
#define getpid raw_getpid
#define geteuid raw_geteuid
#define pread raw_pread
#include "../../scripts/native/docker-container-terminal-namespace.c"
#include "../../scripts/native/docker-container-terminal-oci.c"
#undef syscall
#undef open
#undef openat
#undef close
#undef fstat
#undef fstatat
#undef fstatfs
#undef ioctl
#undef poll
#undef waitid
#undef prctl
#undef sigaction
#undef getpid
#undef geteuid
#undef pread

enum { ROOT = 10, ROOTFS, RECEIPT, RUNTIME, BUNDLE, STATE, LOAN, INIT_PIDFD,
       INIT_PROC, PARENT_PIDNS, PRIVATE_PIDNS, FRESH_PIDNS, SELF_PIDNS,
       CHILDREN_PIDNS, PARENT_OF_INIT, NETNS, CONFIG, KERNEL_DEVICE,
       BIRTH_NS, CUSTODIAN_PIDFD, CUSTODIAN_PROC, CONTROL };
enum fault { NONE, WRONG_CONTROLLER, BAD_DEVICE, WRONG_LOAN, CUSTODIAN_SIGNAL,
  CUSTODIAN_TIMEOUT, CUSTODIAN_INTERRUPT, CUSTODIAN_ECHILD, CUSTODIAN_WRONG_PID,
  LOAN_CLOSE_ERROR, BIRTH_CLOSE_ERROR, RELEASE_LOST_EFFECT, RELEASE_LOST_NO_EFFECT,
  RELEASE_POSITIVE, LIFETIME_READ_ERROR, LIFETIME_POSITIVE, BAD_COOKIE, BAD_INUM,
  BAD_BORN, BAD_RESERVED, BAD_RELEASE_FLAG, BAD_REFERENCE_FLAG, BAD_GONE_FLAG,
  BAD_POISON_FLAG, REFERENCE_WITHOUT_ATTEMPT, GONE_WITHOUT_ATTEMPT,
  LATE_CONFIG, LATE_DEVICE };
struct raw_model {
  struct tns_owner *birth;
  struct tns_oci_owner *oci;
  enum fault fault;
  unsigned int init_reaps, custodian_signals, custodian_reaps, kernel_releases;
  unsigned int life_reads, loan_closes, birth_closes, kernel_closes;
  int init_exited, custodian_exited, loan_closed, birth_closed;
  int reference_released, net_gone, poisoned;
};
static struct raw_model model;
static unsigned long checks;
#define CHECK(x) do { assert(x); checks++; } while (0)

static void metadata(int fd, struct stat *out) {
  memset(out, 0, sizeof(*out)); out->st_uid = 0; out->st_nlink = 1;
  out->st_dev = 1; out->st_ino = (ino_t)(1000 + fd); out->st_mode = S_IFDIR | 0700;
  out->st_mtim.tv_sec = out->st_ctim.tv_sec = 1;
  if (fd == ROOTFS) out->st_mode = S_IFDIR | 0755;
  if (fd == RECEIPT || fd == CONFIG) {
    out->st_mode = S_IFREG | 0600; out->st_size = fd == RECEIPT ? 7 : 4;
  }
  if (fd == RUNTIME) out->st_mode = S_IFREG | 0755;
  if (fd == LOAN || fd == BIRTH_NS || fd == NETNS) { out->st_dev = 5; out->st_ino = 77; }
  if (fd == PARENT_PIDNS || fd == SELF_PIDNS || fd == CHILDREN_PIDNS || fd == PARENT_OF_INIT) {
    out->st_dev = 8; out->st_ino = 2000;
  }
  if (fd == PRIVATE_PIDNS || fd == FRESH_PIDNS) { out->st_dev = 8; out->st_ino = 3000; }
  if (fd == KERNEL_DEVICE) { out->st_mode = S_IFCHR | 0600; out->st_rdev = 123; }
  if (model.fault == WRONG_LOAN && fd == LOAN) out->st_ino++;
  if ((model.fault == BAD_DEVICE || (model.kernel_releases && model.fault == LATE_DEVICE)) &&
      fd == KERNEL_DEVICE) out->st_rdev++;
  if (model.kernel_releases && model.fault == LATE_CONFIG && fd == CONFIG) out->st_ino++;
}
static void initialize(struct tns_oci_owner *o, struct tns_owner *b) {
  memset(o, 0, sizeof(*o)); memset(b, 0, sizeof(*b));
  model = (struct raw_model){.birth = b, .oci = o}; oci_cancel_requested = 0; errno = 0;
  b->phase = TNS_HELD; b->controller_pid = 1000; b->child = 2000;
  b->pidfd = CUSTODIAN_PIDFD; b->procfd = CUSTODIAN_PROC;
  b->netfd = BIRTH_NS; b->kernel_fd = KERNEL_DEVICE; b->kernel_attempted = 1;
  b->kernel_cookie = 777; b->namespace_loaned = 1; b->control = CONTROL; b->status = -1;
  b->creator = (struct tns_identity){.device = 5, .inode = 66};
  b->identity = (struct tns_identity){.device = 5, .inode = 77};
  metadata(KERNEL_DEVICE, &b->device_identity);
  o->root = ROOT; o->rootfs = ROOTFS; o->receipt = RECEIPT; o->runtime = RUNTIME;
  o->bundle = BUNDLE; o->state = STATE; o->network = LOAN;
  o->controller_pid = 1000; o->init_pid = 3000; o->init_pidfd = INIT_PIDFD;
  o->init_proc = INIT_PROC; o->parent_pidns = PARENT_PIDNS; o->init_pidns = -1;
  o->command_pid = 4000; o->command_joined = o->command_ok = 1;
  o->birth = b; o->identity = b->identity; o->config_created = 1;
  metadata(PARENT_PIDNS, &o->parent_pidns_identity);
  metadata(RUNTIME, &o->runtime_identity); metadata(ROOTFS, &o->rootfs_identity);
  metadata(CONFIG, &o->config_identity);
  memcpy(o->receipt_bytes, "fixture", 7); o->receipt_size = 7;
  memset(o->id, 'a', 64); o->id[64] = 0;
  /* Actual pin and actual consuming original-init wait drive these latches. */
  CHECK(oci_pin_pidns(o) == 0 && o->init_custody);
  model.init_exited = 1;
  struct tns_oci_init_reaped reaped;
  CHECK(tns_oci_stop_init(o, &reaped) == 0 && o->init_joined && model.init_reaps == 1);
}
static pid_t raw_getpid(void) { return model.fault == WRONG_CONTROLLER ? 1001 : 1000; }
static uid_t raw_geteuid(void) { return 0; }
static int raw_prctl(int option, ...) {
  CHECK(option == PR_GET_CHILD_SUBREAPER);
  va_list ap; va_start(ap, option); int *out = va_arg(ap, int *); va_end(ap); *out = 1; return 0;
}
static int raw_sigaction(int number, const struct sigaction *in, struct sigaction *out) {
  CHECK(number == SIGCHLD && !in && out); memset(out, 0, sizeof(*out)); out->sa_handler = SIG_DFL; return 0;
}
static int raw_open(const char *path, int flags, ...) {
  CHECK((flags & O_CLOEXEC) != 0);
  if (!strcmp(path, "/proc/self/ns/pid")) return SELF_PIDNS;
  CHECK(!strcmp(path, "/proc/self/ns/pid_for_children")); return CHILDREN_PIDNS;
}
static int raw_openat(int dir, const char *path, int flags, ...) {
  CHECK((flags & O_CLOEXEC) != 0);
  if (dir == BUNDLE) { CHECK(!strcmp(path, "config.json")); return CONFIG; }
  if (dir == CUSTODIAN_PROC) { CHECK(!strcmp(path, "ns/net")); return NETNS; }
  CHECK(dir == INIT_PROC);
  if (!strcmp(path, "ns/pid")) return FRESH_PIDNS;
  CHECK(!strcmp(path, "ns/net")); return NETNS;
}
static int raw_fstat(int fd, struct stat *out) {
  CHECK(fd >= ROOT && fd <= CONTROL); metadata(fd, out); return 0;
}
static int raw_fstatat(int dir, const char *path, struct stat *out, int flags) {
  CHECK(dir == ROOT && flags == AT_SYMLINK_NOFOLLOW);
  int fd = !strcmp(path, "rootfs") ? ROOTFS : !strcmp(path, "bundle") ? BUNDLE :
           !strcmp(path, "runtime-state") ? STATE : RECEIPT;
  metadata(fd, out); return 0;
}
static int raw_fstatfs(int fd, struct statfs *out) {
  CHECK(fd == LOAN || fd == NETNS || fd == BIRTH_NS ||
        (fd >= PARENT_PIDNS && fd <= PARENT_OF_INIT));
  memset(out, 0, sizeof(*out)); out->f_type = (long)NSFS_MAGIC; return 0;
}
static int raw_close(int fd) {
  if (fd == LOAN) {
    CHECK(model.oci->init_joined && model.oci->namespace_release_attempt && model.oci->network == -1);
    CHECK(!model.loan_closed); model.loan_closed = 1; model.loan_closes++;
    if (model.fault == LOAN_CLOSE_ERROR) { errno = EINTR; return -1; }
  } else if (fd == BIRTH_NS) {
    CHECK(model.custodian_reaps == 1 && !model.birth->child && model.birth->netfd == -1);
    CHECK(!model.birth_closed); model.birth_closed = 1; model.birth_closes++;
    if (model.fault == BIRTH_CLOSE_ERROR) { errno = EINTR; return -1; }
  } else {
    CHECK(fd == NETNS || fd == CONFIG || fd == FRESH_PIDNS || fd == SELF_PIDNS ||
          fd == CHILDREN_PIDNS || fd == PARENT_OF_INIT || fd == CONTROL);
  }
  CHECK(fd != KERNEL_DEVICE); return 0;
}
static long raw_syscall(long number, ...) {
  CHECK(number == SYS_pidfd_send_signal);
  va_list ap; va_start(ap, number); CHECK(va_arg(ap, int) == CUSTODIAN_PIDFD);
  CHECK(va_arg(ap, int) == SIGKILL); CHECK(va_arg(ap, void *) == NULL); CHECK(va_arg(ap, int) == 0); va_end(ap);
  CHECK(model.oci->init_joined && model.birth->kill_attempted && model.birth->namespace_release_attempted);
  CHECK(model.loan_closed && !model.birth_closed);
  model.custodian_signals++;
  if (model.fault == CUSTODIAN_SIGNAL) { errno = EPERM; return -1; }
  model.custodian_exited = 1; return 0;
}
static int raw_poll(struct pollfd *p, nfds_t count, int timeout) {
  CHECK(count == 1 && p->events == POLLIN);
  if (p->fd == INIT_PIDFD) {
    CHECK(timeout == 0 || timeout == 10000);
    p->revents = model.init_exited ? POLLIN : 0; return model.init_exited ? 1 : 0;
  }
  CHECK(p->fd == CUSTODIAN_PIDFD); CHECK(timeout == 0 || timeout == 1000);
  if (timeout && model.fault == CUSTODIAN_TIMEOUT) return 0;
  if (timeout && model.fault == CUSTODIAN_INTERRUPT) { errno = EINTR; return -1; }
  p->revents = model.custodian_exited ? POLLIN : 0; return model.custodian_exited ? 1 : 0;
}
static int raw_waitid(idtype_t type, id_t id, siginfo_t *out, int flags) {
  CHECK(type == P_PIDFD);
  CHECK(flags == (WEXITED | WNOHANG) || flags == (WEXITED | WNOHANG | WNOWAIT));
  if (id == INIT_PIDFD) {
    if (!model.init_exited) { CHECK((flags & WNOWAIT) != 0); return 0; }
    out->si_pid = 3000; out->si_code = CLD_EXITED; out->si_status = 0;
    if (!(flags & WNOWAIT)) { CHECK(!model.init_reaps); model.init_reaps++; }
    return 0;
  }
  CHECK(id == CUSTODIAN_PIDFD && flags == (WEXITED | WNOHANG));
  if (model.fault == CUSTODIAN_ECHILD) { errno = ECHILD; return -1; }
  CHECK(!model.custodian_reaps); model.custodian_reaps++;
  out->si_pid = model.fault == CUSTODIAN_WRONG_PID ? 2001 : 2000;
  out->si_code = CLD_KILLED; out->si_status = SIGKILL; return 0;
}
static int raw_ioctl(int fd, unsigned long request, ...) {
  va_list ap; va_start(ap, request);
  if (request == NS_GET_NSTYPE) {
    va_end(ap); return fd == LOAN || fd == NETNS || fd == BIRTH_NS ? CLONE_NEWNET : CLONE_NEWPID;
  }
  if (request == NS_GET_PARENT) { CHECK(fd == FRESH_PIDNS); va_end(ap); return PARENT_OF_INIT; }
  if (request == NS_GET_PID_FROM_PIDNS) {
    CHECK(fd == FRESH_PIDNS && va_arg(ap, int) == 1); va_end(ap); return 3000;
  }
  CHECK(fd == KERNEL_DEVICE);
  if (request == TAKO_TERMINAL_OBSERVE) {
    struct tako_terminal_observation *out = va_arg(ap, struct tako_terminal_observation *);
    *out = (struct tako_terminal_observation){.net_cookie = 777, .namespace_inum = 77};
    va_end(ap); return 0;
  }
  if (request == TAKO_TERMINAL_RELEASE_NAMESPACE) {
    CHECK(va_arg(ap, unsigned long) == 0UL); va_end(ap);
    CHECK(model.oci->init_joined && model.custodian_reaps == 1 && !model.birth->child);
    CHECK(model.birth->kernel_release_attempted && model.birth_closed && model.loan_closed);
    CHECK(!model.kernel_releases); model.kernel_releases++;
    if (model.fault == RELEASE_LOST_NO_EFFECT) { errno = EINTR; return -1; }
    if (model.fault == RELEASE_POSITIVE) return 7;
    model.reference_released = 1;
    if (model.fault == RELEASE_LOST_EFFECT) { errno = EINTR; return -1; }
    return 0;
  }
  CHECK(request == TAKO_TERMINAL_LIFETIME); model.life_reads++;
  struct tako_terminal_lifetime_observation *out = va_arg(ap, struct tako_terminal_lifetime_observation *);
  va_end(ap);
  if (model.fault == LIFETIME_READ_ERROR) { errno = ENOBUFS; return -1; }
  *out = (struct tako_terminal_lifetime_observation){.net_cookie = 777, .namespace_inum = 77,
    .full_ip_sockets = 11, .requests = 12, .timewait = 13, .packet_groups = 14, .born = 1,
    .release_attempted = (uint32_t)model.reference_released,
    .reference_released = (uint32_t)model.reference_released,
    .net_gone = (uint32_t)model.net_gone, .poisoned = (uint32_t)model.poisoned};
  switch (model.fault) {
    case LIFETIME_POSITIVE: return 1;
    case BAD_COOKIE: out->net_cookie++; break;
    case BAD_INUM: out->namespace_inum++; break;
    case BAD_BORN: out->born = 0; break;
    case BAD_RESERVED: out->reserved = 1; break;
    case BAD_RELEASE_FLAG: out->release_attempted = 2; break;
    case BAD_REFERENCE_FLAG: out->reference_released = 2; break;
    case BAD_GONE_FLAG: out->net_gone = 2; break;
    case BAD_POISON_FLAG: out->poisoned = 2; break;
    case REFERENCE_WITHOUT_ATTEMPT: out->reference_released = 1; break;
    case GONE_WITHOUT_ATTEMPT: out->net_gone = 1; break;
    default: break;
  }
  return 0;
}
static ssize_t raw_pread(int fd, void *out, size_t count, off_t offset) {
  CHECK(fd == RECEIPT && offset >= 0); if (offset >= 7) return 0;
  size_t n = 7u - (size_t)offset; if (n > count) n = count;
  memcpy(out, "fixture" + (size_t)offset, n); return (ssize_t)n;
}
static void retained(const struct tns_oci_owner *o, const struct tns_owner *b) {
  CHECK(o->birth == b && b->kernel_fd == KERNEL_DEVICE && !model.kernel_closes);
  CHECK(o->root == ROOT && o->rootfs == ROOTFS && o->runtime == RUNTIME);
  CHECK(o->bundle == BUNDLE && o->state == STATE && o->init_pidfd == INIT_PIDFD);
  CHECK(o->init_joined && o->init_custody && o->init_pidns == FRESH_PIDNS);
}
static void release_cases(void) {
  struct tns_oci_owner o; struct tns_owner b; struct tns_oci_namespace_lifetime out;
  initialize(&o, &b);
  CHECK(tns_oci_release_namespace(&o, &out) == 0);
  CHECK(o.namespace_release_attempt && o.invalid && o.network == -1 && b.netfd == -1);
  CHECK(!strcmp(out.native_id, o.id) && out.lifetime.identity.inode == 77 && out.lifetime.net_cookie == 777);
  CHECK(out.lifetime.reference_released == 1 && out.lifetime.net_gone == 0);
  CHECK(out.lifetime.full_ip_sockets == 11 && out.lifetime.requests == 12 && out.lifetime.timewait == 13 && out.lifetime.packet_groups == 14);
  CHECK(model.kernel_releases == 1 && model.custodian_signals == 1 && model.custodian_reaps == 1);
  CHECK(tns_oci_release_namespace(&o, &out) < 0 && errno == EALREADY && model.kernel_releases == 1);
  CHECK(tns_oci_observe_namespace_lifetime(&o, &out) == 0 && model.kernel_releases == 1);
  model.net_gone = 1; model.poisoned = 1;
  CHECK(tns_oci_observe_namespace_lifetime(&o, &out) == 0 && out.lifetime.net_gone == 1 && out.lifetime.poisoned == 1);
  CHECK(out.lifetime.full_ip_sockets == 11); /* No netGone -> zero/terminal fabrication. */
  model.net_gone = 0;
  CHECK(tns_oci_observe_namespace_lifetime(&o, &out) < 0 && errno == ESTALE);
  retained(&o, &b);

  for (enum fault f = WRONG_CONTROLLER; f <= LATE_DEVICE; f++) {
    initialize(&o, &b); model.fault = f;
    memset(&out, 0xa5, sizeof(out)); unsigned char sentinel[sizeof(out)]; memcpy(sentinel, &out, sizeof(out));
    CHECK(tns_oci_release_namespace(&o, &out) < 0);
    CHECK(!memcmp(&out, sentinel, sizeof(out)) && o.namespace_release_attempt);
    unsigned int releases = model.kernel_releases, signals = model.custodian_signals;
    CHECK(tns_oci_release_namespace(&o, &out) < 0 && errno == EALREADY);
    CHECK(releases == model.kernel_releases && signals == model.custodian_signals);
    retained(&o, &b);
    if (f == RELEASE_LOST_EFFECT || f == RELEASE_LOST_NO_EFFECT || f == RELEASE_POSITIVE) {
      model.fault = NONE;
      CHECK(tns_oci_observe_namespace_lifetime(&o, &out) == 0);
      CHECK(out.lifetime.reference_released == (uint32_t)model.reference_released && model.kernel_releases == 1);
    }
  }
  initialize(&o, &b); o.init_joined = 0;
  CHECK(tns_oci_release_namespace(&o, &out) < 0 && !model.loan_closes && !model.custodian_signals && !model.kernel_releases);
  initialize(&o, &b); o.start_pid = 5000;
  CHECK(tns_oci_release_namespace(&o, &out) < 0 && !model.loan_closes && !model.custodian_signals && !model.kernel_releases);
  initialize(&o, &b);
  CHECK(tns_oci_observe_namespace_lifetime(&o, &out) < 0 && !model.kernel_releases);
}
int main(void) {
  release_cases();
  printf("actual original init-reap/namespace-release/lifetime raw model: %lu checks\n", checks);
  return 0;
}
