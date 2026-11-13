#define _GNU_SOURCE
#include "docker-container-terminal-namespace.h"

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

/* Standalone future OCI-backend primitive. No Docker wiring, workload spawn,
 * namespace export, firewall, kernel lifetime owner, or terminal claim exists.
 * All non-custodian inherited FDs are closed before unshare. Unsupported
 * clone3/pidfd/close_range/NSFS operations refuse; there is no PID fallback. */
#define TNS_CREATE_MS 2500
#define TNS_CLOSE_MS 1000

struct tns_owner {
  enum tns_phase phase;
  pid_t child;
  int pidfd;
  int procroot;
  int procfd;
  int netfd;
  int control;
  int status;
  int kill_attempted;
  int namespace_loaned;
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

static _Noreturn void tns_child(pid_t expected_parent, int control, int status) {
  int in = fcntl(control, F_DUPFD_CLOEXEC, 5);
  int out = fcntl(status, F_DUPFD_CLOEXEC, 5);
  if (in < 0 || out < 0 || dup3(in, 3, O_CLOEXEC) < 0 ||
      dup3(out, 4, O_CLOEXEC) < 0) _exit(125);
  if (syscall(SYS_close_range, 5u, UINT_MAX, 0u) < 0) _exit(125);
  close(0); close(1); close(2);
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != expected_parent ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) _exit(125);
  struct pollfd p = {.fd = 3, .events = POLLIN};
  uint64_t go = 0;
  if (poll(&p, 1, TNS_CREATE_MS) != 1 || p.revents != POLLIN ||
      read(3, &go, sizeof(go)) != (ssize_t)sizeof(go) || go != 1) _exit(125);
  if (unshare(CLONE_NEWNET) < 0) {
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
  owner->procroot = -1;
  owner->control = owner->status = -1;
  if (tns_phase_start(&owner->phase) < 0) { free(owner); errno = EPROTO; return -1; }
  *slot = owner; /* One-use before any namespace/process/descriptor effect. */
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
  if (child == 0) tns_child(creator, owner->control, channel[1]);
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
  owner->netfd = openat(owner->procfd, "ns/net", O_RDONLY | O_CLOEXEC);
  if (owner->netfd < 0 || tns_fd_identity(owner->netfd, &owner->identity) < 0 ||
      tns_alive(owner) < 0 || tns_remaining(deadline) < 0) goto fail;
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
  if (tns_alive(owner) < 0) goto fail;
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
  if (tns_alive(owner) < 0) goto fail;
  *identity = held;
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

int tns_owner_close(struct tns_owner **slot) {
  if (!slot || !*slot) { errno = EINVAL; return -1; }
  struct tns_owner *owner = *slot;
  if (tns_phase_close(&owner->phase) < 0) { errno = EPROTO; return -1; }
  if (tns_join(owner) < 0) return -1;
  tns_close_fd(&owner->status);
  tns_close_fd(&owner->control);
  tns_close_fd(&owner->netfd);
  tns_close_fd(&owner->procfd);
  tns_close_fd(&owner->procroot);
  tns_close_fd(&owner->pidfd);
  free(owner);
  *slot = NULL;
  return 0;
}
