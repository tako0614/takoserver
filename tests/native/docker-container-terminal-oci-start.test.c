#define _GNU_SOURCE
/* Actual production OCI body with pure syscall models. No constructor, child,
 * executable, namespace, device or filesystem operation is executed here. */
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
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/vfs.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "../../scripts/native/docker-container-terminal-oci-stdio.h"
#include "../../scripts/native/docker-container-terminal-namespace.h"

static long raw_syscall(long number, ...);
static int raw_open(const char *path, int flags, ...);
static int raw_openat(int dir, const char *path, int flags, ...);
static int raw_close(int fd);
static int raw_fcntl(int fd, int command, ...);
static int raw_fstat(int fd, struct stat *out);
static int raw_fstatat(int dir, const char *path, struct stat *out, int flags);
static int raw_fstatfs(int fd, struct statfs *out);
static int raw_ioctl(int fd, unsigned long request, ...);
static int raw_poll(struct pollfd *p, nfds_t count, int timeout);
static int raw_waitid(idtype_t type, id_t id, siginfo_t *out, int flags);
static int raw_prctl(int option, ...);
static int raw_sigaction(int number, const struct sigaction *in, struct sigaction *out);
static int raw_clock_gettime(clockid_t id, struct timespec *out);
static pid_t raw_getpid(void);
static uid_t raw_geteuid(void);
static ssize_t raw_pread(int fd, void *out, size_t count, off_t offset);
static ssize_t raw_read(int fd, void *out, size_t count);
static ssize_t raw_write(int fd, const void *out, size_t count);
static int raw_mkdirat(int fd, const char *path, mode_t mode);
static int raw_unlinkat(int fd, const char *path, int flags);
static int raw_fsync(int fd);

#define syscall raw_syscall
#define open raw_open
#define openat raw_openat
#define close raw_close
#define fcntl raw_fcntl
#define fstat raw_fstat
#define fstatat raw_fstatat
#define fstatfs raw_fstatfs
#define ioctl raw_ioctl
#define poll raw_poll
#define waitid raw_waitid
#define prctl raw_prctl
#define sigaction(...) raw_sigaction(__VA_ARGS__)
#define clock_gettime raw_clock_gettime
#define getpid raw_getpid
#define geteuid raw_geteuid
#define pread raw_pread
#define read raw_read
#define write raw_write
#define mkdirat raw_mkdirat
#define unlinkat raw_unlinkat
#define fsync raw_fsync
#include "../../scripts/native/docker-container-terminal-oci.c"
#undef syscall
#undef open
#undef openat
#undef close
#undef fcntl
#undef fstat
#undef fstatat
#undef fstatfs
#undef ioctl
#undef poll
#undef waitid
#undef prctl
#undef sigaction
#undef clock_gettime
#undef getpid
#undef geteuid
#undef pread
#undef read
#undef write
#undef mkdirat
#undef unlinkat
#undef fsync

enum { ROOT = 10, ROOTFS, RECEIPT, RUNTIME, BUNDLE, STATE, NETWORK,
       CREATE_PIDFD, INIT_PIDFD, INIT_PROC, STOPPED_EXE, START_PIDFD,
       CONFIG = 30, NETNS, EXE, PARENT_PIDNS = 40, PRIVATE_PIDNS,
       SELF_PIDNS, CHILDREN_PIDNS, PARENT_OF_INIT };
enum fault { NONE, WRONG_CONTROLLER, NOT_ROOT, CONFIG_CHANGED, BUNDLE_CHANGED,
  BIRTH_CHANGED, CLONE_FAILED, TIMED_OUT, POLL_TIMED_OUT, POLL_INTERRUPTED,
  WAIT_WRONG_PID, WAIT_LOST, CHILD_FAILED, CHILD_KILLED, SAME_EXE,
  EXE_UNREADABLE, EXE_STAT_LOST, NET_CHANGED, INIT_DEAD, LATE_CONFIG, CANCEL_AFTER_SPAWN };
