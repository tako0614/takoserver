#define _GNU_SOURCE
#include "docker-container-terminal-namespace.h"
#include "docker-container-terminal-kernel-uapi.h"

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
#include <string.h>
#include <sys/eventfd.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Mandatory original kernel birth producer for the stopped OCI stage. The
 * fixed device creates a NEW owned namespace; there is no stock fallback or
 * caller namespace/PID/path. Child closes foreign FDs before setns. Kernel
 * observations are not full packet/queue/offload coverage or a terminal grant.
 * Unsupported device/clone3/pidfd/close_range/NSFS operations refuse. */
#define TNS_CREATE_MS 2500
#define TNS_CLOSE_MS 1000

_Static_assert(sizeof(struct tako_terminal_observation) == 48, "kernel observation ABI");
_Static_assert(sizeof(struct tako_terminal_lifetime_observation) == 72, "kernel lifetime ABI");

struct tns_owner {
  enum tns_phase phase;
  pid_t controller_pid;
  pid_t child;
  int pidfd;
  int procroot;
  int procfd;
  int netfd;
  int kernel_fd;
  int kernel_attempted;
  unsigned int admission_attempted,admission_acknowledged,cut_attempted,cut_confirmed;
  uint64_t kernel_cookie;
  struct stat device_identity;
  int control;
  int status;
  int kill_attempted;
  int namespace_loaned;
  int namespace_release_attempted;
  int kernel_release_attempted;
  int namespace_close_unknown;
  uint32_t lifetime_seen;
  struct tns_identity creator;
  struct tns_identity identity;
};

static int64_t tns_now(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t) < 0) return -1;
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int tns_remaining(int64_t deadline) {
  int64_t now = tns_now();
  if (now < 0) return -1;
  if (now >= deadline) { errno = ETIMEDOUT; return -1; }
  return (int)(deadline - now);
}

static void tns_close_fd(int *fd) {
  if (*fd >= 0) { close(*fd); *fd = -1; }
}

static int tns_alive(const struct tns_owner *owner) {
  struct pollfd p = {.fd = owner->pidfd, .events = POLLIN};
  if (owner->pidfd < 0) { errno = EBADF; return -1; }
  int n = poll(&p, 1, 0);
  if (n < 0) return -1;
  if (n || p.revents) { errno = ESRCH; return -1; }
  return 0;
}

static int tns_fd_identity(int fd, struct tns_identity *identity) {
  struct stat st;
  struct statfs fs;
  if (fstatfs(fd, &fs) < 0 || fstat(fd, &st) < 0) return -1;
  if ((unsigned long)fs.f_type != (unsigned long)NSFS_MAGIC ||
      ioctl(fd, NS_GET_NSTYPE) != CLONE_NEWNET || !st.st_dev || !st.st_ino) {
    errno = EPROTO;
    return -1;
  }
  identity->device = (uint64_t)st.st_dev;
  identity->inode = (uint64_t)st.st_ino;
  return 0;
}

static int tns_private_device(const struct stat *st) {
  return S_ISCHR(st->st_mode) && st->st_uid == 0 &&
         (st->st_mode & 0777) == 0600 && st->st_nlink == 1 && st->st_rdev;
}

static int tns_controller(const struct tns_owner *owner) {
  if (!owner || owner->controller_pid != getpid()) { errno = EPERM; return -1; }
  return 0;
}

static int tns_device_current(struct tns_owner *owner) {
  struct stat st;
  if (tns_controller(owner) < 0) return -1;
  if (fstat(owner->kernel_fd, &st) < 0) return -1;
  if (!tns_private_device(&st) || st.st_dev != owner->device_identity.st_dev ||
      st.st_ino != owner->device_identity.st_ino ||
      st.st_rdev != owner->device_identity.st_rdev) { errno = ESTALE; return -1; }
  return 0;
}

/* Known original CUT permits identity/cleanup observation of that sealed net.
 * It does not change the old unsealed pure oracle or accept poison/count loss. */
