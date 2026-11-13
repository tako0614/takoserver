#define _GNU_SOURCE
/* Actual OCI source with pure syscall models. No constructor, real process,
 * signal, device, namespace, executable or filesystem operation is run. */
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
#undef getpid
#undef geteuid
#undef pread
#undef read
#undef write
#undef mkdirat
#undef unlinkat
#undef fsync

enum { ROOT = 10, ROOTFS, RECEIPT, RUNTIME, BUNDLE, STATE, NETWORK,
       CREATE_PIDFD, INIT_PIDFD, INIT_PROC, STOPPED_EXE,
       CONFIG = 30, NETNS, EXE, INIT_FILE, PARENT_PIDNS = 40, INIT_PIDNS,
       SELF_PIDNS, CHILDREN_PIDNS, PARENT_OF_INIT, FRESH_INIT_PIDNS };
enum fault { NONE, NO_REAPER, GET_REAPER_FAIL, SIG_IGNORED, NO_CLD_WAIT,
  SIGACTION_FAIL, WRONG_CONTROLLER, NOT_ROOT, PARENT_CHANGED, CHILDREN_CHANGED,
  SHARED_PIDNS, WRONG_PARENT, BAD_NSFS, WRONG_NS_TYPE, WRONG_MAPPING,
  UNSUPPORTED_MAPPING, WAIT_ECHILD, LIVE_MALFORMED, INIT_ALREADY_EXITED,
  NET_CHANGED, SIGNAL_DENIED, SIGNAL_ESRCH, JOIN_TIMEOUT, JOIN_INTERRUPT,
  JOIN_BAD_EVENTS, PEEK_WRONG_PID, PEEK_BAD_CODE, PEEK_BAD_STATUS,
  REAP_ECHILD, REAP_WRONG_PID, REAP_CHANGED_STATUS, LATE_CONFIG, LATE_BIRTH,
  LATE_PARENT, HELD_PIDNS_CHANGED };
struct raw_model {
  struct tns_oci_owner *owner;
  enum fault fault;
  int exited, reaped;
  unsigned int signals, peeks, consumes, waits, mappings, births, parent_reads;
};
static struct raw_model model;
static unsigned long checks;
#define CHECK(x) do { assert(x); checks++; } while (0)

static void metadata(int fd, struct stat *out) {
  memset(out, 0, sizeof(*out));
  out->st_uid = 0; out->st_nlink = 1; out->st_dev = 1;
  out->st_ino = (ino_t)(1000 + fd); out->st_mode = S_IFDIR | 0700;
  out->st_mtim.tv_sec = out->st_ctim.tv_sec = 1;
  if (fd == ROOTFS) out->st_mode = S_IFDIR | 0755;
  if (fd == RECEIPT || fd == CONFIG || fd == INIT_FILE) {
    out->st_mode = S_IFREG | 0600; out->st_size = fd == RECEIPT ? 7 : 5;
  }
  if (fd == RUNTIME || fd == STOPPED_EXE || fd == EXE) {
    out->st_mode = S_IFREG | 0755; out->st_size = 4;
  }
  if (fd == NETNS) { out->st_dev = 5; out->st_ino = 77; }
  if (fd >= PARENT_PIDNS && fd <= FRESH_INIT_PIDNS) {
    out->st_dev = 8;
    out->st_ino = (ino_t)(fd == INIT_PIDNS || fd == FRESH_INIT_PIDNS ? 3000 : 2000);
  }
  if (model.fault == PARENT_CHANGED && fd == SELF_PIDNS) out->st_ino++;
  if (model.fault == CHILDREN_CHANGED && fd == CHILDREN_PIDNS) out->st_ino++;
  if (model.fault == SHARED_PIDNS && (fd == INIT_PIDNS || fd == FRESH_INIT_PIDNS))
    out->st_ino = 2000;
  if (model.fault == WRONG_PARENT && fd == PARENT_OF_INIT) out->st_ino++;
  if (model.fault == NET_CHANGED && fd == NETNS) out->st_ino++;
  if (model.fault == HELD_PIDNS_CHANGED && fd == FRESH_INIT_PIDNS) out->st_ino++;
  if (model.reaped && model.fault == LATE_CONFIG && fd == CONFIG) out->st_ino++;
  if (model.reaped && model.fault == LATE_PARENT && fd == SELF_PIDNS) out->st_ino++;
}