struct raw_model {
  struct tns_oci_owner *owner;
  enum fault fault;
  unsigned int clones, kills, joins, polls, birth_reads, net_reads, stops;
  int64_t milliseconds;
  unsigned int config_reads, cancel_at_config_read;
};
static struct raw_model model;
static unsigned long checks;
#define CHECK(x) do { assert(x); checks++; } while (0)

static void metadata(int fd, struct stat *out) {
  memset(out, 0, sizeof(*out));
  out->st_uid = 0; out->st_nlink = 1; out->st_dev = 1;
  out->st_ino = (ino_t)(1000 + fd);
  out->st_mode = S_IFDIR | 0700;
  out->st_mtim.tv_sec = out->st_ctim.tv_sec = 1;
  if (fd == ROOTFS) out->st_mode = S_IFDIR | 0755;
  if (fd == RECEIPT || fd == CONFIG || fd == RUNTIME || fd == STOPPED_EXE || fd == EXE) {
    out->st_mode = S_IFREG | (fd == RECEIPT || fd == CONFIG ? 0600u : 0755u);
    out->st_size = fd == RECEIPT ? 7 : 4;
  }
  if (fd == EXE) {
    out->st_ino = (ino_t)(model.clones && model.fault != SAME_EXE ? 9001 : 1020);
  }
  if (fd == NETNS) { out->st_dev = 5; out->st_ino = 77; }
  if (fd >= PARENT_PIDNS && fd <= PARENT_OF_INIT) {
    out->st_dev = 8; out->st_ino = (ino_t)(fd == PRIVATE_PIDNS ? 3000 : 2000);
  }
}

static void initialize(struct tns_oci_owner *o, enum fault fault) {
  memset(o, 0, sizeof(*o));
  model = (struct raw_model){.owner = o, .fault = NONE, .milliseconds = 1000};
  oci_cancel_requested = 0;
  o->attempt = o->command_attempt = 1;
  o->command_pid = 8000; o->command_joined = o->command_ok = 1;
  o->root = ROOT; o->rootfs = ROOTFS; o->receipt = RECEIPT; o->runtime = RUNTIME;
  o->bundle = BUNDLE; o->state = STATE; o->network = NETWORK;
  o->command_pidfd = CREATE_PIDFD; o->init_pidfd = INIT_PIDFD;
  o->init_proc = INIT_PROC; o->stopped_exe = STOPPED_EXE; o->start_pidfd = -1;
  o->controller_pid = 1000; o->config_created = 1;
  o->init_pid = 7000; o->parent_pidns = PARENT_PIDNS; o->init_pidns = -1;
  metadata(PARENT_PIDNS, &o->parent_pidns_identity);
  o->birth = (struct tns_owner *)(uintptr_t)1;
  o->identity = (struct tns_identity){.device = 5, .inode = 77};
  metadata(RUNTIME, &o->runtime_identity); metadata(ROOTFS, &o->rootfs_identity);
  metadata(CONFIG, &o->config_identity);
  memcpy(o->receipt_bytes, "fixture", 7); o->receipt_size = 7;
  memset(o->id, 'a', 64); o->id[64] = 0;
  /* Obtain the mandatory pin through the actual new source under the valid
   * closed syscall model before applying each unchanged START fault case. */
  CHECK(oci_pin_pidns(o) == 0 && o->init_custody);
  model.fault = fault;
}

