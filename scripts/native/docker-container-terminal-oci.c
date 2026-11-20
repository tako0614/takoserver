#define _GNU_SOURCE
#include "docker-container-terminal-oci.h"
#include "docker-container-terminal-namespace.h"

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

/* Linux v6.12 NSFS translates the actual namespace's init into this caller's
 * PID namespace. Older/unsupported kernels refuse; there is no text fallback. */
#ifndef NS_GET_PID_FROM_PIDNS
#define NS_GET_PID_FROM_PIDNS _IOR(NSIO, 0x6, int)
#endif

/* Actual CREATE/START producer library; no admission/delete/retirement grant.
 * The persistent original helper must retain this private owner after return,
 * including UNKNOWN. Native execution and runtime provenance are unqualified.
 * Caller must serialize this owner and exclusively reap its command child. */
struct oci_uplink_owner;
struct oci_policy_owner;
struct oci_admission_owner;
/* Chosen only by a fixed private constructor before any original effect.
 * This profile changes runtime-delete ordering, never terminal permission. */
enum oci_retirement_profile { OCI_RETIREMENT_TRACKED, OCI_RETIREMENT_RUNTIME_FIRST, OCI_RETIREMENT_RUNTIME_LOCAL };
struct tns_oci_owner {
  enum oci_retirement_profile retirement_profile;
  struct oci_uplink_owner *uplink;
  struct oci_policy_owner *policy;
  struct oci_admission_owner *admission;
  unsigned int admission_attempt;
  int admission_ruleset_reads;
  unsigned int attempt;
  unsigned int command_attempt;
  int command_joined;
  int command_ok;
  int kill_attempted;
  int invalid;
  int config_created;
  unsigned int start_attempt;
  int start_joined, start_ok, start_kill_attempted;
  int start_pidfd, stopped_exe;
  /* Separate born DELETE custody; original CREATE/START proofs never change.
   * These FDs are initialized before any delete-side acquisition and retained
   * through all failures. Their later cleanup is a separate source phase. */
  unsigned int delete_attempt, delete_wait_attempted;
  pid_t delete_pid;
  int delete_pidfd, delete_state_fd, delete_state_pinned;
  int delete_joined, delete_ok;
  struct stat delete_state_identity;
  /* Dedicated local born disposal; old execution/currentness proofs stay
   * unchanged until all local phases are known and this object is freed. */
  unsigned int born_dispose_phase, born_config_unlink_attempted;
  int born_dispose_selected;
  int born_config_fd, born_dispose_unknown;
  pid_t start_pid, controller_pid, init_pid;
  int parent_pidns, init_pidns, init_custody, init_joined;
  unsigned int init_stop_attempt;
  unsigned int namespace_release_attempt;
  int namespace_release_dispatched;
  /* Set only by the successful actual release/readback path, not dispatch. */
  int runtime_first_namespace_known, runtime_first_handoff_known;
  int namespace_loan_close_unknown;
  struct stat parent_pidns_identity, init_pidns_identity;
  int root, rootfs, receipt, runtime, bundle, state, network, command_pidfd;
  int init_pidfd, init_proc;
  pid_t command_pid;
  struct tns_owner *birth;
  struct tns_identity identity;
  struct stat runtime_identity;
  struct stat rootfs_identity;
  struct stat config_identity;
  char id[65];
  char rootpath[4096], netpath[96], bundlepath[96], statepath[96], pidpath[128];
  char receipt_bytes[8192];
  size_t receipt_size;
  /* Optional original-root input selects only an additional birth DROP guard.
   * No field authorizes OPEN, accepted policy completion, or serving. */
  int egress_selected, egress_file, egress_binary;
  unsigned int egress_guard_attempt, egress_file_attempt, egress_binary_attempt;
  int egress_guard_verified, egress_close_unknown;
  int egress_pidfd[3], egress_in[3], egress_out[3];
  pid_t egress_pid[3];
  unsigned int egress_joined[3], egress_ok[3], egress_kill[3];
  struct stat egress_file_identity, egress_binary_identity;
  char egress_bytes[32769];
  size_t egress_size;
};

static int oci_egress_current(struct tns_oci_owner *o);
static int oci_uplink_current(struct tns_oci_owner *o);
static int oci_policy_current(struct tns_oci_owner *o);
static int oci_policy_runtime_current(struct tns_oci_owner *o);
static int oci_admission_open(struct tns_oci_owner *o);
static int oci_admission_observable(struct tns_oci_owner *o);
static int oci_admission_cut(struct tns_oci_owner *o);
static int oci_admission_stop(struct tns_oci_owner *o);
static int oci_admission_close(struct tns_oci_owner *o);

static volatile sig_atomic_t oci_cancel_requested;

void tns_oci_note_cancel(void) { oci_cancel_requested = 1; }

static int oci_not_canceled(void) {
  if (oci_cancel_requested) { errno = ECANCELED; return -1; }
  return 0;
}

static int64_t oci_now(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t) < 0) return -1;
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int oci_owned(int fd, int directory, mode_t exact) {
  struct stat st;
  if (fstat(fd, &st) < 0) return -1;
  if (st.st_uid != 0 || (st.st_mode & 022) ||
      (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) ||
      (exact && (st.st_mode & 0777) != exact)) { errno = EPERM; return -1; }
  return 0;
}

static int oci_same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

/* Every ancestor is opened without symlinks and checked for actual root
 * ownership/non-writability. No caller-supplied fd or alternate runtime. */
static int oci_open_absolute(const char *path, int directory) {
  if (!path || path[0] != '/' || strlen(path) > 4095 || !path[1]) {
    errno = EINVAL; return -1;
  }
  int fd = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return -1;
  if (oci_owned(fd, 1, 0) < 0) { int e = errno; close(fd); errno = e; return -1; }
  const char *p = path + 1;
  while (*p) {
    const char *end = strchr(p, '/');
    size_t size = end ? (size_t)(end - p) : strlen(p);
    if (!size || size > NAME_MAX || (size == 1 && p[0] == '.') ||
        (size == 2 && p[0] == '.' && p[1] == '.')) {
      close(fd); errno = EINVAL; return -1;
    }
    char component[NAME_MAX + 1]; memcpy(component, p, size); component[size] = 0;
    int isdir = end || directory;
    int next = openat(fd, component, O_CLOEXEC | O_NOFOLLOW |
                       (isdir ? O_RDONLY | O_DIRECTORY : O_RDONLY | O_NONBLOCK));
    int e = errno; close(fd); fd = next;
    if (fd < 0) { errno = e; return -1; }
    if (oci_owned(fd, isdir, 0) < 0) { e = errno; close(fd); errno = e; return -1; }
    if (!end) return fd;
    p = end + 1;
    if (!*p) { close(fd); errno = EINVAL; return -1; }
  }
  close(fd); errno = EINVAL; return -1;
}

static int oci_read_exact_file(int fd, const char *expected, size_t size) {
  char bytes[8193];
  if (size > sizeof(bytes) - 1) { errno = EOVERFLOW; return -1; }
  size_t used = 0;
  for (;;) {
    ssize_t n = pread(fd, bytes + used, sizeof(bytes) - used, (off_t)used);
    if (n < 0) return -1;
    if (!n) break;
    used += (size_t)n;
    if (used > size) { errno = EPROTO; return -1; }
  }
  if (used != size || memcmp(bytes, expected, size)) { errno = EPROTO; return -1; }
  return 0;
}

/* runc requires the canonical filesystem path. The allocation and its
 * parents are private to the trusted owner; re-open the name without
 * symlinks and bind it to the original held rootfs inode. */
static int oci_rootfs_path_current(struct tns_oci_owner *o) {
  int fd = oci_open_absolute(o->rootpath, 1);
  if (fd < 0) return -1;
  struct stat st;
  int same = fstat(fd, &st) == 0 && oci_same(&st, &o->rootfs_identity);
  close(fd);
  if (!same) { errno = ESTALE; return -1; }
  return 0;
}

static int oci_inputs(struct tns_oci_owner *o) {
  struct stat held, named;
  if (oci_owned(o->root, 1, 0700) < 0 || oci_owned(o->rootfs, 1, 0) < 0 ||
      oci_owned(o->receipt, 0, 0600) < 0 || oci_owned(o->runtime, 0, 0) < 0 ||
      fstat(o->runtime, &held) < 0 || !oci_same(&held, &o->runtime_identity) ||
      fstat(o->rootfs, &held) < 0 || !oci_same(&held, &o->rootfs_identity)) {
    if (!errno) errno = ESTALE;
    return -1;
  }
  if (fstatat(o->root, "rootfs", &named, AT_SYMLINK_NOFOLLOW) < 0 ||
      !oci_same(&named, &o->rootfs_identity)) { errno = ESTALE; return -1; }
  if (fstat(o->receipt, &held) < 0 ||
      fstatat(o->root, ".tako-oci-artifact.json", &named, AT_SYMLINK_NOFOLLOW) < 0 ||
      !oci_same(&held, &named) || held.st_nlink != 1) { errno = ESTALE; return -1; }
  if (oci_read_exact_file(o->receipt, o->receipt_bytes, o->receipt_size) < 0) return -1;
  if (oci_egress_current(o) < 0) return -1;
  if (oci_uplink_current(o) < 0) return -1;
  return oci_policy_current(o);
}

