#define _GNU_SOURCE
/* Actual original namespace constructor and consumer bodies over closed raw
 * syscall boundaries. No opaque owner is supplied by a positive test factory.
 * No real device, FD, child, namespace, signal or kernel ioctl is used. */
#include <assert.h>
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
#include <stdint.h>
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
#include "../../scripts/native/docker-container-terminal-namespace.h"
#include "../../scripts/native/docker-container-terminal-kernel-uapi.h"
static int raw_open(const char *path, int flags, ...);
static int raw_openat(int dir, const char *path, int flags, ...);
static int raw_fstat(int fd, struct stat *out);
static int raw_fstatat(int dir, const char *path, struct stat *out, int flags);
static int raw_fstatfs(int fd, struct statfs *out);
static int raw_close(int fd);
static int raw_fcntl(int fd, int command, ...);
static int raw_ioctl(int fd, unsigned long command, ...);
static int raw_poll(struct pollfd *fds, nfds_t count, int timeout);
static int raw_waitid(idtype_t type, id_t pid, siginfo_t *out, int flags);
static long raw_syscall(long number, ...);
static int raw_pipe2(int fds[2], int flags);
static int raw_eventfd(unsigned int value, int flags);
static int raw_clock_gettime(clockid_t clock, struct timespec *out);
static ssize_t raw_read(int fd, void *out, size_t count);
static ssize_t raw_write(int fd, const void *bytes, size_t count);
static pid_t raw_getpid(void);
static pid_t raw_getppid(void);
static uid_t raw_geteuid(void);
static int raw_sigaction(int number, const struct sigaction *in, struct sigaction *out);
static int raw_setns(int fd, int type);
static int raw_dup3(int oldfd, int newfd, int flags);
static int raw_prctl(int operation, ...);
#define open raw_open
#define openat raw_openat
#define fstat raw_fstat
#define fstatat raw_fstatat
#define fstatfs raw_fstatfs
#define close raw_close
#define fcntl raw_fcntl
#define ioctl raw_ioctl
#define poll raw_poll
#define waitid raw_waitid
#define syscall raw_syscall
#define pipe2 raw_pipe2
#define eventfd raw_eventfd
#define clock_gettime raw_clock_gettime
#define read raw_read
#define write raw_write
#define getpid raw_getpid
#define getppid raw_getppid
#define geteuid raw_geteuid
#define sigaction(...) raw_sigaction(__VA_ARGS__)
#define setns raw_setns
#define dup3 raw_dup3
#define prctl raw_prctl
#ifndef NAMESPACE_SOURCE
#define NAMESPACE_SOURCE "../../scripts/native/docker-container-terminal-namespace.c"
#endif
#include NAMESPACE_SOURCE
#undef open
#undef openat
#undef fstat
#undef fstatat
#undef fstatfs
#undef close
#undef fcntl
#undef ioctl
#undef poll
#undef waitid
#undef syscall
#undef pipe2
#undef eventfd
#undef clock_gettime
#undef read
#undef write
#undef getpid
#undef getppid
#undef geteuid
#undef sigaction
#undef setns
#undef dup3
#undef prctl

enum { ROOT = 10, DEV, DEVICE, PROCROOT, ORIGINAL_NS, BIRTH_NS, STATUS,
       STATUS_WRITE, CONTROL, PIDFD, CHILD_PROC, JOINED_NS, LOAN, MAX_FD };
enum fault { NONE, WRONG_CONTROLLER, BAD_DEVICE, MISSING_DEVICE, CLOSE_UNKNOWN,
  CUSTODIAN_WRONG_PID, CUSTODIAN_TIMEOUT, BAD_COOKIE, BAD_RELEASE, POISON,
  BEGIN_LOST_EFFECT, BEGIN_LOST_NO_EFFECT, BEGIN_POSITIVE, BEGIN_LATE_DEVICE,
  READ_INTERRUPTED, READ_POSITIVE, READ_UNCLEAN, READ_NO_DATA, READ_LATE_DEVICE };