static long raw_syscall(long number, ...) {
  va_list ap; va_start(ap, number);
  if (number == SYS_clone3) {
    struct clone_args *args = va_arg(ap, struct clone_args *);
    size_t size = va_arg(ap, size_t);
    CHECK(size == sizeof(*args)); CHECK(model.owner->start_attempt == 1);
    CHECK(args->flags == (CLONE_PIDFD | CLONE_CLEAR_SIGHAND));
    CHECK(args->exit_signal == SIGCHLD);
    CHECK((int *)(uintptr_t)args->pidfd == &model.owner->start_pidfd);
    model.clones++;
    if (model.fault == CLONE_FAILED) { va_end(ap); errno = EAGAIN; return -1; }
    *(int *)(uintptr_t)args->pidfd = START_PIDFD;
    model.milliseconds = model.fault == TIMED_OUT ? 11000 : 1001;
    if (model.fault == CANCEL_AFTER_SPAWN) oci_cancel_requested = 1;
    va_end(ap); return 9000;
  }
  CHECK(number == SYS_pidfd_send_signal);
  CHECK(va_arg(ap, int) == START_PIDFD); CHECK(va_arg(ap, int) == SIGKILL);
  CHECK(model.owner->start_kill_attempted == 1);
  model.kills++; va_end(ap); return 0;
}
static int raw_prctl(int option, ...) {
  CHECK(option == PR_GET_CHILD_SUBREAPER);
  va_list ap; va_start(ap, option); int *out = va_arg(ap, int *); va_end(ap);
  *out = 1; /* Valid dedicated-helper boundary, refusal cases live in PIDNS test. */
  return 0;
}
static int raw_sigaction(int number, const struct sigaction *in, struct sigaction *out) {
  CHECK(number == SIGCHLD && !in && out);
  memset(out, 0, sizeof(*out)); out->sa_handler = SIG_DFL; return 0;
}
static pid_t raw_getpid(void) { return model.fault == WRONG_CONTROLLER ? 1001 : 1000; }
static uid_t raw_geteuid(void) { return model.fault == NOT_ROOT ? 1u : 0u; }
static int raw_clock_gettime(clockid_t id, struct timespec *out) {
  CHECK(id == CLOCK_MONOTONIC);
  out->tv_sec = (time_t)(model.milliseconds / 1000);
  out->tv_nsec = (long)(model.milliseconds % 1000) * 1000000;
  return 0;
}
static int raw_fstat(int fd, struct stat *out) {
  CHECK(fd >= ROOT && fd <= PARENT_OF_INIT);
  if (fd == STOPPED_EXE && model.clones && model.fault == EXE_STAT_LOST) {
    errno = EIO; return -1;
  }
  metadata(fd, out);
  if (fd == CONFIG && ++model.config_reads == model.cancel_at_config_read)
    tns_oci_note_cancel(); /* Cancellation from the final actual FS-read boundary. */
  if (fd == CONFIG && (model.fault == CONFIG_CHANGED ||
      (model.clones && model.fault == LATE_CONFIG))) out->st_ino++;
  if (fd == NETNS && model.clones && model.fault == NET_CHANGED) out->st_ino++;
  return 0;
}
static int raw_fstatat(int dir, const char *path, struct stat *out, int flags) {
  CHECK(dir == ROOT); CHECK(flags == AT_SYMLINK_NOFOLLOW);
  int fd = !strcmp(path, "rootfs") ? ROOTFS : !strcmp(path, "bundle") ? BUNDLE :
           !strcmp(path, "runtime-state") ? STATE : RECEIPT;
  metadata(fd, out);
  if (fd == BUNDLE && model.fault == BUNDLE_CHANGED) out->st_ino++;
  return 0;
}
static int raw_openat(int dir, const char *path, int flags, ...) {
  CHECK((flags & O_CLOEXEC) != 0);
  if (dir == BUNDLE) { CHECK(!strcmp(path, "config.json")); return CONFIG; }
  CHECK(dir == INIT_PROC);
  if (!strcmp(path, "ns/net")) { model.net_reads++; return NETNS; }
  if (!strcmp(path, "ns/pid")) return PRIVATE_PIDNS;
  CHECK(!strcmp(path, "exe"));
  if (model.clones && model.fault == EXE_UNREADABLE) { errno = EACCES; return -1; }
  return EXE;
}
static int raw_close(int fd) {
  CHECK(fd == CONFIG || fd == NETNS || fd == EXE || fd == PRIVATE_PIDNS ||
        fd == SELF_PIDNS || fd == CHILDREN_PIDNS || fd == PARENT_OF_INIT);
  return 0;
}
static int raw_fcntl(int fd, int command, ...) {
  CHECK(fd == EXE && command == F_DUPFD_CLOEXEC); return STOPPED_EXE;
}
static int raw_fstatfs(int fd, struct statfs *out) {
  CHECK(fd == NETNS || (fd >= PARENT_PIDNS && fd <= PARENT_OF_INIT));
  memset(out, 0, sizeof(*out)); out->f_type = (long)NSFS_MAGIC; return 0;
}
static int raw_ioctl(int fd, unsigned long request, ...) {
  if (fd == NETNS) { CHECK(request == NS_GET_NSTYPE); return CLONE_NEWNET; }
  CHECK(fd >= PARENT_PIDNS && fd <= PARENT_OF_INIT);
  if (request == NS_GET_NSTYPE) return CLONE_NEWPID;
  CHECK(fd == PRIVATE_PIDNS);
  if (request == NS_GET_PARENT) return PARENT_OF_INIT;
  CHECK(request == NS_GET_PID_FROM_PIDNS);
  va_list ap; va_start(ap, request); CHECK(va_arg(ap, int) == 1); va_end(ap);
  return 7000;
}
static ssize_t raw_pread(int fd, void *out, size_t count, off_t offset) {
  const char *bytes = fd == RECEIPT ? "fixture" : "\177ELF";
  size_t size = fd == RECEIPT ? 7u : 4u;
  CHECK(fd == RECEIPT || fd == RUNTIME || fd == EXE); CHECK(offset >= 0);
  if ((uint64_t)offset >= size) return 0;
  size_t n = size - (size_t)offset; if (n > count) n = count;
  memcpy(out, bytes + (size_t)offset, n); return (ssize_t)n;
}
static int raw_poll(struct pollfd *p, nfds_t count, int timeout) {
  CHECK(count == 1 && p->events == POLLIN);
  if (p->fd == INIT_PIDFD) {
    CHECK(timeout == 0);
    if (model.clones && model.fault == INIT_DEAD) { p->revents = POLLIN; return 1; }
    p->revents = 0; return 0;
  }
  CHECK(p->fd == START_PIDFD); CHECK(timeout >= 0 && timeout <= 10000);
  model.polls++;
  if (model.polls == 1 && model.fault == POLL_TIMED_OUT) return 0;
  if (model.polls == 1 && model.fault == POLL_INTERRUPTED) { errno = EINTR; return -1; }
  p->revents = POLLIN; return 1;
}
static int raw_waitid(idtype_t type, id_t id, siginfo_t *out, int flags) {
  CHECK(type == P_PIDFD);
  if (id == INIT_PIDFD) {
    CHECK(flags == (WEXITED | WNOHANG | WNOWAIT));
    CHECK(model.owner->init_pid == 7000 && model.owner->parent_pidns == PARENT_PIDNS);
    return 0; /* Pure live/waitable init; all refusal variants have new tests. */
  }
  CHECK(id == START_PIDFD); CHECK(flags == (WEXITED | WNOHANG));
  model.joins++;
  if (model.fault == WAIT_LOST) { errno = ECHILD; return -1; }
  out->si_pid = model.fault == WAIT_WRONG_PID && model.joins == 1 ? 9001 : 9000;
  out->si_code = model.fault == CHILD_KILLED ? CLD_KILLED : CLD_EXITED;
  out->si_status = model.fault == CHILD_FAILED ? 1 : 0;
  return 0;
}