static int tns_kernel_snapshot_consistent(struct tns_owner *owner,
                                          const struct tako_terminal_observation *s) {
  if (s->sealed > 1 || s->sealed != (unsigned int)(owner->cut_confirmed != 0)) return 0;
  return tns_kernel_counts_consistent(s->full_ip_sockets,s->allocations,
                                     s->releases,0,s->poisoned);
}

static int tns_kernel_observe(struct tns_owner *owner) {
  struct tako_terminal_observation snapshot;
  struct tns_identity before, after;
  if (!owner->kernel_attempted || owner->kernel_fd < 0 || owner->netfd < 0) {
    errno = EINVAL; return -1;
  }
  memset(&snapshot, 0, sizeof(snapshot));
  if (tns_device_current(owner) < 0 ||
      tns_fd_identity(owner->netfd, &before) < 0) return -1;
  int result = ioctl(owner->kernel_fd, TAKO_TERMINAL_OBSERVE, &snapshot);
  if (result < 0) return -1; /* Interrupted/unknown ioctl is never replayed. */
  if (result || tns_fd_identity(owner->netfd, &after) < 0) {
    if (result) errno = EPROTO;
    return -1;
  }
  if (!tns_identity_equal(&before, &after) ||
      !tns_identity_equal(&owner->identity, &after) ||
      !tns_kernel_identity_matches(&owner->creator, &after, snapshot.net_cookie,
                                   snapshot.namespace_inum, owner->kernel_cookie) ||
      !tns_kernel_snapshot_consistent(owner,&snapshot) ||
      tns_device_current(owner) < 0) { errno = ESTALE; return -1; }
  if (!owner->kernel_cookie) owner->kernel_cookie = snapshot.net_cookie;
  return 0;
}

static int tns_safe_parent(int fd) {
  struct stat st;
  if (fstat(fd, &st) < 0) return -1;
  if (!S_ISDIR(st.st_mode) || st.st_uid != 0 || (st.st_mode & 022)) {
    errno = EPERM; return -1;
  }
  return 0;
}