static int oci_initial_contents(int root) {
  int fd = fcntl(root, F_DUPFD_CLOEXEC, 3);
  if (fd < 0) return -1;
  DIR *dir = fdopendir(fd);
  if (!dir) { int e = errno; close(fd); errno = e; return -1; }
  errno = 0;
  struct dirent *entry;
  int ok = 1;
  while ((entry = readdir(dir))) {
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..") &&
        strcmp(entry->d_name, "rootfs") &&
        strcmp(entry->d_name, ".tako-oci-artifact.json") &&
        strcmp(entry->d_name, ".tako-oci-egress.json") &&
        strcmp(entry->d_name, ".tako-oci-topology.json") &&
        strcmp(entry->d_name, ".tako-oci-service.json")) { ok = 0; break; }
  }
  int e = errno;
  closedir(dir);
  if (!ok) { errno = EEXIST; return -1; }
  if (e) { errno = e; return -1; }
  return 0;
}

static int oci_fd_path(char *out, size_t size, int fd) {
  int n = snprintf(out, size, "/proc/%ld/fd/%d", (long)getpid(), fd);
  if (n < 0 || (size_t)n >= size) { errno = EOVERFLOW; return -1; }
  return 0;
}

static int oci_poll_alive(int fd) {
  struct pollfd p = {.fd = fd, .events = POLLIN};
  if (fd < 0) { errno = EBADF; return -1; }
  int n = poll(&p, 1, 0);
  if (n < 0) return -1;
  if (n || p.revents) { errno = ESRCH; return -1; }
  return 0;
}

/* runc clones its executable for init; inode equality would reject its normal
 * CloneSelfExe path. Compare actual pinned ELF bytes, with a bounded size and
 * deadline, rather than trusting a caller digest or memfd name. */
static int oci_init_executable(struct tns_oci_owner *o, int fd) {
  struct stat before, runtime_before, after, runtime_after;
  if (fstat(fd, &before) < 0 || fstat(o->runtime, &runtime_before) < 0) return -1;
  if (!S_ISREG(before.st_mode) || !S_ISREG(runtime_before.st_mode) ||
      !oci_same(&runtime_before, &o->runtime_identity) ||
      before.st_size <= 0 || before.st_size > 67108864 ||
      before.st_size != runtime_before.st_size) { errno = ESTALE; return -1; }
  int64_t now = oci_now(); if (now < 0) return -1;
  int64_t deadline = now + 1000;
  unsigned char actual[32768], expected[32768];
  for (off_t offset = 0; offset < before.st_size;) {
    now = oci_now();
    if (now < 0) return -1;
    if (now >= deadline) { errno = ETIMEDOUT; return -1; }
    off_t remaining = before.st_size - offset;
    size_t size = remaining < (off_t)sizeof(actual) ? (size_t)remaining : sizeof(actual);
    ssize_t a = pread(fd, actual, size, offset);
    ssize_t b = pread(o->runtime, expected, size, offset);
    if (a != (ssize_t)size || b != (ssize_t)size || memcmp(actual, expected, size)) {
      errno = ESTALE; return -1;
    }
    offset += (off_t)size;
  }
  if (fstat(fd, &after) < 0 || fstat(o->runtime, &runtime_after) < 0) return -1;
  if (!oci_same(&before, &after) || !oci_same(&runtime_before, &runtime_after) ||
      before.st_size != after.st_size || runtime_before.st_size != runtime_after.st_size ||
      before.st_mtim.tv_sec != after.st_mtim.tv_sec ||
      before.st_mtim.tv_nsec != after.st_mtim.tv_nsec ||
      before.st_ctim.tv_sec != after.st_ctim.tv_sec ||
      before.st_ctim.tv_nsec != after.st_ctim.tv_nsec ||
      runtime_before.st_mtim.tv_sec != runtime_after.st_mtim.tv_sec ||
      runtime_before.st_mtim.tv_nsec != runtime_after.st_mtim.tv_nsec ||
      runtime_before.st_ctim.tv_sec != runtime_after.st_ctim.tv_sec ||
      runtime_before.st_ctim.tv_nsec != runtime_after.st_ctim.tv_nsec) {
    errno = ESTALE; return -1;
  }
  return 0;
}

enum oci_command_kind { OCI_COMMAND_CREATE, OCI_COMMAND_START, OCI_COMMAND_DELETE };