int tns_owner_observe(struct tns_owner *owner, struct tns_identity *out) {
  CHECK(owner == model.owner->birth); model.birth_reads++;
  *out = model.owner->identity;
  if (model.clones && model.fault == BIRTH_CHANGED) out->inode++;
  return 0;
}
int tns_owner_stop_custodian(struct tns_owner *owner) {
  CHECK(owner == model.owner->birth); model.stops++; return 0;
}
int tns_owner_create(struct tns_owner **owner) { (void)owner; abort(); }
int tns_owner_dup_namespace(struct tns_owner *owner) { (void)owner; abort(); }
int tns_owner_close(struct tns_owner **owner) { (void)owner; abort(); }
static int raw_open(const char *path, int flags, ...) {
  CHECK((flags & O_CLOEXEC) != 0);
  if (!strcmp(path, "/proc/self/ns/pid")) return SELF_PIDNS;
  CHECK(!strcmp(path, "/proc/self/ns/pid_for_children")); return CHILDREN_PIDNS;
}
static ssize_t raw_read(int fd, void *out, size_t count) { (void)fd; (void)out; (void)count; abort(); }
static ssize_t raw_write(int fd, const void *out, size_t count) { (void)fd; (void)out; (void)count; abort(); }
static int raw_mkdirat(int fd, const char *path, mode_t mode) { (void)fd; (void)path; (void)mode; abort(); }
static int raw_unlinkat(int fd, const char *path, int flags) { (void)fd; (void)path; (void)flags; abort(); }
static int raw_fsync(int fd) { (void)fd; abort(); }

