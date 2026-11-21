/* New optional birth DROP producer raw model. Adapted immutable release-boundary model; old cohort entry never called. */
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
#include <setjmp.h>
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

static int eg_pipe2(int fd[2], int flags);
static ssize_t eg_read(int fd, void *bytes, size_t size);
static ssize_t eg_write(int fd, const void *bytes, size_t size);
static int eg_fcntl(int fd, int command, ...);
static int eg_dup2(int from, int to);
static int eg_dup3(int from, int to, int flags);
static int eg_setns(int fd, int kind);
static pid_t eg_getppid(void);
static int eg_clock(clockid_t kind, struct timespec *out);
static _Noreturn void eg_exit(int code);

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
#define pipe2 eg_pipe2
#define read eg_read
#define write eg_write
#define fcntl eg_fcntl
#define dup2 eg_dup2
#define dup3 eg_dup3
#define setns eg_setns
#define getppid eg_getppid
#define clock_gettime eg_clock
#define _exit eg_exit
#include "../../scripts/native/docker-container-terminal-namespace.c"
#include "../../scripts/native/docker-container-terminal-oci.c"
#undef pipe2
#undef read
#undef write
#undef fcntl
#undef dup2
#undef dup3
#undef setns
#undef getppid
#undef clock_gettime
#undef _exit
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


enum { EGFILE=100, EGNFT, HOSTROOT=110, HOSTUSR, HOSTSBIN };
static struct {
 char artifact[8192], policy[32769], table[65536], sent[3][1024];
 size_t artifact_size, policy_size, table_size, sent_size[3], read_at[3];
 unsigned int pipes, spawns, joins, signals, close_calls[600], reads;
 int no_file, bad_mode, bad_magic, bad_table, fail_write, bad_wait, bad_poll, timeout, close_error;
 int cancel_read, child_mode, ranges, entered, null_opened, exec_stage;
} eg;
static jmp_buf child_exit;
static const char good_table[] =
 "{\"nftables\":[{\"metainfo\":{\"version\":\"1.1.1\",\"release_name\":\"test\",\"json_schema_version\":1}},"
 "{\"table\":{\"family\":\"inet\",\"name\":\"tako_terminal_policy\",\"handle\":1,\"flags\":[]}},"
 "{\"chain\":{\"family\":\"inet\",\"table\":\"tako_terminal_policy\",\"name\":\"input\",\"type\":\"filter\",\"hook\":\"input\",\"prio\":-310,\"policy\":\"drop\"}},"
 "{\"chain\":{\"family\":\"inet\",\"table\":\"tako_terminal_policy\",\"name\":\"output\",\"type\":\"filter\",\"hook\":\"output\",\"prio\":-310,\"policy\":\"drop\"}},"
 "{\"chain\":{\"family\":\"inet\",\"table\":\"tako_terminal_policy\",\"name\":\"forward\",\"type\":\"filter\",\"hook\":\"forward\",\"prio\":-310,\"policy\":\"drop\"}}]}";