struct raw_model {
  struct tns_owner **slot;
  enum fault fault;
  unsigned int fd_live[MAX_FD], closes[MAX_FD];
  unsigned int creates, clones, signals, reaps, observes, life_reads, releases;
  unsigned int begin_calls, read_calls, began, freed_events, seq, life_seq, begin_seq;
  unsigned int after_begin_old_reads, message_reads;
  int custodian_exited, released, late_bad_device;
  unsigned char *tracked_allocation;
};
static struct raw_model m;
static unsigned int checks;
#define CHECK(x) do { checks++; assert(x); } while (0)
static int allocate_fd(int fd) { CHECK(fd >= ROOT && fd < MAX_FD && !m.fd_live[fd]); m.fd_live[fd] = 1; return fd; }
static void fd_current(int fd) { CHECK(fd >= ROOT && fd < MAX_FD && m.fd_live[fd]); }
static struct tns_owner *original_owner(void) { CHECK(m.slot && *m.slot); return *m.slot; }
static void reset(struct tns_owner **slot) {
  memset(&m, 0, sizeof(m)); m.slot = slot; *slot = NULL; errno = 0;
}
static pid_t raw_getpid(void) { return m.fault == WRONG_CONTROLLER ? 1001 : 1000; }
static pid_t raw_getppid(void) { CHECK(!"fixed child branch must never execute"); return 0; }
static uid_t raw_geteuid(void) { return 0; }
static int raw_clock_gettime(clockid_t clock, struct timespec *out) {
  CHECK(clock == CLOCK_MONOTONIC); *out = (struct timespec){.tv_sec = 1}; return 0;
}
static int raw_sigaction(int number, const struct sigaction *in, struct sigaction *out) {
  CHECK(number == SIGCHLD && !in && out); memset(out, 0, sizeof(*out)); out->sa_handler = SIG_DFL; return 0;
}
static int raw_open(const char *path, int flags, ...) {
  CHECK(flags & O_CLOEXEC);
  if (!strcmp(path, "/proc")) return allocate_fd(PROCROOT);
  CHECK(!strcmp(path, "/")); return allocate_fd(ROOT);
}
static int raw_openat(int dir, const char *path, int flags, ...) {
  fd_current(dir); CHECK(flags & O_CLOEXEC);
  if (dir == ROOT) { CHECK(!strcmp(path, "dev")); return allocate_fd(DEV); }
  if (dir == DEV) { CHECK(!strcmp(path, "tako-terminal")); return allocate_fd(DEVICE); }
  if (dir == PROCROOT) {
    if (!strcmp(path, "self/ns/net")) return allocate_fd(ORIGINAL_NS);
    CHECK(!strcmp(path, "2000")); return allocate_fd(CHILD_PROC);
  }
  CHECK(dir == CHILD_PROC && !strcmp(path, "ns/net")); return allocate_fd(JOINED_NS);
}
static void stat_data(int fd, struct stat *out) {
  memset(out, 0, sizeof(*out)); out->st_uid = 0; out->st_nlink = 1;
  out->st_dev = 1; out->st_ino = (ino_t)(100 + fd); out->st_mode = S_IFDIR | 0700;
  if (fd == ORIGINAL_NS || fd == BIRTH_NS || fd == JOINED_NS || fd == LOAN) {
    out->st_dev = 9; out->st_ino = fd == ORIGINAL_NS ? 700 : 701;
  }
  if (fd == DEVICE) {
    out->st_mode = S_IFCHR | 0600; out->st_rdev = 123;
    if (m.fault == BAD_DEVICE || m.late_bad_device) out->st_ino++;
  }
}
static int raw_fstat(int fd, struct stat *out) {
  fd_current(fd); if (fd == DEVICE && m.fault == MISSING_DEVICE) { errno = EBADF; return -1; }
  stat_data(fd, out); return 0;
}
static int raw_fstatat(int dir, const char *path, struct stat *out, int flags) {
  fd_current(dir); CHECK(dir == DEV && !strcmp(path, "tako-terminal") && flags == AT_SYMLINK_NOFOLLOW);
  stat_data(DEVICE, out); return 0;
}
static int raw_fstatfs(int fd, struct statfs *out) {
  fd_current(fd); memset(out, 0, sizeof(*out));
  if (fd == PROCROOT || fd == CHILD_PROC) out->f_type = PROC_SUPER_MAGIC;
  else { CHECK(fd == ORIGINAL_NS || fd == BIRTH_NS || fd == JOINED_NS || fd == LOAN); out->f_type = NSFS_MAGIC; }
  return 0;
}
static int raw_close(int fd) {
  fd_current(fd); m.closes[fd]++; m.fd_live[fd] = 0;
  if (fd == BIRTH_NS && m.fault == CLOSE_UNKNOWN) { errno = EINTR; return -1; }
  return 0;
}
static int raw_fcntl(int fd, int command, ...) {
  fd_current(fd);
  if (command == F_GETFD) return FD_CLOEXEC;
  CHECK(fd == BIRTH_NS && command == F_DUPFD_CLOEXEC);
  va_list ap; va_start(ap, command); CHECK(va_arg(ap, int) == 3); va_end(ap);
  return allocate_fd(LOAN);
}
static int raw_pipe2(int fds[2], int flags) {
  CHECK(flags == (O_CLOEXEC | O_NONBLOCK)); fds[0] = allocate_fd(STATUS); fds[1] = allocate_fd(STATUS_WRITE); return 0;
}
static int raw_eventfd(unsigned int value, int flags) {
  CHECK(value == 0 && flags == (EFD_CLOEXEC | EFD_NONBLOCK)); return allocate_fd(CONTROL);
}
static long raw_syscall(long number, ...) {
  va_list ap; va_start(ap, number);
  if (number == SYS_clone3) {
    struct clone_args *args = va_arg(ap, struct clone_args *); CHECK(va_arg(ap, size_t) == sizeof(*args));
    CHECK(args->flags == (CLONE_PIDFD | CLONE_CLEAR_SIGHAND) && args->exit_signal == SIGCHLD);
    CHECK(args->pidfd == (uint64_t)(uintptr_t)&original_owner()->pidfd);
    *(int *)(uintptr_t)args->pidfd = allocate_fd(PIDFD); m.clones++; va_end(ap); return 2000;
  }
  CHECK(number == SYS_pidfd_send_signal); CHECK(va_arg(ap, int) == PIDFD);
  CHECK(va_arg(ap, int) == SIGKILL && va_arg(ap, void *) == NULL && va_arg(ap, int) == 0);
  va_end(ap); CHECK(original_owner()->kill_attempted && !m.signals);
  m.signals++; m.custodian_exited = 1; return 0;
}
static int raw_poll(struct pollfd *fds, nfds_t count, int timeout) {
  if (count == 2) {
    CHECK(fds[0].fd == STATUS && fds[1].fd == PIDFD && timeout > 0);
    fd_current(STATUS); fd_current(PIDFD);
    fds[0].revents = m.message_reads ? POLLHUP : POLLIN; fds[1].revents = 0; return 1;
  }
  CHECK(count == 1 && fds[0].fd == PIDFD && fds[0].events == POLLIN); fd_current(PIDFD);
  CHECK(timeout == 0 || timeout == TNS_CLOSE_MS);
  if (timeout && m.fault == CUSTODIAN_TIMEOUT) return 0;
  fds[0].revents = m.custodian_exited ? POLLIN : 0; return m.custodian_exited ? 1 : 0;
}
static int raw_waitid(idtype_t type, id_t pid, siginfo_t *out, int flags) {
  CHECK(type == P_PIDFD && pid == PIDFD && flags == (WEXITED | WNOHANG));
  CHECK(m.custodian_exited); m.reaps++;
  memset(out, 0, sizeof(*out)); out->si_pid = m.fault == CUSTODIAN_WRONG_PID ? 2001 : 2000;
  out->si_code = CLD_KILLED; out->si_status = SIGKILL; return 0;
}
static ssize_t raw_read(int fd, void *out, size_t count) {
  fd_current(fd); CHECK(fd == STATUS);
  if (m.message_reads++) return 0;
  CHECK(count == TNS_WIRE_SIZE + 1);
  unsigned char frame[TNS_WIRE_SIZE] = {'T','N','S','1', TNS_WIRE_CREATED};
  tns_put_u64(frame + 16, 9); tns_put_u64(frame + 24, 701);
  memcpy(out, frame, sizeof(frame)); return (ssize_t)sizeof(frame);
}
static ssize_t raw_write(int fd, const void *bytes, size_t count) {
  fd_current(fd); CHECK(fd == CONTROL && count == sizeof(uint64_t) && *(const uint64_t *)bytes == 1);
  return (ssize_t)count;
}
static int raw_setns(int fd, int type) { (void)fd; (void)type; CHECK(!"child branch never executes"); return -1; }
static int raw_dup3(int oldfd, int newfd, int flags) { (void)oldfd; (void)newfd; (void)flags; CHECK(!"child branch never executes"); return -1; }
static int raw_prctl(int operation, ...) { (void)operation; CHECK(!"child branch never executes"); return -1; }
static int raw_ioctl(int fd, unsigned long command, ...) {
  fd_current(fd); m.seq++;
  if (command == NS_GET_NSTYPE) { CHECK(fd == ORIGINAL_NS || fd == BIRTH_NS || fd == JOINED_NS || fd == LOAN); return CLONE_NEWNET; }
  CHECK(fd == DEVICE); va_list ap; va_start(ap, command);
  if (command == TAKO_TERMINAL_OBSERVE || command == TAKO_TERMINAL_LIFETIME) {
    void *out = va_arg(ap, void *); va_end(ap);
    if (m.began) { m.after_begin_old_reads++; errno = ENODATA; return -1; }
    if (command == TAKO_TERMINAL_OBSERVE) {
      m.observes++; struct tako_terminal_observation *s = out; memset(s, 0, sizeof(*s));
      s->net_cookie = 777; s->namespace_inum = 701;
      s->sealed = original_owner()->cut_attempted ? 1u : 0u; return 0;
    }
    m.life_reads++; m.life_seq = m.seq;
    struct tako_terminal_lifetime_observation *s = out; memset(s, 0, sizeof(*s));
    s->net_cookie = m.fault == BAD_COOKIE ? 778 : 777; s->namespace_inum = 701;
    s->born = 1; s->release_attempted = s->reference_released = (uint32_t)m.released;
    if (m.fault == BAD_RELEASE) s->reference_released = 0;
    s->net_gone = (uint32_t)m.released; /* can be gone while object still held */
    s->packet_groups = m.tracked_allocation ? 1 : 0; s->poisoned = m.fault == POISON ? 1u : 0u;
    return 0;
  }
  CHECK(va_arg(ap, unsigned long) == 0UL); va_end(ap);
  if (command == TAKO_TERMINAL_CREATE) {
    CHECK(original_owner()->kernel_attempted && !m.creates); m.creates++;
    m.tracked_allocation = malloc(1); CHECK(m.tracked_allocation); return allocate_fd(BIRTH_NS);
  }
  if (command == TAKO_TERMINAL_CUT) return 0;
  if (command == TAKO_TERMINAL_RELEASE_NAMESPACE) {
    CHECK(original_owner()->kernel_release_attempted && !original_owner()->child && original_owner()->netfd < 0);
    CHECK(!m.releases); m.releases++; m.released = 1; return 0;
  }
  if (command == TAKO_TERMINAL_OWNER_JOIN_BEGIN) {
    struct tns_owner *o = original_owner();
    CHECK(o->tracked_join_attempted && o->tracked_join_before.reference_released == 1);
    CHECK(!o->child && !m.fd_live[BIRTH_NS] && !m.fd_live[LOAN]);
    CHECK(m.life_seq && m.life_seq < m.seq && !m.begin_calls && m.released);
    m.begin_calls++; m.begin_seq = m.seq;
    if (m.fault == BEGIN_LOST_NO_EFFECT) { errno = EINTR; return -1; }
    m.began = 1;
    if (m.fault == BEGIN_LOST_EFFECT) { errno = EINTR; return -1; }
    if (m.fault == BEGIN_POSITIVE) return 1;
    if (m.fault == BEGIN_LATE_DEVICE) m.late_bad_device = 1;
    return 0;
  }
  CHECK(command == TAKO_TERMINAL_OWNER_JOIN_READ); m.read_calls++;
  if (m.fault == READ_INTERRUPTED) { errno = EINTR; return -1; }
  if (m.fault == READ_POSITIVE) return 1;
  if (m.fault == READ_UNCLEAN) { errno = EUCLEAN; return -1; }
  if (m.fault == READ_NO_DATA || !m.began) { errno = ENODATA; return -1; }
  if (!m.freed_events) { errno = EAGAIN; return -1; }
  CHECK(!m.tracked_allocation); /* status models original kernel completion, not count-zero authority */
  if (m.fault == READ_LATE_DEVICE) m.late_bad_device = 1;
  return 0;
}
/* Raw heap object final-free event drives the modeled ioctl completion only.
 * C20 separately tests actual kernel owner destructor/complete. This consumer
 * test does not replace those kernel bodies or claim a real kernel join. */