static void retained(const struct tns_oci_owner *o) {
  CHECK(o->command_pid == 8000 && o->network == NETWORK && o->init_pidfd == INIT_PIDFD);
  CHECK(o->root == ROOT && o->runtime == RUNTIME && o->stopped_exe == STOPPED_EXE);
  CHECK(o->bundle == BUNDLE && o->state == STATE && o->init_proc == INIT_PROC);
}

static void start_cases(void) {
  struct tns_oci_owner owner; struct tns_oci_started started;
  initialize(&owner, NONE);
  CHECK(tns_oci_start(&owner, &started) == 0);
  CHECK(owner.start_attempt && owner.start_joined && owner.start_ok && !owner.invalid);
  CHECK(model.clones == 1 && model.kills == 0 && model.net_reads >= 3);
  CHECK(!strcmp(started.native_id, owner.id) && started.namespace_inode == 77);
  CHECK(tns_oci_observe_started(&owner, &started) == 0);
  struct tns_oci_created stopped;
  CHECK(tns_oci_observe(&owner, &stopped) < 0);
  CHECK(tns_oci_start(&owner, &started) < 0 && errno == EALREADY && model.clones == 1);
  retained(&owner);

  for (enum fault f = WRONG_CONTROLLER; f <= CANCEL_AFTER_SPAWN; f++) {
    initialize(&owner, f);
    CHECK(tns_oci_start(&owner, &started) < 0);
    CHECK(owner.invalid);
    if (f == WRONG_CONTROLLER || f == NOT_ROOT || f == CONFIG_CHANGED || f == BUNDLE_CHANGED) {
      CHECK(model.clones == 0);
    } else {
      CHECK(model.clones == 1 && owner.start_attempt == 1);
    }
    unsigned int previous = model.clones;
    CHECK(tns_oci_start(&owner, &started) < 0 && model.clones == previous);
    retained(&owner);
    if (f == WAIT_LOST) {
      CHECK(owner.start_joined == 0 && owner.start_kill_attempted && model.kills == 1);
      model.fault = NONE;
      CHECK(tns_oci_cancel(&owner) == 0 && owner.start_joined && model.kills == 1);
      retained(&owner);
    }
    if (f == TIMED_OUT || f == POLL_TIMED_OUT || f == POLL_INTERRUPTED || f == CANCEL_AFTER_SPAWN)
      CHECK(model.kills == 1 && owner.start_joined);
  }
  initialize(&owner, NONE); owner.stopped_exe = -1;
  CHECK(tns_oci_start(&owner, &started) == 0 && owner.stopped_exe == STOPPED_EXE);
  CHECK(tns_oci_release_uncreated(&(struct tns_oci_owner *){&owner}) < 0 && errno == EBUSY);
}