static void initialize(struct tns_oci_owner *o) {
  memset(o, 0, sizeof(*o)); model = (struct raw_model){.owner = o};
  oci_cancel_requested = 0; errno = 0;
  o->attempt = o->command_attempt = 1;
  o->command_pid = 8000; o->command_joined = o->command_ok = 1;
  o->root = ROOT; o->rootfs = ROOTFS; o->receipt = RECEIPT; o->runtime = RUNTIME;
  o->bundle = BUNDLE; o->state = STATE; o->network = NETWORK;
  o->command_pidfd = CREATE_PIDFD; o->init_pidfd = INIT_PIDFD;
  o->init_proc = INIT_PROC; o->stopped_exe = STOPPED_EXE; o->start_pidfd = -1;
  o->controller_pid = 1000; o->init_pid = 9000; o->config_created = 1;
  o->parent_pidns = PARENT_PIDNS; o->init_pidns = -1;
  o->birth = (struct tns_owner *)(uintptr_t)1;
  o->identity = (struct tns_identity){.device = 5, .inode = 77};
  metadata(RUNTIME, &o->runtime_identity); metadata(ROOTFS, &o->rootfs_identity);
  metadata(CONFIG, &o->config_identity); metadata(PARENT_PIDNS, &o->parent_pidns_identity);
  memcpy(o->receipt_bytes, "fixture", 7); o->receipt_size = 7;
  memset(o->id, 'a', 64); o->id[64] = 0;
}
static int raw_prctl(int option, ...) {
  CHECK(option == PR_GET_CHILD_SUBREAPER); /* Library never sets caller state. */
  if (model.fault == GET_REAPER_FAIL) { errno = ENOTSUP; return -1; }
  va_list ap; va_start(ap, option); int *out = va_arg(ap, int *); va_end(ap);
  *out = model.fault == NO_REAPER ? 0 : 1; return 0;
}
static int raw_sigaction(int number, const struct sigaction *in, struct sigaction *out) {
  CHECK(number == SIGCHLD && !in && out);
  if (model.fault == SIGACTION_FAIL) { errno = EIO; return -1; }
  memset(out, 0, sizeof(*out)); out->sa_handler = model.fault == SIG_IGNORED ? SIG_IGN : SIG_DFL;
  out->sa_flags = model.fault == NO_CLD_WAIT ? SA_NOCLDWAIT : 0; return 0;
}
static pid_t raw_getpid(void) { return model.fault == WRONG_CONTROLLER ? 1001 : 1000; }
static uid_t raw_geteuid(void) { return model.fault == NOT_ROOT ? 1u : 0u; }
static long raw_syscall(long number, ...) {
  va_list ap; va_start(ap, number);
  if (number == SYS_pidfd_open) {
    CHECK(va_arg(ap, int) == 9000); CHECK(va_arg(ap, int) == 0);
    va_end(ap); return INIT_PIDFD;
  }
  CHECK(number == SYS_pidfd_send_signal);
  CHECK(va_arg(ap, int) == INIT_PIDFD); CHECK(va_arg(ap, int) == SIGKILL);
  CHECK(va_arg(ap, void *) == NULL); CHECK(va_arg(ap, int) == 0);
  CHECK(model.owner->init_stop_attempt == 1 && model.owner->invalid == 1);
  CHECK(!model.reaped); model.signals++; va_end(ap);
  if (model.fault == SIGNAL_DENIED) { errno = EPERM; return -1; }
  model.exited = 1;
  if (model.fault == SIGNAL_ESRCH) { errno = ESRCH; return -1; }
  return 0;
}
static int raw_open(const char *path, int flags, ...) {
  CHECK((flags & O_CLOEXEC) != 0);
  if (!strcmp(path, "/proc/self/ns/pid")) return SELF_PIDNS;
  if (!strcmp(path, "/proc/self/ns/pid_for_children")) return CHILDREN_PIDNS;
  CHECK(!strcmp(path, "/proc/9000")); return INIT_PROC;
}
static int raw_openat(int dir, const char *path, int flags, ...) {
  CHECK((flags & O_CLOEXEC) != 0);
  if (dir == BUNDLE) {
    if (!strcmp(path, "init.pid")) return INIT_FILE;
    CHECK(!strcmp(path, "config.json")); return CONFIG;
  }
  CHECK(dir == INIT_PROC);
  if (!strcmp(path, "ns/pid")) return FRESH_INIT_PIDNS;
  CHECK(!strcmp(path, "ns/net")); return NETNS;
}
static int raw_close(int fd) {
  CHECK(fd == SELF_PIDNS || fd == CHILDREN_PIDNS || fd == PARENT_OF_INIT ||
        fd == FRESH_INIT_PIDNS || fd == NETNS || fd == CONFIG || fd == INIT_FILE);
  return 0;
}
static int raw_fstat(int fd, struct stat *out) {
  CHECK(fd >= ROOT && fd <= FRESH_INIT_PIDNS); metadata(fd, out); return 0;
}
static int raw_fstatat(int dir, const char *path, struct stat *out, int flags) {
  CHECK(dir == ROOT && flags == AT_SYMLINK_NOFOLLOW);
  int fd = !strcmp(path, "rootfs") ? ROOTFS : !strcmp(path, "bundle") ? BUNDLE :
           !strcmp(path, "runtime-state") ? STATE : RECEIPT;
  metadata(fd, out); return 0;
}
static int raw_fstatfs(int fd, struct statfs *out) {
  memset(out, 0, sizeof(*out));
  out->f_type = (long)(fd == INIT_PROC ? PROC_SUPER_MAGIC : NSFS_MAGIC);
  if (model.fault == BAD_NSFS && fd == FRESH_INIT_PIDNS) out->f_type++;
  return 0;
}
static int raw_ioctl(int fd, unsigned long request, ...) {
  if (request == NS_GET_NSTYPE) {
    if (fd == NETNS) return CLONE_NEWNET;
    CHECK(fd >= PARENT_PIDNS && fd <= FRESH_INIT_PIDNS);
    return model.fault == WRONG_NS_TYPE && fd == FRESH_INIT_PIDNS ? CLONE_NEWNET : CLONE_NEWPID;
  }
  if (request == NS_GET_PARENT) {
    CHECK(fd == FRESH_INIT_PIDNS); model.parent_reads++; return PARENT_OF_INIT;
  }
  CHECK(request == NS_GET_PID_FROM_PIDNS && fd == FRESH_INIT_PIDNS);
  va_list ap; va_start(ap, request); CHECK(va_arg(ap, int) == 1); va_end(ap);
  model.mappings++;
  if (model.fault == UNSUPPORTED_MAPPING) { errno = ENOTTY; return -1; }
  return model.fault == WRONG_MAPPING ? 9001 : 9000;
}
static int raw_poll(struct pollfd *p, nfds_t count, int timeout) {
  CHECK(count == 1 && p->fd == INIT_PIDFD && p->events == POLLIN);
  if (!timeout) { p->revents = model.exited ? POLLIN : 0; return model.exited ? 1 : 0; }
  CHECK(timeout == 10000); model.waits++;
  if (model.fault == JOIN_TIMEOUT) return 0;
  if (model.fault == JOIN_INTERRUPT) { errno = EINTR; return -1; }
  if (model.fault == JOIN_BAD_EVENTS) { p->revents = POLLHUP; return 1; }
  p->revents = model.exited ? POLLIN : 0; return model.exited ? 1 : 0;
}
static int raw_waitid(idtype_t type, id_t id, siginfo_t *out, int flags) {
  CHECK(type == P_PIDFD && id == INIT_PIDFD);
  CHECK(flags == (WEXITED | WNOHANG | WNOWAIT) || flags == (WEXITED | WNOHANG));
  int peek = (flags & WNOWAIT) != 0;
  if (peek) model.peeks++; else model.consumes++;
  if (model.fault == WAIT_ECHILD || model.reaped || (!peek && model.fault == REAP_ECHILD)) {
    errno = ECHILD; return -1;
  }
  if (!model.exited) {
    if (model.fault == LIVE_MALFORMED) out->si_status = 1;
    return 0;
  }
  out->si_pid = model.fault == PEEK_WRONG_PID || (!peek && model.fault == REAP_WRONG_PID) ? 9001 : 9000;
  out->si_signo = SIGCHLD;
  out->si_code = model.fault == PEEK_BAD_CODE ? CLD_STOPPED : CLD_KILLED;
  out->si_status = model.fault == PEEK_BAD_STATUS ? NSIG :
    !peek && model.fault == REAP_CHANGED_STATUS ? SIGTERM : SIGKILL;
  if (!peek) model.reaped = 1;
  return 0;
}
static ssize_t raw_pread(int fd, void *out, size_t count, off_t offset) {
  CHECK(fd == RECEIPT); CHECK(offset >= 0);
  if (offset >= 7) return 0;
  size_t n = 7u - (size_t)offset; if (n > count) n = count;
  memcpy(out, "fixture" + (size_t)offset, n); return (ssize_t)n;
}
static ssize_t raw_read(int fd, void *out, size_t count) {
  CHECK(fd == INIT_FILE && count >= 5); memcpy(out, "9000\n", 5); return 5;
}
int tns_owner_observe(struct tns_owner *owner, struct tns_identity *out) {
  CHECK(owner == model.owner->birth); model.births++; *out = model.owner->identity;
  if (model.reaped && model.fault == LATE_BIRTH) out->inode++;
  return 0;
}
int tns_owner_stop_custodian(struct tns_owner *owner) { (void)owner; abort(); }
int tns_owner_create(struct tns_owner **owner) { (void)owner; abort(); }
int tns_owner_dup_namespace(struct tns_owner *owner) { (void)owner; abort(); }
int tns_owner_close(struct tns_owner **owner) { (void)owner; abort(); }
static int raw_fcntl(int fd, int command, ...) { (void)fd; (void)command; abort(); }
static ssize_t raw_write(int fd, const void *out, size_t count) { (void)fd; (void)out; (void)count; abort(); }
static int raw_mkdirat(int fd, const char *path, mode_t mode) { (void)fd; (void)path; (void)mode; abort(); }
static int raw_unlinkat(int fd, const char *path, int flags) { (void)fd; (void)path; (void)flags; abort(); }
static int raw_fsync(int fd) { (void)fd; abort(); }