static _Noreturn void oci_command_child(struct tns_oci_owner *o, pid_t creator,
                                         enum oci_command_kind kind) {
  /* DELETE is original-owner cleanup after consuming init/tracked joins.
   * Its parent checks cleanup-current; generic cancel still gates CREATE/START. */
  if (kind != OCI_COMMAND_DELETE && oci_not_canceled() < 0) _exit(125);
  if (kind == OCI_COMMAND_CREATE && oci_rootfs_path_current(o) < 0) _exit(125);
  int executable = fcntl(o->runtime, F_DUPFD_CLOEXEC, 4);
  if (executable < 0 || dup3(executable, 3, O_CLOEXEC) < 0 ||
      syscall(SYS_close_range, 4u, UINT_MAX, 0u) < 0) _exit(125);
  close(0); close(1); close(2);
  int null = open("/dev/null", O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  struct stat st;
  if (null != 0 || fstat(null, &st) < 0 || !S_ISCHR(st.st_mode) ||
      major(st.st_rdev) != 1 || minor(st.st_rdev) != 3 ||
      dup2(null, 1) != 1 || dup2(null, 2) != 2 ||
      fcntl(0, F_SETFD, 0) < 0 || prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 ||
      getppid() != creator) _exit(125);
  char *const create_args[] = {"runc", "--root", o->statepath, "create", "--bundle",
                              o->bundlepath, "--pid-file", o->pidpath, o->id, NULL};
  char *const start_args[] = {"runc", "--root", o->statepath, "start", o->id, NULL};
  char *const delete_args[] = {"runc", "--root", o->statepath, "delete", o->id, NULL};
  char *const *args;
  if (kind == OCI_COMMAND_CREATE) args = create_args;
  else if (kind == OCI_COMMAND_START) args = start_args;
  else if (kind == OCI_COMMAND_DELETE) args = delete_args;
  else _exit(125);
  char *const environment[] = {"PATH=/usr/sbin:/usr/bin:/sbin:/bin", NULL};
  umask(077);
  syscall(SYS_execveat, 3, "", args, environment, AT_EMPTY_PATH);
  _exit(125);
}

static int oci_join_command(struct tns_oci_owner *o, int milliseconds) {
  if (!o->command_pid || o->command_joined) return 0;
  struct pollfd p = {.fd = o->command_pidfd, .events = POLLIN};
  int n = poll(&p, 1, milliseconds);
  if (n < 0) return -1;
  if (!n) { errno = ETIMEDOUT; return -1; }
  if (p.revents != POLLIN) { errno = EPROTO; return -1; }
  siginfo_t info; memset(&info, 0, sizeof(info));
  if (waitid(P_PIDFD, (id_t)o->command_pidfd, &info, WEXITED | WNOHANG) < 0)
    return -1;
  if (info.si_pid != o->command_pid ||
      (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED &&
       info.si_code != CLD_DUMPED)) { errno = EPROTO; return -1; }
  o->command_joined = 1;
  o->command_ok = info.si_code == CLD_EXITED && info.si_status == 0;
  return 0;
}

static int oci_pin_init(struct tns_oci_owner *o) {
  int fd = openat(o->bundle, "init.pid", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat st;
  if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_uid != 0 ||
      (st.st_mode & 022) || st.st_nlink != 1) {
    close(fd); errno = EPROTO; return -1;
  }
  unsigned char text[12]; ssize_t n = read(fd, text, sizeof(text));
  int e = errno; close(fd);
  if (n < 0) { errno = e; return -1; }
  int pid = tns_oci_pid(text, (size_t)n);
  if (pid < 0) { errno = EPROTO; return -1; }
  o->init_pid = (pid_t)pid;
  o->init_pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
  if (oci_poll_alive(o->init_pidfd) < 0) return -1;
  char path[64]; int length = snprintf(path, sizeof(path), "/proc/%d", pid);
  if (length < 0 || (size_t)length >= sizeof(path)) { errno = EOVERFLOW; return -1; }
  o->init_proc = open(path, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (o->init_proc < 0) return -1;
  struct statfs fs;
  if (fstatfs(o->init_proc, &fs) < 0 ||
      (unsigned long)fs.f_type != (unsigned long)PROC_SUPER_MAGIC) {
    errno = EPROTO; return -1;
  }
  return oci_poll_alive(o->init_pidfd);
}

static int oci_join_start_command(struct tns_oci_owner *o, int milliseconds) {
  if (!o->start_pid || o->start_joined) return 0;
  struct pollfd p = {.fd = o->start_pidfd, .events = POLLIN};
  int n = poll(&p, 1, milliseconds);
  if (n < 0) return -1;
  if (!n) { errno = ETIMEDOUT; return -1; }
  if (p.revents != POLLIN) { errno = EPROTO; return -1; }
  siginfo_t info; memset(&info, 0, sizeof(info));
  if (waitid(P_PIDFD, (id_t)o->start_pidfd, &info, WEXITED | WNOHANG) < 0)
    return -1;
  if (info.si_pid != o->start_pid ||
      (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED &&
       info.si_code != CLD_DUMPED)) { errno = EPROTO; return -1; }
  o->start_joined = 1;
  o->start_ok = info.si_code == CLD_EXITED && info.si_status == 0;
  return 0;
}

static int oci_stop_start_command(struct tns_oci_owner *o) {
  if (o->controller_pid != getpid()) { errno = EPERM; return -1; }
  if (o->start_pid && !o->start_joined && !o->start_kill_attempted) {
    o->start_kill_attempted = 1;
    if (syscall(SYS_pidfd_send_signal, o->start_pidfd, SIGKILL, NULL, 0) < 0 &&
        errno != ESRCH) return -1;
  }
  return oci_join_start_command(o, 1000);
}

static int oci_held_inputs(struct tns_oci_owner *o) {
  if (o->controller_pid != getpid() || geteuid() != 0) { errno = EPERM; return -1; }
  if (oci_inputs(o) < 0 || !o->config_created ||
      oci_owned(o->bundle, 1, 0700) < 0 || oci_owned(o->state, 1, 0700) < 0)
    return -1;
  struct stat held, named;
  if (fstat(o->bundle, &held) < 0 ||
      fstatat(o->root, "bundle", &named, AT_SYMLINK_NOFOLLOW) < 0 ||
      !oci_same(&held, &named) || fstat(o->state, &held) < 0 ||
      fstatat(o->root, "runtime-state", &named, AT_SYMLINK_NOFOLLOW) < 0 ||
      !oci_same(&held, &named)) { errno = ESTALE; return -1; }
  int fd = openat(o->bundle, "config.json", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  int ok = oci_owned(fd, 0, 0600) == 0 && fstat(fd, &held) == 0 &&
           held.st_nlink == 1 && oci_same(&held, &o->config_identity) &&
           held.st_size == o->config_identity.st_size &&
           held.st_mtim.tv_sec == o->config_identity.st_mtim.tv_sec &&
           held.st_mtim.tv_nsec == o->config_identity.st_mtim.tv_nsec &&
           held.st_ctim.tv_sec == o->config_identity.st_ctim.tv_sec &&
           held.st_ctim.tv_nsec == o->config_identity.st_ctim.tv_nsec;
  close(fd);
  if (!ok) { errno = ESTALE; return -1; }
  return 0;
}

static int oci_start_inputs(struct tns_oci_owner *o) {
  if (oci_not_canceled() < 0) return -1;
  if (oci_held_inputs(o) < 0) return -1;
  if (o->admission_ruleset_reads && tns_owner_admission_current(o->birth) < 0) return -1;
  if (oci_policy_runtime_current(o) < 0) return -1;
  return oci_not_canceled();
}

static int oci_init_namespace_current(struct tns_oci_owner *o) {
  if (oci_poll_alive(o->init_pidfd) < 0) return -1;
  int fd = openat(o->init_proc, "ns/net", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat st; struct statfs fs;
  int ok = fstat(fd, &st) == 0 && fstatfs(fd, &fs) == 0 &&
           (unsigned long)fs.f_type == (unsigned long)NSFS_MAGIC &&
           ioctl(fd, NS_GET_NSTYPE) == CLONE_NEWNET &&
           (uint64_t)st.st_dev == o->identity.device &&
           (uint64_t)st.st_ino == o->identity.inode;
  close(fd);
  if (!ok) { errno = ESTALE; return -1; }
  return oci_poll_alive(o->init_pidfd);
}

/* The dedicated helper owns this state before CREATE. No inherited SIG_IGN,
 * SA_NOCLDWAIT or arbitrary caller process-state mutation may fake waitability. */
static int oci_reaper_current(void) {
  int reaper = 0; struct sigaction action;
  memset(&action, 0, sizeof(action));
  if (prctl(PR_GET_CHILD_SUBREAPER, &reaper, 0, 0, 0) < 0 ||
      sigaction(SIGCHLD, NULL, &action) < 0) return -1;
  if (reaper != 1 || action.sa_handler != SIG_DFL || (action.sa_flags & SA_NOCLDWAIT)) {
    errno = EPERM; return -1;
  }
  return 0;
}

static int oci_pidns_stat(int fd, struct stat *st) {
  struct statfs fs;
  if (fstat(fd, st) < 0 || fstatfs(fd, &fs) < 0) return -1;
  if ((unsigned long)fs.f_type != (unsigned long)NSFS_MAGIC ||
      ioctl(fd, NS_GET_NSTYPE) != CLONE_NEWPID) { errno = ESTALE; return -1; }
  return 0;
}

static int oci_parent_pidns_current(struct tns_oci_owner *o) {
  if (o->controller_pid != getpid() || geteuid() != 0) { errno = EPERM; return -1; }
  if (oci_reaper_current() < 0) return -1;
  struct stat held, actual;
  if (oci_pidns_stat(o->parent_pidns, &held) < 0 ||
      !oci_same(&held, &o->parent_pidns_identity)) { errno = ESTALE; return -1; }
  const char *paths[] = {"/proc/self/ns/pid", "/proc/self/ns/pid_for_children"};
  for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); ++i) {
    int fd = open(paths[i], O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    int ok = oci_pidns_stat(fd, &actual) == 0 && oci_same(&held, &actual);
    close(fd);
    if (!ok) { errno = ESTALE; return -1; }
  }
  return 0;
}

static int oci_init_held_current(struct tns_oci_owner *o) {
  struct stat held, parent;
  if (oci_parent_pidns_current(o) < 0 || oci_pidns_stat(o->init_pidns, &held) < 0 ||
      !oci_same(&held, &o->init_pidns_identity) ||
      oci_same(&held, &o->parent_pidns_identity)) { errno = ESTALE; return -1; }
  int fd = ioctl(o->init_pidns, NS_GET_PARENT);
  if (fd < 0) return -1;
  int ok = oci_pidns_stat(fd, &parent) == 0 &&
           oci_same(&parent, &o->parent_pidns_identity);
  close(fd);
  if (!ok) { errno = ESTALE; return -1; }
  return 0;
}

/* Returns 0 for a genuinely waitable live child and 1 for the exact exited
 * child, without reaping either. ECHILD is never evidence of prior cleanup. */
static int oci_peek_init(struct tns_oci_owner *o, siginfo_t *info) {
  memset(info, 0, sizeof(*info));
  if (waitid(P_PIDFD, (id_t)o->init_pidfd, info, WEXITED | WNOHANG | WNOWAIT) < 0)
    return -1;
  if (!info->si_pid) {
    if (info->si_code || info->si_status || info->si_signo) { errno = EPROTO; return -1; }
    return 0;
  }
  if (info->si_pid != o->init_pid ||
      (info->si_code != CLD_EXITED && info->si_code != CLD_KILLED &&
       info->si_code != CLD_DUMPED) ||
      (info->si_code == CLD_EXITED ? info->si_status < 0 || info->si_status > 255 :
                                   info->si_status <= 0 || info->si_status >= NSIG)) {
    errno = EPROTO; return -1;
  }
  return 1;
}

static int oci_private_init_current(struct tns_oci_owner *o) {
  if (oci_init_held_current(o) < 0 || oci_poll_alive(o->init_pidfd) < 0) return -1;
  int fd = openat(o->init_proc, "ns/pid", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat st;
  int ok = oci_pidns_stat(fd, &st) == 0 && oci_same(&st, &o->init_pidns_identity) &&
           ioctl(fd, NS_GET_PID_FROM_PIDNS, 1) == o->init_pid;
  close(fd);
  if (!ok) { errno = ESTALE; return -1; }
  siginfo_t info;
  int state = oci_peek_init(o, &info);
  if (state < 0) return -1;
  if (state) { errno = ESRCH; return -1; }
  return oci_init_namespace_current(o);
}

static int oci_pin_pidns(struct tns_oci_owner *o) {
  if (oci_parent_pidns_current(o) < 0 || oci_poll_alive(o->init_pidfd) < 0) return -1;
  o->init_pidns = openat(o->init_proc, "ns/pid", O_RDONLY | O_CLOEXEC);
  if (o->init_pidns < 0 || oci_pidns_stat(o->init_pidns, &o->init_pidns_identity) < 0 ||
      oci_private_init_current(o) < 0) return -1;
  o->init_custody = 1;
  return 0;
}

static int oci_reap_owner_current(struct tns_oci_owner *o) {
  if (!o->init_custody || o->init_pid <= 0 || o->init_pidfd < 0 ||
      !o->command_pid || !o->command_joined || !o->command_ok) {
    errno = EINVAL; return -1;
  }
  struct tns_identity birth;
  if (oci_held_inputs(o) < 0 || oci_init_held_current(o) < 0 ||
      tns_owner_observe(o->birth, &birth) < 0) return -1;
  if (!tns_identity_equal(&birth, &o->identity)) { errno = ESTALE; return -1; }
  return 0;
}

int tns_oci_join_init(struct tns_oci_owner *o, struct tns_oci_init_reaped *reaped) {
  if (!o || !reaped || !o->init_stop_attempt) { errno = EINVAL; return -1; }
  if (oci_reap_owner_current(o) < 0) return -1;
  if (!o->init_joined) {
    struct pollfd p = {.fd = o->init_pidfd, .events = POLLIN};
    int n = poll(&p, 1, 10000);
    if (n < 0) return -1;
    if (!n) { errno = ETIMEDOUT; return -1; }
    if (p.revents != POLLIN) { errno = EPROTO; return -1; }
    siginfo_t before, actual;
    int state = oci_peek_init(o, &before);
    if (state < 0) return -1;
    if (!state) { errno = EPROTO; return -1; }
    memset(&actual, 0, sizeof(actual));
    if (waitid(P_PIDFD, (id_t)o->init_pidfd, &actual, WEXITED | WNOHANG) < 0) return -1;
    if (actual.si_pid != before.si_pid || actual.si_code != before.si_code ||
        actual.si_status != before.si_status) { errno = EPROTO; return -1; }
    o->init_joined = 1; /* Actual consuming wait only; keep this fact on late error. */
  }
  if (oci_reap_owner_current(o) < 0) return -1;
  memcpy(reaped->native_id, o->id, sizeof(reaped->native_id));
  reaped->namespace_device = o->identity.device;
  reaped->namespace_inode = o->identity.inode;
  reaped->pid_namespace_device = (uint64_t)o->init_pidns_identity.st_dev;
  reaped->pid_namespace_inode = (uint64_t)o->init_pidns_identity.st_ino;
  return 0;
}

int tns_oci_stop_init(struct tns_oci_owner *o, struct tns_oci_init_reaped *reaped) {
  if (!o || !reaped) { errno = EINVAL; return -1; }
  if (tns_oci_once(&o->init_stop_attempt) < 0) { errno = EALREADY; return -1; }
  o->invalid = 1; /* STOP can never resume CREATE/START, including unknown failure. */
  if (oci_admission_cut(o) < 0) return -1;
  if (oci_reap_owner_current(o) < 0) return -1;
  siginfo_t info;
  int state = oci_peek_init(o, &info);
  if (state < 0) return -1;
  if (!state) {
    if (oci_private_init_current(o) < 0 || oci_reap_owner_current(o) < 0) return -1;
    if (syscall(SYS_pidfd_send_signal, o->init_pidfd, SIGKILL, NULL, 0) < 0 &&
        errno != ESRCH) return -1;
  }
  return tns_oci_join_init(o, reaped);
}

/* A successful runc start may acknowledge the FIFO before the original
 * init completes execve. Only the held init and its executable are sampled. */
static int oci_started_executable(struct tns_oci_owner *o) {
  int fd = openat(o->init_proc, "exe", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat original, actual;
  int valid = fstat(o->stopped_exe, &original) == 0 && fstat(fd, &actual) == 0 &&
              S_ISREG(actual.st_mode);
  close(fd);
  if (!valid) { errno = ESTALE; return -1; }
  return !oci_same(&original, &actual);
}

static int oci_wait_started_executable(struct tns_oci_owner *o, int64_t deadline) {
  for (;;) {
    if (oci_not_canceled() < 0 || oci_private_init_current(o) < 0) return -1;
    int64_t now = oci_now();
    if (now < 0) return -1;
    if (now >= deadline) { errno = ETIMEDOUT; return -1; }
    int observed = oci_started_executable(o);
    if (observed) return observed < 0 ? -1 : 0;
    struct pollfd init = {.fd = o->init_pidfd, .events = POLLIN};
    int64_t remaining = deadline - now;
    int ready = poll(&init, 1, remaining < 10 ? (int)remaining : 10);
    if (ready > 0) { errno = ESRCH; return -1; }
    if (ready < 0 && errno != EINTR) return -1;
  }
}

static int oci_observe_started_exec(struct tns_oci_owner *o, struct tns_oci_started *started) {
  if (!o || !started || o->invalid || !o->start_attempt || !o->start_joined ||
      !o->start_ok || o->stopped_exe < 0 || !o->init_custody) { errno = EINVAL; return -1; }
  struct tns_identity birth;
  if (oci_start_inputs(o) < 0 || tns_owner_observe(o->birth, &birth) < 0 ||
      !tns_identity_equal(&birth, &o->identity) || oci_private_init_current(o) < 0)
    goto fail;
  int observed = oci_started_executable(o);
  if (observed <= 0) {
    if (!observed) errno = ESTALE;
    goto fail;
  }
  if (oci_private_init_current(o) < 0 || tns_owner_observe(o->birth, &birth) < 0 ||
      !tns_identity_equal(&birth, &o->identity) || oci_start_inputs(o) < 0)
    goto fail;
  memcpy(started->native_id, o->id, sizeof(started->native_id));
  started->namespace_device = o->identity.device;
  started->namespace_inode = o->identity.inode;
  return 0;
fail:
  o->invalid = 1;
  if (oci_admission_cut(o) < 0) return -1;
  return -1;
}

int tns_oci_observe_started(struct tns_oci_owner *o, struct tns_oci_started *started) {
  if (!o || !started) { errno=EINVAL;return -1; }
  /* The pre-OPEN executable transition is private to the original START.
   * Selected policy has no public positive started reply while birth denied. */
  if (oci_admission_observable(o) < 0) {
    int saved=errno;
    if (o->admission_attempt) {
      o->invalid=1;
      if (oci_admission_cut(o) < 0) return -1;
    }
    errno=saved;return -1;
  }
  return oci_observe_started_exec(o,started);
}

int tns_oci_start(struct tns_oci_owner *o, struct tns_oci_started *started) {
  if (!o || !started) { errno = EINVAL; return -1; }
  if (o->start_attempt) { errno = EALREADY; return -1; }
  if (o->invalid) { errno = EINVAL; return -1; }
  struct tns_oci_created stopped;
  if (oci_start_inputs(o) < 0 || tns_oci_observe(o, &stopped) < 0 ||
      o->stopped_exe < 0 || oci_not_canceled() < 0) goto fail;
  if (tns_oci_once(&o->start_attempt) < 0) { errno = EALREADY; goto fail; }
  int64_t now = oci_now(); if (now < 0) goto fail;
  struct clone_args args; memset(&args, 0, sizeof(args));
  args.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND;
  args.pidfd = (uint64_t)(uintptr_t)&o->start_pidfd;
  args.exit_signal = SIGCHLD;
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (!child) oci_command_child(o, o->controller_pid, OCI_COMMAND_START);
  if (child < 0) goto fail;
  o->start_pid = (pid_t)child;
  if (oci_not_canceled() < 0) goto fail;
  int64_t elapsed = oci_now();
  if (elapsed < now || elapsed - now >= 10000) { errno = ETIMEDOUT; goto fail; }
  if (oci_join_start_command(o, 10000 - (int)(elapsed - now)) < 0) goto fail;
  if (!o->start_ok) { errno = EPROTO; goto fail; }
  const int64_t deadline = now + 10000;
  struct tns_oci_started executed;
  if (oci_wait_started_executable(o, deadline) < 0 ||
      oci_observe_started_exec(o, &executed) < 0) goto fail;
  elapsed = oci_now();
  if (elapsed < now || elapsed >= deadline) { errno = ETIMEDOUT; goto fail; }
  if (oci_admission_open(o) < 0 || tns_oci_observe_started(o, started) < 0) goto fail;
  return 0;
fail: {
  int saved = errno ? errno : EPROTO;
  o->invalid = 1;
  int cut = oci_admission_cut(o), cut_error = errno;
  if (oci_stop_start_command(o) < 0) return -1;
  if (cut < 0) { errno = cut_error; return -1; }
  errno = saved;
  return -1;
  }
}

int tns_oci_observe(struct tns_oci_owner *o, struct tns_oci_created *created) {
  if (!o || !created || o->invalid || o->start_attempt ||
      !o->command_joined || !o->command_ok || !o->init_custody) {
    errno = EINVAL; return -1;
  }
  if (oci_not_canceled() < 0 || oci_inputs(o) < 0 || oci_private_init_current(o) < 0) goto fail;
  struct tns_identity birth;
  if (tns_owner_observe(o->birth, &birth) < 0 ||
      !tns_identity_equal(&birth, &o->identity)) goto fail;
  int fd = openat(o->init_proc, "ns/net", O_RDONLY | O_CLOEXEC);
  if (fd < 0) goto fail;
  struct stat st; struct statfs fs;
  int ok = fstat(fd, &st) == 0 && fstatfs(fd, &fs) == 0 &&
           (unsigned long)fs.f_type == (unsigned long)NSFS_MAGIC &&
           ioctl(fd, NS_GET_NSTYPE) == CLONE_NEWNET &&
           (uint64_t)st.st_dev == o->identity.device &&
           (uint64_t)st.st_ino == o->identity.inode;
  close(fd);
  if (!ok) { errno = ESTALE; goto fail; }
  fd = openat(o->init_proc, "exe", O_RDONLY | O_CLOEXEC);
  if (fd < 0) goto fail;
  ok = oci_init_executable(o, fd) == 0;
  struct stat held, current;
  if (ok && o->stopped_exe >= 0)
    ok = fstat(o->stopped_exe, &held) == 0 && fstat(fd, &current) == 0 &&
         oci_same(&held, &current);
  if (ok && o->stopped_exe < 0) {
    o->stopped_exe = fcntl(fd, F_DUPFD_CLOEXEC, 3);
    ok = o->stopped_exe >= 0;
  }
  close(fd);
  if (!ok || oci_poll_alive(o->init_pidfd) < 0) { errno = ESTALE; goto fail; }
  memcpy(created->native_id, o->id, sizeof(created->native_id));
  created->namespace_device = o->identity.device;
  created->namespace_inode = o->identity.inode;
  return 0;
fail:
  o->invalid = 1;
  return -1;
}

#include "docker-container-terminal-oci-egress.h"
#include "docker-container-terminal-oci-uplink.h"
#include "docker-container-terminal-oci-policy.h"
#include "docker-container-terminal-oci-admission.h"

static int oci_create_profile(const struct tns_oci_options *options,
                                struct tns_oci_owner **slot,
                                enum oci_retirement_profile profile) {
  if (!slot) { errno = EINVAL; return -1; }
  if (*slot) { errno = EALREADY; return -1; }
  struct tns_oci_owner *o = calloc(1, sizeof(*o));
  if (!o) return -1;
  o->root = o->rootfs = o->receipt = o->runtime = o->bundle = o->state = -1;
  o->network = o->command_pidfd = o->init_pidfd = o->init_proc = -1;
  o->start_pidfd = o->stopped_exe = o->parent_pidns = o->init_pidns = -1;
  o->egress_file = o->egress_binary = -1;
  for (size_t i = 0; i < 3; ++i)
    o->egress_pidfd[i] = o->egress_in[i] = o->egress_out[i] = -1;
  o->controller_pid = getpid();
  o->retirement_profile = profile;
  *slot = o;
  if (tns_oci_once(&o->attempt) < 0 || tns_oci_data(options) < 0 ||
      tns_oci_metadata(options) < 0 || geteuid() != 0) { errno = EINVAL; goto fail; }
  memcpy(o->id, options->claim_id, sizeof(o->id));
  o->root = oci_open_absolute(options->allocation_root, 1);
  if (o->root < 0 || oci_owned(o->root, 1, 0700) < 0 || oci_initial_contents(o->root) < 0)
    goto fail;
  o->rootfs = openat(o->root, "rootfs", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  o->receipt = openat(o->root, ".tako-oci-artifact.json",
                       O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  o->runtime = oci_open_absolute("/usr/bin/runc", 0);
  if (o->rootfs < 0 || o->receipt < 0 || o->runtime < 0 ||
      fstat(o->runtime, &o->runtime_identity) < 0 ||
      fstat(o->rootfs, &o->rootfs_identity) < 0) goto fail;
  int rootlen = snprintf(o->rootpath, sizeof(o->rootpath), "%s/rootfs", options->allocation_root);
  if (rootlen < 0 || (size_t)rootlen >= sizeof(o->rootpath)) { errno = EOVERFLOW; goto fail; }
  if (oci_rootfs_path_current(o) < 0) goto fail;
  unsigned char magic[4];
  if (!(o->runtime_identity.st_mode & 0100) ||
      pread(o->runtime, magic, sizeof(magic), 0) != (ssize_t)sizeof(magic) ||
      memcmp(magic, "\177ELF", 4)) { errno = ENOTSUP; goto fail; }
  struct tns_oci_json receipt = {o->receipt_bytes, sizeof(o->receipt_bytes), 0, 0};
  tns_oci_receipt(options, &receipt);
  if (receipt.failed) { errno = EOVERFLOW; goto fail; }
  o->receipt_size = receipt.used;
  if (oci_not_canceled() < 0 || oci_inputs(o) < 0) goto fail;
  if (oci_egress_select(o, options->generation) < 0 || oci_uplink_select(o, &o->uplink) < 0 ||
      oci_policy_select(o, &o->policy) < 0) goto fail;
  /* Real dedicated subreaper/default SIGCHLD must precede namespace/runtime effects. */
  if (oci_reaper_current() < 0) goto fail;
  o->parent_pidns = open("/proc/self/ns/pid", O_RDONLY | O_CLOEXEC);
  if (o->parent_pidns < 0 || oci_pidns_stat(o->parent_pidns, &o->parent_pidns_identity) < 0 ||
      oci_parent_pidns_current(o) < 0) goto fail;
  /* Mandatory ownership and cancellation checks BEFORE fresh namespace. */
  if (tns_owner_create(&o->birth) < 0) goto fail;
  if (oci_not_canceled() < 0) goto fail;
  o->network = tns_owner_dup_namespace(o->birth);
  if (o->network < 0 || tns_owner_observe(o->birth, &o->identity) < 0 ||
      oci_inputs(o) < 0) goto fail;
  if (oci_egress_guard_install(o) < 0 || oci_uplink_install(o, o->uplink) < 0 ||
      oci_policy_install(o->policy) < 0) goto fail;
  if (oci_not_canceled() < 0 || mkdirat(o->root, "bundle", 0700) < 0 ||
      mkdirat(o->root, "runtime-state", 0700) < 0) goto fail;
  o->bundle = openat(o->root, "bundle", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  o->state = openat(o->root, "runtime-state", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (o->bundle < 0 || o->state < 0 || oci_owned(o->bundle, 1, 0700) < 0 ||
      oci_owned(o->state, 1, 0700) < 0 ||
      oci_fd_path(o->netpath, sizeof(o->netpath), o->network) < 0 ||
      oci_fd_path(o->bundlepath, sizeof(o->bundlepath), o->bundle) < 0 ||
      oci_fd_path(o->statepath, sizeof(o->statepath), o->state) < 0) goto fail;
  int length = snprintf(o->pidpath, sizeof(o->pidpath), "%s/init.pid", o->bundlepath);
  if (length < 0 || (size_t)length >= sizeof(o->pidpath)) { errno = EOVERFLOW; goto fail; }
  char *config = calloc(1, TNS_OCI_MAX_JSON);
  if (!config) goto fail;
  struct tns_oci_json json = {config, TNS_OCI_MAX_JSON, 0, 0};
  tns_oci_bundle(options, o->rootpath, o->netpath, &json);
  int fd = -1;
  if (!json.failed && oci_not_canceled() == 0)
    fd = openat(o->bundle, "config.json", O_WRONLY | O_CREAT | O_EXCL |
                                O_NOFOLLOW | O_CLOEXEC, 0600);
  int written = fd >= 0 && oci_owned(fd, 0, 0600) == 0 &&
                write(fd, config, json.used) == (ssize_t)json.used && fsync(fd) == 0 &&
                fstat(fd, &o->config_identity) == 0;
  if (fd >= 0) o->config_created = 1;
  int e = errno;
  explicit_bzero(config, TNS_OCI_MAX_JSON); free(config);
  if (fd >= 0) close(fd);
  if (!written) { errno = e ? e : EOVERFLOW; goto fail; }
  if (oci_not_canceled() < 0 || oci_inputs(o) < 0 ||
      tns_owner_observe(o->birth, &o->identity) < 0) goto fail;
  if (tns_oci_once(&o->command_attempt) < 0) { errno = EALREADY; goto fail; }
  int64_t now = oci_now(); if (now < 0) goto fail;
  struct clone_args args; memset(&args, 0, sizeof(args));
  args.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND;
  args.pidfd = (uint64_t)(uintptr_t)&o->command_pidfd;
  args.exit_signal = SIGCHLD;
  pid_t creator = getpid();
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (!child) oci_command_child(o, creator, OCI_COMMAND_CREATE);
  if (child < 0) goto fail;
  o->command_pid = (pid_t)child;
  if (oci_not_canceled() < 0) goto fail;
  int64_t elapsed = oci_now();
  if (elapsed < 0 || elapsed - now >= 10000) { errno = ETIMEDOUT; goto fail; }
  if (oci_join_command(o, 10000 - (int)(elapsed - now)) < 0 || !o->command_ok)
    goto fail;
  if (oci_pin_init(o) < 0 || oci_pin_pidns(o) < 0) goto fail;
  int init_root = openat(o->init_proc, "root", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (init_root < 0) goto fail;
  struct stat actual_root;
  int same_root = fstat(init_root, &actual_root) == 0 &&
                  oci_same(&actual_root, &o->rootfs_identity);
  close(init_root);
  if (!same_root) { errno = ESTALE; goto fail; }
  struct tns_oci_created observed;
  if (tns_oci_observe(o, &observed) < 0) goto fail;
  return 0;
fail:
  if (!errno) errno = EPROTO;
  o->invalid = 1;
  /* No replay, blind runc delete, secret logging, or custody release. A pending
   * command can only be canceled/joined through this original private owner. */
  return -1;
}

int tns_oci_create(const struct tns_oci_options *options, struct tns_oci_owner **slot) {
  return oci_create_profile(options, slot, OCI_RETIREMENT_TRACKED);
}

/* Fixed opt-in owner, never an adoption or a setter on a preexisting claim. */
int tns_oci_create_selected_runtime(const struct tns_oci_options *options,
                                     struct tns_oci_owner **slot) {
  return oci_create_profile(options, slot, OCI_RETIREMENT_RUNTIME_FIRST);
}

int tns_oci_create_selected_local_cleanup(const struct tns_oci_options *options,
                                            struct tns_oci_owner **slot) {
  return oci_create_profile(options, slot, OCI_RETIREMENT_RUNTIME_LOCAL);
}

int tns_oci_cancel(struct tns_oci_owner *o) {
  if (!o) { errno = EINVAL; return -1; }
  o->invalid = 1;
  tns_oci_note_cancel();
  int cut = oci_admission_cut(o), cut_error = errno;
  if (oci_admission_stop(o) < 0 || oci_policy_stop(o->policy) < 0 || oci_egress_stop(o) < 0) return -1;
  if (cut < 0) { errno = cut_error; return -1; }
  if (o->command_pid && !o->command_joined && !o->kill_attempted) {
    o->kill_attempted = 1;
    if (syscall(SYS_pidfd_send_signal, o->command_pidfd, SIGKILL, NULL, 0) < 0 &&
        errno != ESRCH) return -1;
  }
  if (oci_join_command(o, 1000) < 0) return -1;
  if (oci_stop_start_command(o) < 0) return -1;
  /* The init may exist even after an unknown CREATE. Keep namespace/runtime
   * state and original secret config private; this API cannot retire it. */
  return 0;
}

int tns_oci_close_transport(struct tns_oci_owner *o) {
  if (!o) { errno = EINVAL; return -1; }
  int saved = 0;
  if (tns_oci_cancel(o) < 0) saved = errno;
  /* Uplink cleanup must run while the actual original birth is still HELD.
   * Unknown/born custody must survive transport loss for original init join;
   * stopping the custodian first would destroy its live namespace proof. */
  if (o->admission) {
    if (!o->command_pid && oci_admission_close(o) < 0 && !saved) saved = errno;
    if (o->admission) { errno = saved ? saved : EUCLEAN; return -1; }
  }
  if (o->policy) {
    if (!o->command_pid && oci_policy_close(&o->policy) < 0 && !saved) saved = errno;
    if (o->policy) { errno = saved ? saved : EUCLEAN; return -1; }
  }
  if (o->uplink) {
    if (!o->command_pid && oci_uplink_cleanup(&o->uplink) < 0 && !saved) saved = errno;
    if (o->uplink) { errno = saved ? saved : EUCLEAN; return -1; }
  }
  if (o->birth && tns_owner_stop_custodian(o->birth) < 0 && !saved) saved = errno;
  if (saved) { errno = saved; return -1; }
  return 0;
}

int tns_oci_release_uncreated(struct tns_oci_owner **slot) {
  if (!slot || !*slot) { errno = EINVAL; return -1; }
  struct tns_oci_owner *o = *slot;
  if (o->command_pid) { errno = EBUSY; return -1; }
  if (oci_egress_stop(o) < 0 || o->egress_close_unknown) {
    if (!errno) errno = EUCLEAN;
    return -1;
  }
  if (oci_admission_close(o) < 0 || oci_policy_close(&o->policy) < 0 || oci_uplink_cleanup(&o->uplink) < 0 || oci_egress_close(o) < 0) return -1;
  if (o->birth && tns_owner_close(&o->birth) < 0) return -1;
  if (o->config_created && unlinkat(o->bundle, "config.json", 0) < 0) return -1;
  int *fds[] = {&o->root, &o->rootfs, &o->receipt, &o->runtime, &o->bundle,
                &o->state, &o->network, &o->command_pidfd, &o->init_pidfd, &o->init_proc,
                &o->start_pidfd, &o->stopped_exe, &o->parent_pidns, &o->init_pidns};
  for (size_t i = 0; i < sizeof(fds) / sizeof(fds[0]); ++i) {
    if (*fds[i] >= 0) { close(*fds[i]); *fds[i] = -1; }
  }
  explicit_bzero(o, sizeof(*o)); free(o); *slot = NULL;
  return 0;
}

/* Cleanup currentness deliberately ignores generic cancel/invalid latches;
 * the genuine original consuming init wait and held objects remain mandatory. */
static int oci_namespace_release_current(struct tns_oci_owner *o) {
  if (!o->init_joined || !o->init_custody || !o->init_stop_attempt ||
      !o->command_pid || !o->command_joined || !o->command_ok ||
      (o->start_pid && !o->start_joined)) { errno = EINVAL; return -1; }
  if (oci_held_inputs(o) < 0 || oci_init_held_current(o) < 0) return -1;
  return 0;
}

int tns_oci_observe_namespace_lifetime(struct tns_oci_owner *o,
                                        struct tns_oci_namespace_lifetime *lifetime) {
  if (!o || !lifetime || !o->namespace_release_attempt) { errno = EINVAL; return -1; }
  if (oci_namespace_release_current(o) < 0) return -1;
  struct tns_lifetime observed;
  if (tns_owner_observe_lifetime(o->birth, &observed) < 0 ||
      !tns_identity_equal(&observed.identity, &o->identity)) {
    if (!errno) errno = ESTALE;
    return -1;
  }
  if (oci_namespace_release_current(o) < 0) return -1;
  memcpy(lifetime->native_id, o->id, sizeof(lifetime->native_id));
  lifetime->lifetime = observed;
  return 0;
}

static int oci_namespace_release_progress(struct tns_oci_owner *o,
                                             struct tns_oci_namespace_lifetime *lifetime) {
  if (oci_namespace_release_current(o) < 0) return -1;
  struct tns_lifetime before;
  if (tns_owner_observe_lifetime(o->birth, &before) < 0 ||
      !tns_identity_equal(&before.identity, &o->identity)) {
    if (!errno) errno = ESTALE;
    return -1;
  }
  if (oci_admission_close(o) < 0 || oci_policy_close(&o->policy) < 0 || oci_uplink_cleanup(&o->uplink) < 0) return -1;
  if (o->network >= 0) {
    struct stat st; struct statfs fs;
    if (fstat(o->network, &st) < 0 || fstatfs(o->network, &fs) < 0 ||
        (unsigned long)fs.f_type != (unsigned long)NSFS_MAGIC ||
        ioctl(o->network, NS_GET_NSTYPE) != CLONE_NEWNET ||
        (uint64_t)st.st_dev != o->identity.device || (uint64_t)st.st_ino != o->identity.inode) {
      if (!errno) errno = ESTALE;
      return -1;
    }
    int fd = o->network; o->network = -1; /* Attempted close, never a caller FD. */
    if (close(fd) < 0) { o->namespace_loan_close_unknown = 1; return -1; }
  }
  struct tns_lifetime released;
  int result;
  if (!o->namespace_release_dispatched) {
    o->namespace_release_dispatched = 1; /* Real dispatch, never a readback ACK. */
    result = tns_owner_release_namespace(o->birth, &released);
  } else result = tns_owner_continue_namespace_release(o->birth, &released);
  if (result < 0) return -1;
  if (o->namespace_loan_close_unknown) { errno = EUCLEAN; return -1; }
  int observed = tns_oci_observe_namespace_lifetime(o, lifetime);
  if (!observed && o->retirement_profile != OCI_RETIREMENT_TRACKED &&
      lifetime->lifetime.release_attempted == 1 &&
      lifetime->lifetime.reference_released == 1 && !lifetime->lifetime.poisoned)
    o->runtime_first_namespace_known = 1;
  return observed;
}

int tns_oci_release_namespace(struct tns_oci_owner *o,
                                struct tns_oci_namespace_lifetime *lifetime) {
  if (!o || !lifetime) { errno = EINVAL; return -1; }
  if (tns_oci_once(&o->namespace_release_attempt) < 0) { errno = EALREADY; return -1; }
  o->invalid = 1;
  return oci_namespace_release_progress(o, lifetime);
}

int tns_oci_continue_namespace_release(struct tns_oci_owner *o,
                                         struct tns_oci_namespace_lifetime *lifetime) {
  if (!o || !lifetime || !o->namespace_release_attempt) { errno = EINVAL; return -1; }
  return oci_namespace_release_progress(o, lifetime);
}


/* Original cleanup custody remains mandatory independently of generic cancel.
 * The namespace owner alone retains the sent BEGIN and pre-handoff facts. */
static int oci_tracked_join_current(struct tns_oci_owner *o) {
  if (!o || !o->birth) { errno = EINVAL; return -1; }
  if (!o->namespace_release_attempt || !o->namespace_release_dispatched ||
      o->network >= 0 || o->namespace_loan_close_unknown) {
    errno = EUCLEAN; return -1;
  }
  return oci_namespace_release_current(o);
}

int tns_oci_begin_tracked_join(struct tns_oci_owner *o) {
  if (oci_tracked_join_current(o) < 0) return -1;
  if (tns_owner_begin_tracked_join(o->birth) < 0) return -1;
  /* BEGIN zero acknowledges only the original file-reference handoff. */
  int current = oci_tracked_join_current(o);
  if (!current && o->retirement_profile == OCI_RETIREMENT_RUNTIME_LOCAL)
    o->runtime_first_handoff_known = 1; /* Actual zero, never the attempt bit. */
  return current;
}

int tns_oci_read_tracked_join(struct tns_oci_owner *o) {
  if (oci_tracked_join_current(o) < 0) return -1;
  /* Original same-FD READ only: old LIFETIME/OBSERVE no longer have an owner
   * after BEGIN. No hidden retry, namespace release or cleanup is performed. */
  if (tns_owner_read_tracked_join(o->birth) < 0) return -1;
  return oci_tracked_join_current(o);
}


/* No caller supplies a runtime ID, path, PID or namespace. The same original
 * READ bookends all cleanup-current inputs; BEGIN ACK alone cannot enter here.
 * The state path was produced from the original held controller FD at CREATE. */
static int oci_born_delete_current(struct tns_oci_owner *o) {
  if (tns_oci_read_tracked_join(o) < 0) return -1;
  char path[sizeof(o->statepath)];
  if (oci_fd_path(path, sizeof(path), o->state) < 0 ||
      strcmp(path, o->statepath) || tns_oci_claim(o->id) < 0) {
    errno = ESTALE; return -1;
  }
  return 0;
}

static int oci_born_delete_state_current(struct tns_oci_owner *o) {
  struct stat held, named;
  if (!o->delete_state_pinned ||
      oci_owned(o->delete_state_fd, 1, 0700) < 0 ||
      fstat(o->delete_state_fd, &held) < 0 ||
      !oci_same(&held, &o->delete_state_identity) ||
      fstatat(o->state, o->id, &named, AT_SYMLINK_NOFOLLOW) < 0 ||
      !oci_same(&held, &named)) { errno = ESTALE; return -1; }
  return 0;
}

/* Poll timeout permits only another join of this same child. A possibly
 * consuming wait with an error/malformed reply is sticky UNKNOWN; neither
 * another wait nor another DELETE can manufacture a lost exit status. */
static int oci_join_born_delete_command(struct tns_oci_owner *o, int milliseconds) {
  if (o->delete_joined) return 0;
  if (o->delete_pid <= 0 || o->delete_pidfd < 0 || o->delete_wait_attempted) {
    errno = EUCLEAN; return -1;
  }
  struct pollfd p = {.fd = o->delete_pidfd, .events = POLLIN};
  int n = poll(&p, 1, milliseconds);
  if (n < 0) return -1;
  if (!n) { errno = ETIMEDOUT; return -1; }
  if (n != 1 || p.revents != POLLIN) { errno = EPROTO; return -1; }
  o->delete_wait_attempted = 1;
  siginfo_t info; memset(&info, 0, sizeof(info));
  if (waitid(P_PIDFD, (id_t)o->delete_pidfd, &info, WEXITED | WNOHANG) < 0)
    return -1;
  if (info.si_pid != o->delete_pid || info.si_signo != SIGCHLD ||
      (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED &&
       info.si_code != CLD_DUMPED) ||
      (info.si_code == CLD_EXITED ? info.si_status < 0 || info.si_status > 255 :
                                  info.si_status <= 0 || info.si_status >= NSIG)) {
    errno = EPROTO; return -1;
  }
  o->delete_joined = 1;
  o->delete_ok = info.si_code == CLD_EXITED && info.si_status == 0;
  return 0;
}

static int oci_born_delete_observed(struct tns_oci_owner *o) {
  if (!o->delete_joined || !o->delete_ok || !o->delete_state_pinned) {
    errno = EUCLEAN; return -1;
  }
  if (oci_born_delete_current(o) < 0) return -1;
  struct stat held, named;
  if (fstat(o->delete_state_fd, &held) < 0 ||
      !oci_same(&held, &o->delete_state_identity)) { errno = ESTALE; return -1; }
  if (fstatat(o->state, o->id, &named, AT_SYMLINK_NOFOLLOW) == 0) {
    errno = EEXIST; return -1;
  }
  if (errno != ENOENT) return -1;
  /* Zero is only joined-zero runtime DELETE plus fresh exact-state absence.
   * No remaining config/FD is released and no network/Core permit is created. */
  return oci_born_delete_current(o);
}

int tns_oci_join_born_delete(struct tns_oci_owner *o) {
  if (!o || !o->delete_attempt) { errno = EINVAL; return -1; }
  if (oci_born_delete_current(o) < 0 ||
      oci_join_born_delete_command(o, 10000) < 0) return -1;
  return oci_born_delete_observed(o);
}

int tns_oci_delete_born(struct tns_oci_owner *o) {
  if (!o) { errno = EINVAL; return -1; }
  if (o->delete_attempt) { errno = EALREADY; return -1; }
  if (oci_born_delete_current(o) < 0) return -1;
  if (tns_oci_once(&o->delete_attempt) < 0) { errno = EALREADY; return -1; }
  o->delete_pidfd = o->delete_state_fd = -1;
  o->delete_state_fd = openat(o->state, o->id,
                            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (o->delete_state_fd < 0 || oci_owned(o->delete_state_fd, 1, 0700) < 0 ||
      fstat(o->delete_state_fd, &o->delete_state_identity) < 0) return -1;
  o->delete_state_pinned = 1;
  if (oci_born_delete_state_current(o) < 0 || oci_born_delete_current(o) < 0)
    return -1;
  int64_t now = oci_now();
  if (now < 0) return -1;
  struct clone_args args; memset(&args, 0, sizeof(args));
  args.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND;
  args.pidfd = (uintptr_t)&o->delete_pidfd; args.exit_signal = SIGCHLD;
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (child < 0) return -1;
  if (!child) oci_command_child(o, o->controller_pid, OCI_COMMAND_DELETE);
  o->delete_pid = (pid_t)child;
  int64_t elapsed = oci_now();
  if (elapsed < 0 || elapsed - now >= 10000) { errno = ETIMEDOUT; return -1; }
  if (oci_join_born_delete_command(o, 10000 - (int)(elapsed - now)) < 0) return -1;
  return oci_born_delete_observed(o);
}


/* Only the explicit original runtime-first constructor can enter here.
 * Completion is minted by actual own policy/uplink/loan/custodian/release
 * readback above. No tracked READ, counter, netGone or caller result is used.
 * Generic cancellation cannot erase cleanup custody; identity remains required. */
static int oci_selected_runtime_delete_current(struct tns_oci_owner *o) {
  if (!o || !o->birth || (o->retirement_profile != OCI_RETIREMENT_RUNTIME_FIRST &&
                             o->retirement_profile != OCI_RETIREMENT_RUNTIME_LOCAL) ||
      !o->runtime_first_namespace_known || !o->namespace_release_attempt ||
      !o->namespace_release_dispatched || o->network >= 0 ||
      o->namespace_loan_close_unknown || o->egress_close_unknown ||
      o->admission || o->policy || o->uplink) { errno = EUCLEAN; return -1; }
  if (oci_namespace_release_current(o) < 0) return -1;
  char path[sizeof(o->statepath)];
  if (oci_fd_path(path, sizeof(path), o->state) < 0 ||
      strcmp(path, o->statepath) || tns_oci_claim(o->id) < 0) {
    errno = ESTALE; return -1;
  }
  return 0;
}

static int oci_selected_runtime_delete_observed(struct tns_oci_owner *o) {
  if (!o->delete_joined || !o->delete_ok || !o->delete_state_pinned) {
    errno = EUCLEAN; return -1;
  }
  if (oci_selected_runtime_delete_current(o) < 0) return -1;
  struct stat held, named;
  if (fstat(o->delete_state_fd, &held) < 0 ||
      !oci_same(&held, &o->delete_state_identity)) { errno = ESTALE; return -1; }
  if (fstatat(o->state, o->id, &named, AT_SYMLINK_NOFOLLOW) == 0) {
    errno = EEXIST; return -1;
  }
  if (errno != ENOENT) return -1;
  /* Zero is only joined-zero runtime DELETE plus fresh exact-state absence.
   * No remaining config/FD is released and no network/Core permit is created. */
  return oci_selected_runtime_delete_current(o);
}

int tns_oci_join_selected_runtime_delete(struct tns_oci_owner *o) {
  if (!o || !o->delete_attempt) { errno = EINVAL; return -1; }
  if (oci_selected_runtime_delete_current(o) < 0 ||
      oci_join_born_delete_command(o, 10000) < 0) return -1;
  return oci_selected_runtime_delete_observed(o);
}

int tns_oci_delete_selected_runtime(struct tns_oci_owner *o) {
  if (!o) { errno = EINVAL; return -1; }
  if (o->delete_attempt) { errno = EALREADY; return -1; }
  if (oci_selected_runtime_delete_current(o) < 0) return -1;
  if (tns_oci_once(&o->delete_attempt) < 0) { errno = EALREADY; return -1; }
  o->delete_pidfd = o->delete_state_fd = -1;
  o->delete_state_fd = openat(o->state, o->id,
                            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (o->delete_state_fd < 0 || oci_owned(o->delete_state_fd, 1, 0700) < 0 ||
      fstat(o->delete_state_fd, &o->delete_state_identity) < 0) return -1;
  o->delete_state_pinned = 1;
  if (oci_born_delete_state_current(o) < 0 || oci_selected_runtime_delete_current(o) < 0)
    return -1;
  int64_t now = oci_now();
  if (now < 0) return -1;
  struct clone_args args; memset(&args, 0, sizeof(args));
  args.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND;
  args.pidfd = (uintptr_t)&o->delete_pidfd; args.exit_signal = SIGCHLD;
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (child < 0) return -1;
  if (!child) oci_command_child(o, o->controller_pid, OCI_COMMAND_DELETE);
  o->delete_pid = (pid_t)child;
  int64_t elapsed = oci_now();
  if (elapsed < 0 || elapsed - now >= 10000) { errno = ETIMEDOUT; return -1; }
  if (oci_join_born_delete_command(o, 10000 - (int)(elapsed - now)) < 0) return -1;
  return oci_selected_runtime_delete_observed(o);
}


/* Target-free local disposal only. Before config consumption the original
 * currentness/DELETE/READ remains mandatory. Afterwards only recorded original
 * phase history can continue; global held-input predicates are never relaxed. */
static int oci_dispose_born_profile(struct tns_oci_owner **slot, int selected) {
  if (!slot || !*slot) { errno = EINVAL; return -1; }
  struct tns_oci_owner *o = *slot;
  if (o->controller_pid != getpid()) { errno = EPERM; return -1; }
  if ((selected && (o->retirement_profile != OCI_RETIREMENT_RUNTIME_LOCAL ||
                    !o->runtime_first_handoff_known)) ||
      (o->born_dispose_phase && o->born_dispose_selected != selected)) {
    errno = EUCLEAN; return -1;
  }
  if (!o->born_dispose_phase) {
    if (o->admission || o->policy || o->uplink || o->egress_close_unknown ||
        o->namespace_loan_close_unknown || !o->delete_attempt ||
        !o->delete_joined || !o->delete_ok || !o->delete_state_pinned) {
      errno = EUCLEAN; return -1;
    }
    for (size_t i = 0; i < 3; ++i)
      if (o->egress_pid[i] && !o->egress_joined[i]) { errno = EBUSY; return -1; }
    if ((selected ? oci_selected_runtime_delete_observed(o) : oci_born_delete_observed(o)) < 0) return -1;
    o->born_dispose_selected = selected; /* Fixed before config/FD effects. */
    o->born_dispose_phase = 1;
    o->born_config_fd = openat(o->bundle, "config.json",
                              O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    /* Keep even a subsequently invalid pin for later original-owner custody;
     * a failed pin never authorizes unlink or a second acquisition. */
  }
  if (o->born_dispose_phase == 1) {
    if (o->born_config_unlink_attempted) { errno = EUCLEAN; return -1; }
    struct stat held, named;
    if (o->born_config_fd < 0 || (selected ? oci_selected_runtime_delete_observed(o) : oci_born_delete_observed(o)) < 0 ||
        oci_owned(o->born_config_fd, 0, 0600) < 0 ||
        fstat(o->born_config_fd, &held) < 0 || held.st_nlink != 1 ||
        !oci_same(&held, &o->config_identity) ||
        held.st_size != o->config_identity.st_size ||
        held.st_mtim.tv_sec != o->config_identity.st_mtim.tv_sec ||
        held.st_mtim.tv_nsec != o->config_identity.st_mtim.tv_nsec ||
        held.st_ctim.tv_sec != o->config_identity.st_ctim.tv_sec ||
        held.st_ctim.tv_nsec != o->config_identity.st_ctim.tv_nsec ||
        fstatat(o->bundle, "config.json", &named, AT_SYMLINK_NOFOLLOW) < 0 ||
        !oci_same(&held, &named) || (selected ? oci_selected_runtime_delete_observed(o) : oci_born_delete_observed(o)) < 0) {
      if (!errno) errno = ESTALE;
      return -1;
    }
    o->born_config_unlink_attempted = 1; /* Before sole exact original unlink. */
    if (unlinkat(o->bundle, "config.json", 0) < 0) {
      o->born_dispose_unknown = 1;
      return -1; /* Unknown effect is never inferred from later absence. */
    }
    o->born_dispose_phase = 2;
  }
  /* Config is consumed: no old OCI currentness is replayed. The legacy
   * family requires its fresh READ; selected local cleanup uses the saved
   * release handoff. Both share the same original four-FD close history.
   * The real birth slot is cleared only after every known original close. */
  if (o->born_dispose_phase == 2) {
    if ((selected ? tns_owner_dispose_released(&o->birth) :
                    tns_owner_dispose_tracked(&o->birth)) < 0) return -1;
    if (o->birth) { errno = EPROTO; return -1; }
    o->born_dispose_phase = 3;
  }
  if (o->controller_pid != getpid()) { errno = EPERM; return -1; }
  if (o->born_dispose_phase == 3) {
    for (size_t i = 0; i < 3; ++i) {
      if (o->egress_pid[i] && !o->egress_joined[i]) { errno = EUCLEAN; return -1; }
      if (oci_egress_close_fd(o, &o->egress_in[i]) < 0 ||
          oci_egress_close_fd(o, &o->egress_out[i]) < 0) return -1;
    }
    /* Existing joined/close helpers never signal, respawn or reset UNKNOWN. */
    if (oci_egress_close(o) < 0) return -1;
    o->born_dispose_phase = 4;
  }
  int *remaining[] = {&o->born_config_fd, &o->delete_pidfd, &o->delete_state_fd,
    &o->command_pidfd, &o->start_pidfd, &o->stopped_exe,
    &o->init_pidfd, &o->init_proc, &o->init_pidns, &o->parent_pidns,
    &o->network, &o->state, &o->bundle, &o->runtime, &o->receipt,
    &o->rootfs, &o->root};
  for (size_t i = 0; i < sizeof(remaining) / sizeof(remaining[0]); ++i) {
    if (*remaining[i] < 0) continue;
    if (o->controller_pid != getpid()) { errno = EPERM; return -1; }
    /* Reuse the original consume-before-close helper. Its sticky egress
     * UNKNOWN is also preserved for any such remaining original close. */
    if (oci_egress_close_fd(o, remaining[i]) < 0) {
      o->born_dispose_unknown = 1;
      return -1;
    }
  }
  if (o->controller_pid != getpid()) { errno = EPERM; return -1; }
  if (o->born_dispose_unknown || o->egress_close_unknown) { errno = EUCLEAN; return -1; }
  /* Caller must save any reply identity before this local object is retired.
   * This is neither historical all-FD proof nor Core/traffic permission. */
  explicit_bzero(o, sizeof(*o));
  free(o);
  *slot = NULL;
  return 0;
}

int tns_oci_dispose_born(struct tns_oci_owner **slot) {
  return oci_dispose_born_profile(slot, 0);
}
int tns_oci_dispose_selected_runtime(struct tns_oci_owner **slot) {
  return oci_dispose_born_profile(slot, 1);
}