static void parser_cases(void) {
  const char *valid[] = {"{\"kind\":\"linux-oci-start@1\"}",
                         "{\"kind\":\"linux-oci-observe-started@1\"}"};
  struct tns_ocip_request request;
  unsigned char bytes[256];
  for (size_t i = 0; i < 2; i++) {
    size_t size = strlen(valid[i]); memcpy(bytes, valid[i], size);
    CHECK(tns_ocip_decode(bytes, size, &request) == 0);
    CHECK(request.kind == (i ? TNS_OCIP_OBSERVE_STARTED : TNS_OCIP_START));
    for (size_t j = 0; j < size; j++) {
      memcpy(bytes, valid[i], size); CHECK(tns_ocip_decode(bytes, j, &request) < 0);
    }
  }
  const char *bad[] = {"{\"kind\":\"linux-oci-start@1\",\"uid\":0}",
    "{\"kind\":\"linux-oci-start@1\",\"nativeId\":\"x\"}",
    "{\"kind\":\"linux-oci-start@1\",\"kind\":\"linux-oci-start@1\"}",
    "{\"kind\":\"linux-oci-observe-started@1\",\"generation\":1}",
    "{\"kind\":\"linux-oci-start@2\"}", "{\"kind\":\"linux-oci-start@1\"}x"};
  for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
    size_t size = strlen(bad[i]); memcpy(bytes, bad[i], size);
    CHECK(tns_ocip_decode(bytes, size, &request) < 0);
  }
}

static int late_cancel_cases(void) {
  struct tns_oci_owner owner; struct tns_oci_started started;
  initialize(&owner, NONE); model.cancel_at_config_read = 6;
  int result = tns_oci_start(&owner, &started);
  int start_error = errno;
  int first = result < 0 && start_error == ECANCELED && owner.invalid &&
              model.config_reads == 6 && oci_cancel_requested && model.clones == 1;
  printf("late-cancel actual START: result=%d errno=%d configReads=%u refused=%d\n",
         result, start_error, model.config_reads, first);
  initialize(&owner, NONE);
  owner.start_attempt = 1; owner.start_joined = owner.start_ok = 1;
  model.clones = 1; model.cancel_at_config_read = 4;
  result = tns_oci_observe_started(&owner, &started);
  int observe_error = errno;
  int second = result < 0 && observe_error == ECANCELED && owner.invalid &&
               model.config_reads == 4 && oci_cancel_requested && model.clones == 1;
  printf("late-cancel actual observeStarted: result=%d errno=%d configReads=%u refused=%d\n",
         result, observe_error, model.config_reads, second);
  printf("late-cancel selected actual-body raw model: %lu boundary checks\n", checks);
  return first && second ? 0 : 1;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--late-cancel")) return late_cancel_cases();
  if (argc != 1) return 2;
  start_cases(); parser_cases();
  printf("actual OCI START body + closed parser raw model: %lu checks\n", checks);
  return 0;
}

/* New unexercised boundary in this unchanged cohort: never fabricate a result. */
int tns_owner_release_namespace(struct tns_owner *owner, struct tns_lifetime *lifetime) {
  (void)owner; (void)lifetime; abort();
}
int tns_owner_observe_lifetime(struct tns_owner *owner, struct tns_lifetime *lifetime) {
  (void)owner; (void)lifetime; abort();
}

/* Unexercised continuation boundary in this cohort: never fabricate progress. */
int tns_owner_continue_namespace_release(struct tns_owner *owner, struct tns_lifetime *lifetime) {
  (void)owner; (void)lifetime; abort();
}

int tns_owner_observe_creator(struct tns_owner *owner, struct tns_identity *identity) {
  (void)owner; (void)identity; abort();
}

/* Link-only compatibility for the new mandatory original admission ABI.
 * These older raw models do not implement it and must never fake success. */
int tns_owner_open_admission(struct tns_owner *owner) { (void)owner; abort(); }
int tns_owner_cut_admission(struct tns_owner *owner) { (void)owner; abort(); }
int tns_owner_admission_current(struct tns_owner *owner) { (void)owner; abort(); }

/* Link compatibility only; these old cohorts never model tracked join. */
int tns_owner_begin_tracked_join(struct tns_owner *owner) {
  (void)owner; abort();
}
int tns_owner_read_tracked_join(struct tns_owner *owner) {
  (void)owner; abort();
}

/* Link compatibility only; old cohorts never model tracked disposal. */
int tns_owner_dispose_tracked(struct tns_owner **slot) {
  (void)slot; abort();
}
int tns_owner_dispose_released(struct tns_owner **slot) { (void)slot; abort(); }