static void metadata(int fd, struct stat *out) {
  memset(out, 0, sizeof(*out)); out->st_uid = 0; out->st_nlink = 1;
  out->st_dev = 1; out->st_ino = (ino_t)(1000 + fd); out->st_mode = S_IFDIR | 0700;
  out->st_mtim.tv_sec = out->st_ctim.tv_sec = 1;
  if (fd == ROOTFS) out->st_mode = S_IFDIR | 0755;
  if (fd == EGFILE) { out->st_mode=S_IFREG | (eg.bad_mode ? 0666 : 0600); out->st_size=(off_t)eg.policy_size; }
  if (fd == EGNFT) { out->st_mode=S_IFREG | 0755; out->st_size=4; }
  if (eg.child_mode && fd == 4) { out->st_dev=5; out->st_ino=77; }
  if (eg.child_mode && fd == 2) { out->st_mode=S_IFCHR | 0600; out->st_rdev=makedev(1,3); }
  if (fd == RECEIPT || fd == CONFIG) {
    out->st_mode = S_IFREG | 0600; out->st_size = fd == RECEIPT ? (eg.artifact_size ? (off_t)eg.artifact_size : 7) : 4;
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
  if (eg.child_mode && option == PR_SET_PDEATHSIG) return 0;
  CHECK(option == PR_GET_CHILD_SUBREAPER);
  va_list ap; va_start(ap, option); int *out = va_arg(ap, int *); va_end(ap); *out = 1; return 0;
}
static int raw_sigaction(int number, const struct sigaction *in, struct sigaction *out) {
  CHECK((number == SIGCHLD || number == SIGPIPE) && !in && out);
  memset(out, 0, sizeof(*out)); out->sa_handler = number == SIGPIPE ? SIG_IGN : SIG_DFL; return 0;
}
static int raw_open(const char *path, int flags, ...) {
  CHECK((flags & O_CLOEXEC) != 0);
  if (!strcmp(path, "/")) return HOSTROOT;
  if (eg.child_mode && !strcmp(path, "/dev/null")) { CHECK(eg.entered); eg.null_opened=1; return 2; }
  if (!strcmp(path, "/proc/self/ns/pid")) return SELF_PIDNS;
  CHECK(!strcmp(path, "/proc/self/ns/pid_for_children")); return CHILDREN_PIDNS;
}
static int raw_openat(int dir, const char *path, int flags, ...) {
  CHECK((flags & O_CLOEXEC) != 0);
  if (dir == HOSTROOT) { CHECK(!strcmp(path,"usr")); return HOSTUSR; }
  if (dir == HOSTUSR) { CHECK(!strcmp(path,"sbin")); return HOSTSBIN; }
  if (dir == HOSTSBIN) { CHECK(!strcmp(path,"nft")); return EGNFT; }
  if (dir == ROOT && !strcmp(path, OCI_EGRESS_FILE)) { if (eg.no_file) {errno=ENOENT;return -1;} return EGFILE; }
  if (dir == BUNDLE) { CHECK(!strcmp(path, "config.json")); return CONFIG; }
  if (dir == CUSTODIAN_PROC) { CHECK(!strcmp(path, "ns/net")); return NETNS; }
  CHECK(dir == INIT_PROC);
  if (!strcmp(path, "ns/pid")) return FRESH_PIDNS;
  CHECK(!strcmp(path, "ns/net")); return NETNS;
}
static int raw_fstat(int fd, struct stat *out) {
  CHECK((fd >= ROOT && fd <= CONTROL) || fd==EGFILE || fd==EGNFT || (fd>=HOSTROOT && fd<=HOSTSBIN) || (eg.child_mode && (fd==2 || fd==4))); metadata(fd, out); return 0;
}
static int raw_fstatat(int dir, const char *path, struct stat *out, int flags) {
  CHECK(dir == ROOT && flags == AT_SYMLINK_NOFOLLOW);
  int fd = !strcmp(path, OCI_EGRESS_FILE) ? EGFILE : !strcmp(path, "rootfs") ? ROOTFS : !strcmp(path, "bundle") ? BUNDLE :
           !strcmp(path, "runtime-state") ? STATE : RECEIPT;
  metadata(fd, out); return 0;
}
static int raw_fstatfs(int fd, struct statfs *out) {
  CHECK((eg.child_mode && fd==4) || fd == LOAN || fd == NETNS || fd == BIRTH_NS ||
        (fd >= PARENT_PIDNS && fd <= PARENT_OF_INIT));
  memset(out, 0, sizeof(*out)); out->f_type = (long)NSFS_MAGIC; return 0;
}
static int raw_close(int fd) {
  if (fd>=100 || (eg.child_mode && fd==4)) {
    CHECK(fd>=0 && fd<600); eg.close_calls[fd]++;
    if (eg.close_error && fd==201) { CHECK(eg.close_calls[fd]==1); errno=EINTR; return -1; }
    return 0;
  }
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
  if (number == SYS_clone3) {
    va_list ap; va_start(ap,number); struct clone_args *args=va_arg(ap,struct clone_args*);
    CHECK(va_arg(ap,size_t)==sizeof(*args)); va_end(ap);
    CHECK(args->flags==(CLONE_PIDFD | CLONE_CLEAR_SIGHAND) && args->exit_signal==SIGCHLD);
    CHECK(eg.spawns<3); *(int *)(uintptr_t)args->pidfd=310+(int)eg.spawns;
    return 4000+(long)eg.spawns++;
  }
  if (eg.child_mode && number==SYS_close_range) {
    va_list ap; va_start(ap,number); unsigned int first=va_arg(ap,unsigned int),last=va_arg(ap,unsigned int);
    CHECK(va_arg(ap,unsigned int)==0); va_end(ap);
    CHECK(!eg.entered && ((first==2 && last==2) || (first==5 && last==UINT_MAX)));
    eg.ranges |= first==2 ? 1 : 2; return 0;
  }
  if (eg.child_mode && number==SYS_execveat) {
    va_list ap; va_start(ap,number); CHECK(va_arg(ap,int)==3); CHECK(!strcmp(va_arg(ap,char*),""));
    char *const *args=va_arg(ap,char*const*); char *const *env=va_arg(ap,char*const*);
    CHECK(va_arg(ap,int)==AT_EMPTY_PATH); va_end(ap); CHECK(eg.ranges==3 && eg.entered && eg.null_opened);
    CHECK(!strcmp(args[0],"nft") && !strcmp(env[0],"PATH=/usr/sbin:/usr/bin:/sbin:/bin") && !env[1]);
    if (eg.exec_stage==0) CHECK(!strcmp(args[1],"--check") && !strcmp(args[2],"-f") && !strcmp(args[3],"-") && !args[4]);
    if (eg.exec_stage==1) CHECK(!strcmp(args[1],"-f") && !strcmp(args[2],"-") && !args[3]);
    if (eg.exec_stage==2) CHECK(!strcmp(args[1],"-j") && !strcmp(args[2],"list") && !strcmp(args[3],"table") && !strcmp(args[4],"inet") && !strcmp(args[5],OCI_EGRESS_TABLE) && !args[6]);
    longjmp(child_exit,1);
  }
  if (number==SYS_pidfd_send_signal) {
    va_list ap; va_start(ap,number); int fd=va_arg(ap,int); va_end(ap);
    if(fd>=310 && fd<313) { eg.signals++; return 0; }
  }
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
  CHECK(count == 1);
  if (p->fd>=200 && p->fd<230) { CHECK(timeout>0); p->revents=p->events; return 1; }
  if (p->fd>=310 && p->fd<313) { if(eg.timeout)return 0; p->revents=eg.bad_poll ? POLLERR : POLLIN;return 1; }
  CHECK(p->events == POLLIN);
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
  if(id>=310 && id<313) {
    CHECK(flags==(WEXITED | WNOHANG)); if(eg.bad_wait){errno=ECHILD;return -1;}
    out->si_pid=4000+(int)id-310;out->si_code=CLD_EXITED;out->si_status=0;eg.joins++;return 0;
  }
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
    va_end(ap); return fd == 4 || fd == LOAN || fd == NETNS || fd == BIRTH_NS ? CLONE_NEWNET : CLONE_NEWPID;
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
  CHECK(offset>=0);
  if(fd==EGFILE || (fd==RECEIPT && eg.artifact_size)) {
    const char *data=fd==EGFILE ? eg.policy : eg.artifact; size_t size=fd==EGFILE ? eg.policy_size : eg.artifact_size;
    if((size_t)offset>=size)return 0;
    size_t n=size-(size_t)offset;if(n>count)n=count;memcpy(out,data+(size_t)offset,n);return (ssize_t)n;
  }
  if(fd==EGNFT) { CHECK(offset==0 && count==4);memcpy(out,eg.bad_magic ? "xxxx" : "\177ELF",4);return 4; }
  CHECK(fd == RECEIPT); if (offset >= 7) return 0;
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
int egress_previous_release_main_never_run(void);
int egress_previous_release_main_never_run(void) {
  release_cases();
  printf("actual original init-reap/namespace-release/lifetime raw model: %lu checks\n", checks);
  return 0;
}

static int eg_pipe2(int fd[2], int flags) {
  CHECK(flags==(O_CLOEXEC | O_NONBLOCK)); CHECK(eg.pipes<6);
  fd[0]=200+(int)(eg.pipes/2)*10+(eg.pipes%2 ? 2 : 0);fd[1]=fd[0]+1;eg.pipes++;return 0;
}
static ssize_t eg_write(int fd,const void *bytes,size_t size) {
  CHECK(fd>=201 && fd<=221 && (fd-201)%10==0); size_t stage=(size_t)(fd-201)/10;
  CHECK(stage<2 && size>0);
  if(eg.fail_write){errno=EPIPE;return -1;}
  size_t n=size>17 ? 17 : size; CHECK(n<sizeof(eg.sent[stage])-eg.sent_size[stage]);
  memcpy(eg.sent[stage]+eg.sent_size[stage],bytes,n);eg.sent_size[stage]+=n;return (ssize_t)n;
}
static ssize_t eg_read(int fd,void *bytes,size_t size) {
  CHECK(fd>=202 && fd<=222 && (fd-202)%10==0);size_t stage=(size_t)(fd-202)/10;eg.reads++;
  if(stage<2)return 0;
  size_t n=eg.table_size-eg.read_at[stage];if(n>size)n=size;if(n>31)n=31;
  memcpy(bytes,eg.table+eg.read_at[stage],n);eg.read_at[stage]+=n;
  if(!n && eg.cancel_read)tns_oci_note_cancel();
  return (ssize_t)n;
}
static int eg_fcntl(int fd,int command,...) {
  CHECK(eg.child_mode);va_list ap;va_start(ap,command);
  if(command==F_DUPFD_CLOEXEC){CHECK(va_arg(ap,int)==10);va_end(ap);return 500+fd;}
  if(command==F_GETFL){CHECK(fd>=0 && fd<3);va_end(ap);return O_NONBLOCK;}
  CHECK((command==F_SETFL || command==F_SETFD) && va_arg(ap,int)==0);va_end(ap);return 0;
}
static int eg_dup2(int from,int to){CHECK(eg.child_mode && from>=500 && (to==0 || to==1));return to;}
static int eg_dup3(int from,int to,int flags){CHECK(eg.child_mode && from>=500 && (to==3 || to==4) && flags==O_CLOEXEC);return to;}
static int eg_setns(int fd,int kind){CHECK(eg.child_mode && fd==4 && kind==CLONE_NEWNET && eg.ranges==3 && !eg.entered);eg.entered=1;return 0;}
static pid_t eg_getppid(void){CHECK(eg.child_mode);return 1000;}
static int eg_clock(clockid_t kind,struct timespec *out){CHECK(kind==CLOCK_MONOTONIC);*out=(struct timespec){.tv_sec=1};return 0;}
static _Noreturn void eg_exit(int code){CHECK(eg.child_mode);longjmp(child_exit,code);}

static void initialize_egress(struct tns_oci_owner *o,struct tns_owner *b) {
  memset(&eg,0,sizeof(eg));initialize(o,b);
  for(size_t i=0;i<3;i++)o->egress_pidfd[i]=o->egress_in[i]=o->egress_out[i]=-1;
  o->egress_file=o->egress_binary=-1;
  const char *digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  struct tns_oci_options options={.claim_id=o->id,.installation_id="installation",.resource_uid="resource",.incarnation_id="incarnation",.generation=9,.revision="revision",.source_digest=digest,.manifest_digest=digest,.config_digest=digest,.archive_digest=digest};
  struct tns_oci_json artifact={eg.artifact,sizeof(eg.artifact),0,0};tns_oci_receipt(&options,&artifact);CHECK(!artifact.failed);
  eg.artifact_size=artifact.used;memcpy(o->receipt_bytes,eg.artifact,artifact.used);o->receipt_size=artifact.used;
  int n=snprintf(eg.policy,sizeof(eg.policy),"{\"kind\":\"linux-oci-owned-egress@1\",\"artifact\":%s,\"policy\":{\"tenantRef\":\"tenant-😀\",\"generation\":9,\"policyDigest\":\"%s\",\"outboundInternet\":true},\"limits\":{\"maxConnections\":65535,\"packetLimitBytes\":9007199254740991}}",eg.artifact,digest);
  CHECK(n>0 && (size_t)n<sizeof(eg.policy));eg.policy_size=(size_t)n;
  strcpy(eg.table,good_table);eg.table_size=strlen(eg.table);
}
static void change_text(char *text,size_t *size,const char *from,const char *to){
  char *at=strstr(text,from);CHECK(at);size_t before=(size_t)(at-text),a=strlen(from),b=strlen(to);
  CHECK(*size-a+b<32768);memmove(at+b,at+a,*size-before-a+1);memcpy(at,to,b);*size=*size-a+b;
}
static void codec_cases(void){
  struct tns_oci_owner o;struct tns_owner b;initialize_egress(&o,&b);
  CHECK(oci_egress_policy(eg.policy,eg.policy_size,eg.artifact,eg.artifact_size,9)==0);
  CHECK(oci_egress_readback(eg.table,eg.table_size)==0);
  for(size_t n=0;n<eg.policy_size;n++)CHECK(oci_egress_policy(eg.policy,n,eg.artifact,eg.artifact_size,9)<0);
  for(size_t n=0;n<eg.table_size;n++)CHECK(oci_egress_readback(eg.table,n)<0);
  const char *from[]={"\"generation\":9,\"policyDigest\"","\"maxConnections\":65535","\"packetLimitBytes\":9007199254740991","\"outboundInternet\":true","\"tenantRef\":\"tenant-😀\"","\"limits\":{","\"artifact\":"};
  const char *to[]={"\"generation\":8,\"policyDigest\"","\"maxConnections\":65536","\"packetLimitBytes\":9007199254740992","\"outboundInternet\":1","\"tenantRef\":\"\"","\"unknown\":0,\"limits\":{","\"artifactX\":"};
  for(size_t i=0;i<7;i++){initialize_egress(&o,&b);change_text(eg.policy,&eg.policy_size,from[i],to[i]);CHECK(oci_egress_policy(eg.policy,eg.policy_size,eg.artifact,eg.artifact_size,9)<0);}
  const char *badfrom[]={"\"policy\":\"drop\"","\"prio\":-310","\"hook\":\"input\"","\"flags\":[]","\"family\":\"inet\"","\"handle\":1","\"name\":\"output\""};
  const char *badto[]={"\"policy\":\"accept\"","\"prio\":-309","\"hook\":\"output\"","\"flags\":[\"dormant\"]","\"family\":\"ip\"","\"handle\":1,\"handle\":2","\"name\":\"input\""};
  for(size_t i=0;i<7;i++){initialize_egress(&o,&b);change_text(eg.table,&eg.table_size,badfrom[i],badto[i]);CHECK(oci_egress_readback(eg.table,eg.table_size)<0);}
  initialize_egress(&o,&b);change_text(eg.policy,&eg.policy_size,"65535","0");change_text(eg.policy,&eg.policy_size,"9007199254740991","0");change_text(eg.policy,&eg.policy_size,":true",":false");CHECK(oci_egress_policy(eg.policy,eg.policy_size,eg.artifact,eg.artifact_size,9)==0);
}
static void actual_guard_cases(void){
  struct tns_oci_owner o;struct tns_owner b;
  initialize_egress(&o,&b);eg.no_file=1;
  CHECK(oci_egress_select(&o,9)==0 && !o.egress_selected);
  CHECK(oci_egress_guard_install(&o)==0 && !eg.spawns && !o.egress_guard_attempt);
  initialize_egress(&o,&b);CHECK(oci_egress_select(&o,9)==0 && o.egress_selected);
  CHECK(oci_egress_guard_install(&o)==0 && o.egress_guard_verified && eg.spawns==3 && eg.joins==3);
  CHECK(!strcmp(eg.sent[0],oci_egress_script) && !strcmp(eg.sent[1],oci_egress_script) && !eg.sent_size[2]);
  CHECK(!strstr(oci_egress_script,"accept") && strstr(oci_egress_script,"forward") && !model.kernel_releases);
  CHECK(oci_egress_guard_install(&o)<0 && errno==EALREADY && eg.spawns==3);
  CHECK(oci_egress_stop(&o)==0 && !eg.signals);retained(&o,&b);
  for(int fault=0;fault<5;fault++){
    initialize_egress(&o,&b);CHECK(oci_egress_select(&o,9)==0);
    if(fault==0)change_text(eg.table,&eg.table_size,"\"policy\":\"drop\"","\"policy\":\"accept\"");
    if(fault==1)eg.fail_write=1;
    if(fault==2)eg.bad_wait=1;
    if(fault==3)eg.cancel_read=1;
    if(fault==4)eg.close_error=1;
    CHECK(oci_egress_guard_install(&o)<0 && !o.egress_guard_verified && o.egress_guard_attempt);
    unsigned int spawns=eg.spawns;CHECK(oci_egress_guard_install(&o)<0 && errno==EALREADY && eg.spawns==spawns);
    int result=oci_egress_stop(&o);if(fault==2)CHECK(result<0 && eg.signals==1);else CHECK(result==0);
    unsigned int signals=eg.signals;eg.bad_wait=0;CHECK(oci_egress_stop(&o)==0 && eg.signals==signals && eg.spawns==spawns);
    if(fault==4){CHECK(o.egress_close_unknown && eg.close_calls[201]==1);struct tns_oci_owner *same=&o;CHECK(tns_oci_release_uncreated(&same)<0 && same==&o && !model.kernel_closes);}
    CHECK(!model.kernel_releases && b.kernel_fd==KERNEL_DEVICE);
  }
  initialize_egress(&o,&b);eg.bad_mode=1;CHECK(oci_egress_select(&o,9)<0 && !eg.spawns);
  initialize_egress(&o,&b);eg.bad_magic=1;CHECK(oci_egress_select(&o,9)<0 && !eg.spawns);
  initialize_egress(&o,&b);CHECK(oci_egress_select(&o,9)==0);eg.policy[0]='[';CHECK(oci_egress_guard_install(&o)<0 && !eg.spawns && !o.egress_guard_verified);
}
static void actual_child_cases(void){
  for(volatile int stage=0;stage<3;stage++){
    struct tns_oci_owner o;struct tns_owner b;initialize_egress(&o,&b);CHECK(oci_egress_select(&o,9)==0);
    eg.child_mode=1;eg.exec_stage=stage;
    int outcome=setjmp(child_exit);
    if(!outcome)oci_egress_child(&o,(size_t)stage,200,203);
    CHECK(outcome==1 && eg.entered && eg.ranges==3 && eg.null_opened);
  }
}
static void malformed_poll_case(void){
  struct tns_oci_owner o;struct tns_owner b;initialize_egress(&o,&b);
  CHECK(oci_egress_select(&o,9)==0);o.egress_guard_attempt=1;
  o.egress_pid[0]=4000;o.egress_pidfd[0]=310;eg.spawns=1;eg.bad_poll=1;errno=0;
  CHECK(oci_egress_stop(&o)<0 && errno==EPROTO);
  CHECK(!o.egress_joined[0] && eg.signals==1 && !eg.joins && !model.kernel_releases);
  errno=0;
  CHECK(oci_egress_close(&o)<0 && errno==EBUSY && !eg.close_calls[EGFILE] && eg.signals==1);
}
static void original_cleanup_case(void){
  struct tns_oci_owner o;struct tns_owner b;initialize_egress(&o,&b);
  CHECK(oci_egress_select(&o,9)==0);o.egress_guard_attempt=1;
  o.egress_pid[0]=4000;o.egress_pidfd[0]=310;model.fault=WRONG_CONTROLLER;
  CHECK(oci_egress_stop(&o)<0 && errno==EPERM && !eg.signals && !eg.joins);
  CHECK(oci_egress_close(&o)<0 && errno==EPERM && !eg.close_calls[EGFILE]);
}
int main(int argc,char **argv){
  if(argc==2 && !strcmp(argv[1],"--malformed-poll")){malformed_poll_case();return 0;}
  CHECK(argc==1);codec_cases();actual_guard_cases();actual_child_cases();malformed_poll_case();original_cleanup_case();
  printf("new actual original-owner birth DROP/file/child raw model: %lu checks\n",checks);return 0;
}