static void raw_final_object_free(void) {
  CHECK(m.tracked_allocation && !m.freed_events); free(m.tracked_allocation);
  m.tracked_allocation = NULL; m.freed_events++;
}
static void create_and_loan(struct tns_owner **slot) {
  reset(slot); CHECK(tns_owner_create(slot) == 0); CHECK(*slot && (*slot)->phase == TNS_HELD);
  CHECK(m.creates == 1 && m.clones == 1 && !m.signals);
  int loan = tns_owner_dup_namespace(*slot); CHECK(loan == LOAN); CHECK(raw_close(loan) == 0);
}
static void released(struct tns_owner *o) {
  CHECK(tns_owner_cut_admission(o) == 0);
  struct tns_lifetime life; CHECK(tns_owner_release_namespace(o, &life) == 0);
  CHECK(life.born && life.release_attempted && life.reference_released && life.net_gone);
  CHECK(m.signals == 1 && m.reaps == 1 && m.releases == 1 && m.closes[BIRTH_NS] == 1);
}
static void retained(struct tns_owner *o) {
  CHECK(*m.slot == o && o->kernel_fd == DEVICE && m.fd_live[DEVICE]);
  CHECK(m.creates == 1 && m.clones == 1 && m.releases <= 1 && m.begin_calls <= 1);
}
static void dispose_fixture(struct tns_owner **slot) {
  /* Explicit old close only frees this constructor-only raw fixture. It is
   * never permission for born OCI cleanup/terminal; new consumer never closes. */
  m.fault = NONE; m.late_bad_device = 0;
  if (m.tracked_allocation) raw_final_object_free();
  CHECK(tns_owner_close(slot) == 0 && !*slot);
  for (int fd = ROOT; fd < MAX_FD; fd++) CHECK(!m.fd_live[fd]);
}
static void successful_path(void) {
  struct tns_owner *o; create_and_loan(&o); released(o);
  CHECK(tns_owner_read_tracked_join(o) < 0 && errno == EINVAL && !m.read_calls);
  unsigned int old_reads = m.life_reads + m.observes;
  CHECK(tns_owner_begin_tracked_join(o) == 0 && m.begin_calls == 1 && m.life_seq < m.begin_seq);
  CHECK(o->tracked_join_before.packet_groups == 1 && o->tracked_join_before.net_gone == 1);
  CHECK(tns_owner_read_tracked_join(o) < 0 && errno == EAGAIN && m.read_calls == 1);
  CHECK(m.life_reads + m.observes == old_reads + 1 && !m.after_begin_old_reads);
  CHECK(tns_owner_begin_tracked_join(o) < 0 && errno == EALREADY && m.begin_calls == 1);
  raw_final_object_free();
  CHECK(tns_owner_read_tracked_join(o) == 0 && m.read_calls == 2);
  CHECK(tns_owner_read_tracked_join(o) == 0 && m.read_calls == 3);
  CHECK(!m.after_begin_old_reads); retained(o); dispose_fixture(&o);
}
static void unknown_begin(void) {
  const enum fault faults[] = {BEGIN_LOST_EFFECT, BEGIN_LOST_NO_EFFECT, BEGIN_POSITIVE, BEGIN_LATE_DEVICE};
  for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
    struct tns_owner *o; create_and_loan(&o); released(o); m.fault = faults[i];
    CHECK(tns_owner_begin_tracked_join(o) < 0 && o->tracked_join_attempted && m.begin_calls == 1);
    retained(o); m.fault = NONE; m.late_bad_device = 0;
    CHECK(tns_owner_begin_tracked_join(o) < 0 && errno == EALREADY && m.begin_calls == 1);
    CHECK(tns_owner_open_admission(o) < 0 && m.creates == 1);
    struct tns_lifetime life;
    CHECK(tns_owner_continue_namespace_release(o, &life) < 0 && errno == EALREADY && m.releases == 1);
    CHECK(tns_owner_create(&o) < 0 && errno == EALREADY && m.creates == 1);
    CHECK(tns_owner_read_tracked_join(o) < 0 && errno == (faults[i] == BEGIN_LOST_NO_EFFECT ? ENODATA : EAGAIN));
    raw_final_object_free();
    if (faults[i] == BEGIN_LOST_NO_EFFECT) CHECK(tns_owner_read_tracked_join(o) < 0 && errno == ENODATA);
    else CHECK(tns_owner_read_tracked_join(o) == 0);
    CHECK(m.begin_calls == 1 && !m.after_begin_old_reads); retained(o); dispose_fixture(&o);
  }
}
static void read_faults(void) {
  const enum fault faults[] = {READ_INTERRUPTED, READ_POSITIVE, READ_UNCLEAN, READ_NO_DATA, READ_LATE_DEVICE};
  for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
    struct tns_owner *o; create_and_loan(&o); released(o);
    CHECK(tns_owner_begin_tracked_join(o) == 0); raw_final_object_free();
    m.fault = faults[i]; unsigned int before = m.read_calls;
    CHECK(tns_owner_read_tracked_join(o) < 0 && m.read_calls == before + 1);
    retained(o); CHECK(m.begin_calls == 1 && !m.after_begin_old_reads);
    m.fault = NONE; m.late_bad_device = 0;
    /* Explicit later call only: no automatic retry in either public function. */
    CHECK(tns_owner_read_tracked_join(o) == 0 && m.read_calls == before + 2);
    dispose_fixture(&o);
  }
}
static void input_guards(void) {
  const enum fault faults[] = {WRONG_CONTROLLER, BAD_DEVICE, MISSING_DEVICE, BAD_COOKIE, BAD_RELEASE, POISON};
  for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
    struct tns_owner *o; create_and_loan(&o); released(o); m.fault = faults[i];
    CHECK(tns_owner_begin_tracked_join(o) < 0 && !o->tracked_join_attempted && !m.begin_calls);
    retained(o); dispose_fixture(&o);
  }
  struct tns_owner *o; create_and_loan(&o);
  CHECK(tns_owner_begin_tracked_join(o) < 0 && !m.begin_calls);
  CHECK(tns_owner_cut_admission(o) == 0); m.fault = CLOSE_UNKNOWN;
  struct tns_lifetime life; CHECK(tns_owner_release_namespace(o, &life) < 0 && errno == EINTR);
  CHECK(o->namespace_close_unknown && o->netfd == -1 && m.closes[BIRTH_NS] == 1);
  m.fault = NONE; CHECK(tns_owner_continue_namespace_release(o, &life) < 0 && errno == EUCLEAN);
  CHECK(m.releases == 1 && o->namespace_close_unknown);
  CHECK(tns_owner_begin_tracked_join(o) < 0 && !m.begin_calls && !o->tracked_join_attempted);
  CHECK(m.closes[BIRTH_NS] == 1); dispose_fixture(&o);
  const enum fault waits[] = {CUSTODIAN_WRONG_PID, CUSTODIAN_TIMEOUT};
  for (size_t i = 0; i < sizeof(waits) / sizeof(waits[0]); i++) {
    create_and_loan(&o); CHECK(tns_owner_cut_admission(o) == 0); m.fault = waits[i];
    CHECK(tns_owner_release_namespace(o, &life) < 0 && o->child == 2000);
    CHECK(tns_owner_begin_tracked_join(o) < 0 && !m.begin_calls);
    retained(o); dispose_fixture(&o);
  }
}
static void read_currentness(void) {
  const enum fault faults[] = {WRONG_CONTROLLER, BAD_DEVICE, MISSING_DEVICE};
  for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
    struct tns_owner *o; create_and_loan(&o); released(o); CHECK(tns_owner_begin_tracked_join(o) == 0);
    m.fault = faults[i]; CHECK(tns_owner_read_tracked_join(o) < 0 && !m.read_calls);
    retained(o); dispose_fixture(&o);
  }
  struct tns_owner *o; create_and_loan(&o); released(o); CHECK(tns_owner_begin_tracked_join(o) == 0);
  o->tracked_join_before.net_cookie++; /* explicit private-memory fault, never positive authority */
  CHECK(tns_owner_read_tracked_join(o) < 0 && errno == ESTALE && !m.read_calls);
  retained(o); dispose_fixture(&o);
}
int main(void) {
  CHECK(sizeof(struct tako_terminal_observation) == 48);
  CHECK(sizeof(struct tako_terminal_lifetime_observation) == 72);
  CHECK(tns_owner_begin_tracked_join(NULL) < 0 && errno == EINVAL);
  CHECK(tns_owner_read_tracked_join(NULL) < 0 && errno == EINVAL);
  successful_path(); unknown_begin(); read_faults(); input_guards(); read_currentness();
  printf("PASS %u raw constructor/owner JOIN consumer checks; native effects0\n", checks);
  return 0;
}