static int tns_kernel_birth(struct tns_owner *owner) {
  int root = open("/", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0) return -1;
  int dev = -1, result = -1, saved;
  struct stat named, held;
  if (tns_safe_parent(root) < 0) goto done;
  dev = openat(root, "dev", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (dev < 0 || tns_safe_parent(dev) < 0) goto done;
  if (fstatat(dev, "tako-terminal", &named, AT_SYMLINK_NOFOLLOW) < 0) goto done;
  if (!tns_private_device(&named)) { errno = EPERM; goto done; }
  owner->kernel_fd = openat(dev, "tako-terminal",
                            O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (owner->kernel_fd < 0 || fstat(owner->kernel_fd, &held) < 0) goto done;
  if (!tns_private_device(&held) || held.st_dev != named.st_dev ||
      held.st_ino != named.st_ino || held.st_rdev != named.st_rdev) {
    errno = ESTALE; goto done;
  }
  owner->device_identity = held;
  if (tns_device_current(owner) < 0) goto done;
  owner->kernel_attempted = 1; /* original one-use before actual kernel CREATE */
  owner->netfd = ioctl(owner->kernel_fd, TAKO_TERMINAL_CREATE, 0UL);
  if (owner->netfd < 0) goto done; /* no EINTR/lost-return retry or stock fallback */
  int flags = fcntl(owner->netfd, F_GETFD);
  if (flags < 0) goto done;
  if (!(flags & FD_CLOEXEC)) { errno = EPROTO; goto done; }
  if (tns_fd_identity(owner->netfd, &owner->identity) < 0 ||
      tns_kernel_observe(owner) < 0) goto done;
  result = 0;
done:
  saved = errno;
  if (dev >= 0) close(dev);
  close(root);
  errno = saved;
  return result;
}

static void tns_put_u64(unsigned char *p, uint64_t value) {
  for (unsigned int i = 0; i < 8; ++i) {
    p[7 - i] = (unsigned char)value;
    value >>= 8;
  }
}

static void tns_child_message(unsigned int error,
                              const struct tns_identity *identity) {
  unsigned char bytes[TNS_WIRE_SIZE] = {'T', 'N', 'S', '1'};
  bytes[4] = error ? TNS_WIRE_ERROR : TNS_WIRE_CREATED;
  bytes[8] = (unsigned char)(error >> 24);
  bytes[9] = (unsigned char)(error >> 16);
  bytes[10] = (unsigned char)(error >> 8);
  bytes[11] = (unsigned char)error;
  if (identity) {
    tns_put_u64(bytes + 16, identity->device);
    tns_put_u64(bytes + 24, identity->inode);
  }
  /* One <= PIPE_BUF write, no partial-message retry or made-up success. */
  if (write(4, bytes, sizeof(bytes)) != (ssize_t)sizeof(bytes)) _exit(125);
}

static _Noreturn void tns_child(pid_t expected_parent, int control, int status,
                                int fresh_namespace) {
  int in = fcntl(control, F_DUPFD_CLOEXEC, 6);
  int out = fcntl(status, F_DUPFD_CLOEXEC, 6);
  int fresh = fcntl(fresh_namespace, F_DUPFD_CLOEXEC, 6);
  if (in < 0 || out < 0 || fresh < 0 || dup3(in, 3, O_CLOEXEC) < 0 ||
      dup3(out, 4, O_CLOEXEC) < 0 || dup3(fresh, 5, O_CLOEXEC) < 0) _exit(125);
  if (syscall(SYS_close_range, 6u, UINT_MAX, 0u) < 0) _exit(125);
  close(0); close(1); close(2);
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != expected_parent ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) _exit(125);
  struct pollfd p = {.fd = 3, .events = POLLIN};
  uint64_t go = 0;
  if (poll(&p, 1, TNS_CREATE_MS) != 1 || p.revents != POLLIN ||
      read(3, &go, sizeof(go)) != (ssize_t)sizeof(go) || go != 1) _exit(125);
  struct tns_identity target;
  if (tns_fd_identity(5, &target) < 0 || setns(5, CLONE_NEWNET) < 0) {
    tns_child_message((unsigned int)errno, NULL);
    _exit(125);
  }
  int ns = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
  struct tns_identity identity;
  if (ns < 0 || tns_fd_identity(ns, &identity) < 0) {
    unsigned int error = (unsigned int)errno;
    tns_child_message(error, NULL);
    _exit(125);
  }
  if (!tns_identity_equal(&target, &identity)) {
    tns_child_message(ESTALE, NULL);
    _exit(125);
  }
  close(ns);
  close(5);
  tns_child_message(0, &identity);
  close(4);
  /* This fixed child never spawns or executes a workload, configures an
   * interface, creates a socket, changes namespace again, or accepts a path.
   * Parent death kills it. Only an explicit control wake can end this wait. */
  p.revents = 0;
  (void)poll(&p, 1, -1);
  _exit(0);
}

static int tns_read_message(struct tns_owner *owner, int64_t deadline,
                            struct tns_wire_message *message) {
  unsigned char bytes[TNS_WIRE_SIZE + 1];
  size_t used = 0;
  for (;;) {
    int remaining = tns_remaining(deadline);
    if (remaining < 0) return -1;
    struct pollfd p[2] = {
      {.fd = owner->status, .events = POLLIN},
      {.fd = owner->pidfd, .events = POLLIN}
    };
    int n = poll(p, 2, remaining);
    if (n < 0) return -1;
    if (!n) { errno = ETIMEDOUT; return -1; }
    if (p[1].revents || (p[0].revents & (POLLERR | POLLNVAL))) {
      errno = EPROTO;
      return -1;
    }
    if (!(p[0].revents & (POLLIN | POLLHUP))) { errno = EPROTO; return -1; }
    ssize_t count = read(owner->status, bytes + used, sizeof(bytes) - used);
    if (count < 0) return -1;
    if (!count) {
      if (tns_wire_decode(bytes, used, message) < 0) { errno = EPROTO; return -1; }
      return 0;
    }
    used += (size_t)count;
    if (used > TNS_WIRE_SIZE) { errno = EPROTO; return -1; }
  }
}

static int tns_join(struct tns_owner *owner) {
  if (owner->child <= 0) return 0;
  if (!owner->kill_attempted) {
    owner->kill_attempted = 1;
    if (syscall(SYS_pidfd_send_signal, owner->pidfd, SIGKILL, NULL, 0) < 0 &&
        errno != ESRCH) return -1;
  }
  struct pollfd p = {.fd = owner->pidfd, .events = POLLIN};
  int n = poll(&p, 1, TNS_CLOSE_MS);
  if (n < 0) return -1;
  if (!n) { errno = ETIMEDOUT; return -1; }
  if (p.revents != POLLIN) { errno = EPROTO; return -1; }
  siginfo_t info;
  memset(&info, 0, sizeof(info));
  if (waitid(P_PIDFD, (id_t)owner->pidfd, &info, WEXITED | WNOHANG) < 0)
    return -1;
  if (info.si_pid != owner->child ||
      (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED &&
       info.si_code != CLD_DUMPED)) { errno = EPROTO; return -1; }
  owner->child = 0;
  return 0;
}

int tns_owner_create(struct tns_owner **slot) {
  if (!slot) { errno = EINVAL; return -1; }
  if (*slot) { errno = EALREADY; return -1; }
  struct tns_owner *owner = calloc(1, sizeof(*owner));
  if (!owner) return -1;
  owner->pidfd = owner->procfd = owner->netfd = -1;
  owner->kernel_fd = -1;
  owner->procroot = -1;
  owner->control = owner->status = -1;
  if (tns_phase_start(&owner->phase) < 0) { free(owner); errno = EPROTO; return -1; }
  *slot = owner; /* One-use before any namespace/process/descriptor effect. */
  owner->controller_pid = getpid();
  if (geteuid() != 0) { errno = EPERM; return -1; }
  int64_t now = tns_now();
  if (now < 0) return -1;
  int64_t deadline = now + TNS_CREATE_MS;
  struct sigaction action;
  if (sigaction(SIGCHLD, NULL, &action) < 0) return -1;
  if (action.sa_handler != SIG_DFL || (action.sa_flags & SA_NOCLDWAIT)) {
    errno = ENOTSUP;
    return -1;
  }
  owner->procroot = open("/proc", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (owner->procroot < 0) return -1;
  struct statfs procfs;
  if (fstatfs(owner->procroot, &procfs) < 0) return -1;
  if ((unsigned long)procfs.f_type != (unsigned long)PROC_SUPER_MAGIC) {
    errno = EPROTO;
    return -1;
  }
  int original = openat(owner->procroot, "self/ns/net", O_RDONLY | O_CLOEXEC);
  if (original < 0) return -1;
  int result = tns_fd_identity(original, &owner->creator);
  int saved = errno;
  close(original);
  if (result < 0) { errno = saved; return -1; }
  /* Mandatory actual birth ownership before ANY custodian clone or runc.
   * Missing/unsupported device refuses; kernel allocation has no userspace
   * hard deadline, so validate the original deadline again before clone. */
  if (tns_kernel_birth(owner) < 0 || tns_remaining(deadline) < 0) return -1;
  int channel[2];
  if (pipe2(channel, O_CLOEXEC | O_NONBLOCK) < 0) return -1;
  owner->status = channel[0];
  owner->control = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
  if (owner->control < 0) { close(channel[1]); return -1; }
  pid_t creator = getpid();
  struct clone_args args;
  memset(&args, 0, sizeof(args));
  args.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND;
  args.pidfd = (uint64_t)(uintptr_t)&owner->pidfd;
  args.exit_signal = SIGCHLD;
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (child == 0) tns_child(creator, owner->control, channel[1], owner->netfd);
  saved = errno;
  close(channel[1]);
  if (child < 0) { errno = saved; return -1; }
  owner->child = (pid_t)child;
  char procpath[64];
  int length = snprintf(procpath, sizeof(procpath), "%ld", child);
  if (length < 0 || (size_t)length >= sizeof(procpath)) { errno = EOVERFLOW; goto fail; }
  if (tns_alive(owner) < 0) goto fail;
  owner->procfd = openat(owner->procroot, procpath,
                         O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (owner->procfd < 0 || tns_alive(owner) < 0) goto fail;
  if (fstatfs(owner->procfd, &procfs) < 0) goto fail;
  if ((unsigned long)procfs.f_type != (unsigned long)PROC_SUPER_MAGIC) {
    errno = EPROTO;
    goto fail;
  }
  uint64_t go = 1;
  if (tns_remaining(deadline) < 0 ||
      write(owner->control, &go, sizeof(go)) != (ssize_t)sizeof(go)) goto fail;
  struct tns_wire_message message;
  if (tns_read_message(owner, deadline, &message) < 0) goto fail;
  if (message.kind == TNS_WIRE_ERROR) { errno = (int)message.error; goto fail; }
  if (tns_alive(owner) < 0) goto fail;
  int joined = openat(owner->procfd, "ns/net", O_RDONLY | O_CLOEXEC);
  if (joined < 0) goto fail;
  struct tns_identity current;
  result = tns_fd_identity(joined, &current);
  saved = errno;
  close(joined);
  if (result < 0) { errno = saved; goto fail; }
  if (!tns_identity_equal(&current, &owner->identity)) { errno = ESTALE; goto fail; }
  if (tns_alive(owner) < 0 || tns_kernel_observe(owner) < 0 ||
      tns_remaining(deadline) < 0) goto fail;
  if (!tns_birth_matches(&owner->creator, &message, &owner->identity) ||
      tns_phase_hold(&owner->phase) < 0) { errno = EPROTO; goto fail; }
  tns_close_fd(&owner->status);
  return 0;
fail:
  saved = errno ? errno : EPROTO;
  (void)tns_phase_close(&owner->phase);
  tns_close_fd(&owner->status);
  if (tns_join(owner) < 0) return -1; /* Held for close/join, never restart. */
  errno = saved;
  return -1;
}

int tns_owner_observe(struct tns_owner *owner, struct tns_identity *identity) {
  if (!owner || !identity || owner->phase != TNS_HELD) { errno = EINVAL; return -1; }
  if (tns_kernel_observe(owner) < 0 || tns_alive(owner) < 0) goto fail;
  struct tns_identity held, current;
  if (tns_fd_identity(owner->netfd, &held) < 0) goto fail;
  int fd = openat(owner->procfd, "ns/net", O_RDONLY | O_CLOEXEC);
  if (fd < 0) goto fail;
  int result = tns_fd_identity(fd, &current);
  int saved = errno;
  close(fd);
  if (result < 0) { errno = saved; goto fail; }
  if (!tns_identity_equal(&owner->identity, &held) ||
      !tns_identity_equal(&owner->identity, &current)) { errno = ESTALE; goto fail; }
  if (tns_alive(owner) < 0 || tns_kernel_observe(owner) < 0) goto fail;
  *identity = held;
  return 0;
fail:
  (void)tns_phase_close(&owner->phase);
  return -1;
}

int tns_owner_observe_creator(struct tns_owner *owner, struct tns_identity *identity) {
  if (!owner || !identity || owner->phase != TNS_HELD || tns_controller(owner) < 0) {
    if (!errno) errno = EPERM;
    return -1;
  }
  struct tns_identity before, current, after;
  if (tns_owner_observe(owner, &before) < 0) return -1;
  int fd = openat(owner->procroot, "self/ns/net", O_RDONLY | O_CLOEXEC);
  if (fd < 0) goto fail;
  int result = tns_fd_identity(fd, &current), saved = errno;
  if (close(fd) < 0) goto fail;
  if (result < 0) { errno = saved; goto fail; }
  if (!tns_identity_equal(&current, &owner->creator) ||
      tns_identity_equal(&current, &before) || tns_owner_observe(owner, &after) < 0 ||
      !tns_identity_equal(&before, &after)) { if (!errno) errno = ESTALE; goto fail; }
  *identity = current;
  return 0;
fail:
  (void)tns_phase_close(&owner->phase);
  return -1;
}

int tns_owner_dup_namespace(struct tns_owner *owner) {
  if (!owner || owner->phase != TNS_HELD) { errno = EINVAL; return -1; }
  if (owner->namespace_loaned) { errno = EALREADY; return -1; }
  owner->namespace_loaned = 1;
  struct tns_identity before, loaned, after;
  if (tns_owner_observe(owner, &before) < 0) return -1;
  int fd = fcntl(owner->netfd, F_DUPFD_CLOEXEC, 3);
  if (fd < 0) { (void)tns_phase_close(&owner->phase); return -1; }
  if (tns_fd_identity(fd, &loaned) < 0 ||
      tns_owner_observe(owner, &after) < 0 ||
      !tns_identity_equal(&before, &loaned) ||
      !tns_identity_equal(&before, &after)) {
    int saved = errno ? errno : ESTALE;
    close(fd);
    (void)tns_phase_close(&owner->phase);
    errno = saved;
    return -1;
  }
  return fd;
}

int tns_owner_stop_custodian(struct tns_owner *owner) {
  if (!owner) { errno = EINVAL; return -1; }
  if (tns_controller(owner) < 0) return -1;
  if (tns_phase_close(&owner->phase) < 0) { errno = EPROTO; return -1; }
  if (tns_join(owner) < 0) return -1;
  tns_close_fd(&owner->status);
  tns_close_fd(&owner->control);
  /* Keep original kernel/NSFS FDs and private owner, including after a born
   * runtime loses transport. This does not issue RELEASE_NAMESPACE or free. */
  return 0;
}

int tns_owner_close(struct tns_owner **slot) {
  if (!slot || !*slot) { errno = EINVAL; return -1; }
  struct tns_owner *owner = *slot;
  if (tns_owner_stop_custodian(owner) < 0) return -1;
  tns_close_fd(&owner->netfd);
  tns_close_fd(&owner->kernel_fd);
  tns_close_fd(&owner->procfd);
  tns_close_fd(&owner->procroot);
  tns_close_fd(&owner->pidfd);
  free(owner);
  *slot = NULL;
  return 0;
}

int tns_owner_observe_lifetime(struct tns_owner *owner,
                                 struct tns_lifetime *lifetime) {
  if (!owner || !lifetime || !owner->kernel_attempted || !owner->kernel_cookie ||
      (owner->phase != TNS_HELD && owner->phase != TNS_CLOSING)) {
    errno = EINVAL; return -1;
  }
  if (tns_device_current(owner) < 0) return -1;
  struct tako_terminal_lifetime_observation actual;
  memset(&actual, 0, sizeof(actual));
  int result = ioctl(owner->kernel_fd, TAKO_TERMINAL_LIFETIME, &actual);
  if (result < 0) return -1; /* One read; no EINTR/unknown-read replay. */
  if (result || actual.reserved || actual.born != 1 || actual.release_attempted > 1 ||
      actual.reference_released > 1 || actual.net_gone > 1 || actual.poisoned > 1 ||
      (actual.reference_released && !actual.release_attempted) ||
      (actual.net_gone && !actual.release_attempted) ||
      (actual.release_attempted && !owner->kernel_release_attempted) ||
      (actual.net_gone && owner->netfd >= 0) ||
      !tns_kernel_identity_matches(&owner->creator, &owner->identity,
                                   actual.net_cookie, actual.namespace_inum,
                                   owner->kernel_cookie)) { errno = EPROTO; return -1; }
  uint32_t flags = actual.release_attempted | (actual.reference_released << 1) |
                   (actual.net_gone << 2) | (actual.poisoned << 3);
  if ((flags & owner->lifetime_seen) != owner->lifetime_seen ||
      tns_device_current(owner) < 0) { errno = ESTALE; return -1; }
  owner->lifetime_seen = flags;
  struct tns_lifetime observed = {
    .identity = owner->identity, .net_cookie = actual.net_cookie,
    .full_ip_sockets = actual.full_ip_sockets, .requests = actual.requests,
    .timewait = actual.timewait, .packet_groups = actual.packet_groups,
    .born = actual.born, .release_attempted = actual.release_attempted,
    .reference_released = actual.reference_released, .net_gone = actual.net_gone,
    .poisoned = actual.poisoned
  };
  *lifetime = observed;
  return 0;
}

/* These no-field effects remain bound to the original device open. A lost
 * response consumes its attempt; neither an observation nor a caller flag
 * permits reopening. CUT is allowed in failed/closing phases so uncertainty
 * cannot require successful policy/currentness before closing the gate. */
int tns_owner_cut_admission(struct tns_owner *owner) {
  if (!owner || tns_controller(owner) < 0) return -1;
  /* With no device and CREATE never attempted there is no kernel target.
   * Keep OPEN forbidden without manufacturing a confirmed CUT or replaying I/O. */
  if (owner->kernel_fd < 0 && !owner->kernel_attempted) {
    owner->cut_attempted = 1;
    return 0;
  }
  if (owner->cut_attempted) {
    if (owner->cut_confirmed) return 0;
    errno = EUCLEAN; return -1;
  }
  owner->cut_attempted = 1;
  if (tns_device_current(owner) < 0) return -1;
  int result = ioctl(owner->kernel_fd,TAKO_TERMINAL_CUT,0UL);
  if (result < 0) return -1;
  if (result) { errno = EPROTO; return -1; }
  struct tako_terminal_observation observed;
  memset(&observed,0,sizeof(observed));
  struct tns_identity before,after;
  if (owner->netfd < 0 || tns_fd_identity(owner->netfd,&before) < 0 ||
      !tns_identity_equal(&before,&owner->identity) || !owner->kernel_cookie) return -1;
  result = ioctl(owner->kernel_fd,TAKO_TERMINAL_OBSERVE,&observed);
  if (result < 0) return -1;
  if (result || observed.sealed != 1 || observed.poisoned > 1 ||
      !tns_kernel_identity_matches(&owner->creator,&owner->identity,
          observed.net_cookie,observed.namespace_inum,owner->kernel_cookie) ||
      tns_fd_identity(owner->netfd,&after) < 0 || !tns_identity_equal(&before,&after) ||
      tns_device_current(owner) < 0) { errno = ESTALE; return -1; }
  owner->cut_confirmed = 1; /* Sealed same-owner observation, never a packet join. */
  return 0;
}
int tns_owner_admission_current(struct tns_owner *owner) {
  if (!owner || tns_controller(owner) < 0) return -1;
  if (!owner->admission_acknowledged || owner->cut_attempted ||
      owner->namespace_release_attempted || owner->kernel_release_attempted) {
    errno=EUCLEAN;return -1;
  }
  return tns_kernel_observe(owner);
}
int tns_owner_open_admission(struct tns_owner *owner) {
  if (!owner || tns_controller(owner) < 0) return -1;
  if (owner->admission_attempted || owner->cut_attempted) { errno = EALREADY; return -1; }
  owner->admission_attempted = 1;
  struct tns_identity identity;
  struct tns_lifetime lifetime;
  if (tns_owner_observe(owner,&identity) < 0 ||
      tns_owner_observe_lifetime(owner,&lifetime) < 0 ||
      !tns_identity_equal(&identity,&lifetime.identity) || lifetime.release_attempted ||
      lifetime.reference_released || lifetime.net_gone || lifetime.poisoned) goto fail;
  int result = ioctl(owner->kernel_fd,TAKO_TERMINAL_OPEN,0UL);
  if (result < 0) goto fail;
  if (result) { errno = EPROTO; goto fail; }
  if (tns_kernel_observe(owner) < 0) goto fail;
  owner->admission_acknowledged = 1; /* Effect/read fact only, not serving. */
  return 0;
fail: {
  int saved = errno ? errno : ESTALE;
  if (tns_owner_cut_admission(owner) < 0) return -1;
  errno = saved; return -1;
  }
}

/* The held NSFS may already have had a close attempted. In that phase use
 * the SAME original creator-bound ledger/cookie, preserving original sealed,
 * poisoned and full-sock consistency refusal; no observation creates a phase. */
static int tns_release_ledger_current(struct tns_owner *owner) {
  if (owner->netfd >= 0) return tns_kernel_observe(owner);
  if (!owner->namespace_release_attempted || owner->phase != TNS_CLOSING ||
      owner->child != 0 || owner->kernel_release_attempted || !owner->kernel_cookie) {
    errno = EINVAL; return -1;
  }
  if (tns_device_current(owner) < 0) return -1;
  struct tako_terminal_observation actual;
  memset(&actual, 0, sizeof(actual));
  int result = ioctl(owner->kernel_fd, TAKO_TERMINAL_OBSERVE, &actual);
  if (result < 0) return -1;
  if (result || !tns_kernel_identity_matches(&owner->creator, &owner->identity,
                                             actual.net_cookie, actual.namespace_inum,
                                             owner->kernel_cookie) ||
      !tns_kernel_snapshot_consistent(owner,&actual) ||
      tns_device_current(owner) < 0) { errno = ESTALE; return -1; }
  return 0;
}

static int tns_namespace_release_progress(struct tns_owner *owner,
                                            struct tns_lifetime *lifetime) {
  if (owner->kernel_release_attempted) { errno = EALREADY; return -1; }
  struct tns_lifetime before;
  if (tns_release_ledger_current(owner) < 0 ||
      tns_owner_observe_lifetime(owner, &before) < 0) return -1;
  /* The unchanged join consumes no second signal after its original attempt;
   * child becomes zero only after its actual matched consuming PIDFD wait. */
  if (tns_owner_stop_custodian(owner) < 0 || owner->child != 0) return -1;
  if (owner->netfd >= 0) {
    struct tns_identity held;
    if (tns_kernel_observe(owner) < 0 || tns_fd_identity(owner->netfd, &held) < 0 ||
        !tns_identity_equal(&held, &owner->identity) || tns_device_current(owner) < 0) {
      if (!errno) errno = ESTALE;
      return -1;
    }
    int fd = owner->netfd;
    owner->netfd = -1; /* Attempt fact, never proof of release on close error. */
    if (close(fd) < 0) { owner->namespace_close_unknown = 1; return -1; }
  }
  if (tns_release_ledger_current(owner) < 0 ||
      tns_owner_observe_lifetime(owner, &before) < 0) return -1;
  owner->kernel_release_attempted = 1; /* Consume before the sole raw ioctl. */
  int result = ioctl(owner->kernel_fd, TAKO_TERMINAL_RELEASE_NAMESPACE, 0UL);
  if (result < 0) return -1; /* Sent UNKNOWN is never retransmitted. */
  if (result) { errno = EPROTO; return -1; }
  struct tns_lifetime observed;
  if (tns_owner_observe_lifetime(owner, &observed) < 0) return -1;
  if (owner->namespace_close_unknown) { errno = EUCLEAN; return -1; }
  *lifetime = observed;
  return 0;
}

int tns_owner_release_namespace(struct tns_owner *owner,
                                  struct tns_lifetime *lifetime) {
  if (!owner || !lifetime || !owner->namespace_loaned ||
      (owner->phase != TNS_HELD && owner->phase != TNS_CLOSING)) {
    errno = EINVAL; return -1;
  }
  if (owner->namespace_release_attempted) { errno = EALREADY; return -1; }
  owner->namespace_release_attempted = 1;
  if (tns_phase_close(&owner->phase) < 0) { errno = EPROTO; return -1; }
  return tns_namespace_release_progress(owner, lifetime);
}

int tns_owner_continue_namespace_release(struct tns_owner *owner,
                                           struct tns_lifetime *lifetime) {
  if (!owner || !lifetime || !owner->namespace_release_attempted ||
      !owner->namespace_loaned || owner->phase != TNS_CLOSING) {
    errno = EINVAL; return -1;
  }
  return tns_namespace_release_progress(owner, lifetime);
}