static void pin(struct tns_oci_owner *o) {
  CHECK(oci_pin_init(o) == 0);
  CHECK(o->init_pid == 9000 && o->init_pidfd == INIT_PIDFD && o->init_proc == INIT_PROC);
  CHECK(oci_pin_pidns(o) == 0 && o->init_custody && o->init_pidns == FRESH_INIT_PIDNS);
  CHECK(model.mappings > 0 && model.peeks > 0 && model.consumes == 0);
}
static void retained(const struct tns_oci_owner *o) {
  CHECK(o->network == NETWORK && o->init_pidfd == INIT_PIDFD && o->init_proc == INIT_PROC);
  CHECK(o->root == ROOT && o->runtime == RUNTIME && o->birth);
  CHECK(o->bundle == BUNDLE && o->state == STATE && o->parent_pidns == PARENT_PIDNS);
  CHECK(o->init_pidns == FRESH_INIT_PIDNS);
}
static void pin_cases(void) {
  struct tns_oci_owner owner;
  initialize(&owner); pin(&owner);
  CHECK(!owner.init_stop_attempt && !owner.invalid && !model.signals);
  for (enum fault f = NO_REAPER; f <= LIVE_MALFORMED; f++) {
    initialize(&owner); model.fault = f;
    CHECK(oci_pin_pidns(&owner) < 0 && !owner.init_custody);
    CHECK(model.signals == 0 && model.consumes == 0);
  }
  initialize(&owner); model.exited = 1;
  CHECK(oci_pin_pidns(&owner) < 0 && !owner.init_custody);
  initialize(&owner); model.fault = NET_CHANGED;
  CHECK(oci_pin_pidns(&owner) < 0 && !owner.init_custody);
}
static void reap_cases(void) {
  struct tns_oci_owner owner; struct tns_oci_init_reaped out;
  initialize(&owner); pin(&owner);
  CHECK(tns_oci_join_init(&owner, &out) < 0 && !model.signals && !model.consumes);
  CHECK(tns_oci_stop_init(&owner, &out) == 0);
  CHECK(owner.init_stop_attempt && owner.init_joined && owner.invalid);
  CHECK(model.signals == 1 && model.consumes == 1);
  CHECK(!strcmp(out.native_id, owner.id) && out.namespace_inode == 77 && out.pid_namespace_inode == 3000);
  CHECK(tns_oci_stop_init(&owner, &out) < 0 && errno == EALREADY);
  CHECK(tns_oci_join_init(&owner, &out) == 0 && model.consumes == 1 && model.signals == 1);
  struct tns_oci_started started;
  CHECK(tns_oci_start(&owner, &started) < 0);
  CHECK(tns_oci_cancel(&owner) == 0 && model.signals == 1); retained(&owner);

  initialize(&owner); pin(&owner); model.exited = 1;
  CHECK(tns_oci_stop_init(&owner, &out) == 0 && model.signals == 0 && model.consumes == 1);
  retained(&owner);
  for (enum fault f = SIGNAL_DENIED; f <= HELD_PIDNS_CHANGED; f++) {
    initialize(&owner); pin(&owner); model.fault = f;
    int result = tns_oci_stop_init(&owner, &out);
    if (f == SIGNAL_ESRCH) CHECK(result == 0);
    else CHECK(result < 0);
    CHECK(owner.init_stop_attempt && owner.invalid && model.signals <= 1);
    unsigned int signals = model.signals, consumes = model.consumes;
    CHECK(tns_oci_stop_init(&owner, &out) < 0 && errno == EALREADY && model.signals == signals);
    retained(&owner);
    if (f == JOIN_TIMEOUT || f == JOIN_INTERRUPT || f == JOIN_BAD_EVENTS || f == SIGNAL_DENIED) {
      model.fault = NONE; model.exited = 1;
      CHECK(tns_oci_join_init(&owner, &out) == 0 && model.signals == signals && model.consumes == 1);
    }
    if (f == REAP_WRONG_PID || f == REAP_CHANGED_STATUS) {
      CHECK(!owner.init_joined && model.reaped);
      model.fault = NONE;
      CHECK(tns_oci_join_init(&owner, &out) < 0 && errno == ECHILD && model.signals == signals);
    }
    if (f == LATE_CONFIG || f == LATE_BIRTH || f == LATE_PARENT) {
      CHECK(owner.init_joined && consumes == 1);
      model.fault = NONE;
      CHECK(tns_oci_join_init(&owner, &out) == 0 && model.consumes == 1 && model.signals == signals);
    }
  }
  initialize(&owner); pin(&owner); owner.init_custody = 0;
  CHECK(tns_oci_stop_init(&owner, &out) < 0 && !model.signals && !model.consumes);
  initialize(&owner); pin(&owner); model.fault = WAIT_ECHILD;
  CHECK(tns_oci_stop_init(&owner, &out) < 0 && !model.signals && !model.consumes);
  CHECK(tns_oci_join_init(&owner, &out) < 0 && !owner.init_joined);
}
static void parser_cases(void) {
  const char *kinds[] = {"linux-oci-stop-init@1", "linux-oci-join-init@1"};
  unsigned char bytes[256]; struct tns_ocip_request request;
  for (size_t i = 0; i < 2; i++) {
    int n = snprintf((char *)bytes, sizeof(bytes), "{\"kind\":\"%s\"}", kinds[i]);
    CHECK(n > 0 && (size_t)n < sizeof(bytes)); size_t size = (size_t)n;
    unsigned char original[256]; memcpy(original, bytes, size);
    CHECK(tns_ocip_decode(bytes, size, &request) == 0);
    CHECK(request.kind == (i ? TNS_OCIP_JOIN_INIT : TNS_OCIP_STOP_INIT));
    for (size_t j = 0; j < size; j++) {
      memcpy(bytes, original, size); CHECK(tns_ocip_decode(bytes, j, &request) < 0);
    }
  }
  const char *bad[] = {"{\"kind\":\"linux-oci-stop-init@1\",\"pid\":7}",
    "{\"kind\":\"linux-oci-join-init@1\",\"ready\":true}",
    "{\"kind\":\"linux-oci-stop-init@1\",\"kind\":\"linux-oci-join-init@1\"}",
    "{\"kind\":\"linux-oci-stop-init@2\"}", "{\"kind\":\"linux-oci-join-init@1\"}x"};
  for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
    size_t size = strlen(bad[i]); memcpy(bytes, bad[i], size);
    CHECK(tns_ocip_decode(bytes, size, &request) < 0);
  }
}
int main(void) {
  pin_cases(); reap_cases(); parser_cases();
  printf("actual OCI PIDNS/init pin-stop-reap + closed parser raw model: %lu checks\n", checks);
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
