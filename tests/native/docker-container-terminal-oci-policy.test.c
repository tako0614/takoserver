/* New full-policy boundary regression. Only pure raw syscall models execute; actual namespace + OCI + uplink bodies are included. No old cohort is invoked. */
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

#include <sys/socket.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <linux/if_link.h>
static mode_t policy_umask(mode_t mask);
#define umask policy_umask
static struct oci_policy_owner *policy_subject;
static void policy_raw_readback(void);
static struct {
 char file[16385],readback[1048576],sent[2][524288];size_t file_size,readback_size,read_at,sent_size[2];
 unsigned int active,child,spawns,joins[3],signals[3],pipes,neighbors[2][2];
 int fault,partial,applied,late_inventory;
} pol;
static int lock_busy, lock_taken;
static int up_socket(int family,int type,int protocol);
static int up_socketpair(int family,int type,int protocol,int pair[2]);
static int up_setsockopt(int fd,int level,int option,const void *value,socklen_t size);
static int up_getsockopt(int fd,int level,int option,void *value,socklen_t *size);
static int up_getsockname(int fd,struct sockaddr *address,socklen_t *size);
static int up_bind(int fd,const struct sockaddr *address,socklen_t size);
static ssize_t up_sendmsg(int fd,const struct msghdr *message,int flags);
static ssize_t up_recvmsg(int fd,struct msghdr *message,int flags);
static struct {
 char file[32769]; size_t file_size;
 int active, child, wrong_host, no_file, malformed, bad_ack, drop_ack, read_fault, close_fault, nack_at, bad_lock, unlock_fault, conflict, cookie_fault;
 unsigned int mutations, creates, deletes, closes[600], joins, signals, sockets, dumps, steps;
 int created, removed, assigned[2][2], up[2], routes[2];
 struct nlmsghdr request; unsigned char request_bytes[4096];
} up;
#define socket up_socket
#define socketpair up_socketpair
#define setsockopt up_setsockopt
#define getsockopt up_getsockopt
#define getsockname up_getsockname
#define bind up_bind
#define sendmsg up_sendmsg
#define recvmsg up_recvmsg
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

#undef umask
#undef socket
#undef socketpair
#undef setsockopt
#undef getsockopt
#undef getsockname
#undef bind
#undef sendmsg
#undef recvmsg
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
  if(fd==130){out->st_mode=S_IFREG|0600;out->st_size=(off_t)pol.file_size;}
  if(fd==122){out->st_mode=S_IFREG|(up.bad_lock==1?0666:0600);if(up.bad_lock==2)out->st_nlink=2;}
  if(fd==123){out->st_mode=S_IFDIR|0755;}
  if(fd==120){out->st_mode=S_IFREG|0600;out->st_size=(off_t)up.file_size;}
  if(fd==121){out->st_dev=5;out->st_ino=up.wrong_host ? 67 : 66;}
  if(up.child && fd==3){out->st_dev=5;out->st_ino=77;}
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
  if (!strcmp(path,"/proc/self/ns/net")) return 121;
  if(!strcmp(path,"/run"))return 123;
  if (!strcmp(path, "/")) return HOSTROOT;
  if (eg.child_mode && !strcmp(path, "/dev/null")) { CHECK(eg.entered); eg.null_opened=1; return 2; }
  if (!strcmp(path, "/proc/self/ns/pid")) return SELF_PIDNS;
  CHECK(!strcmp(path, "/proc/self/ns/pid_for_children")); return CHILDREN_PIDNS;
}
static int raw_openat(int dir, const char *path, int flags, ...) {
  CHECK((flags & O_CLOEXEC) != 0);
  if(dir==0 && !strcmp(path,"self/ns/net"))return 121;
  if(dir==HOSTROOT && !strcmp(path,"run"))return 123;
  if(dir==123 && !strcmp(path,"tako-terminal-uplink.lock"))return 122;
  if(dir==ROOT && !strcmp(path,OCI_POLICY_FILE))return 130;
  if(dir==ROOT && !strcmp(path,OCI_UPLINK_FILE)){if(up.no_file){errno=ENOENT;return -1;}return 120;}
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
  CHECK((fd >= ROOT && fd <= CONTROL) || fd==EGFILE || fd==EGNFT || fd==130 || (fd>=120 && fd<=123) || (up.child && fd==3) || (fd>=HOSTROOT && fd<=HOSTSBIN) || (eg.child_mode && (fd==2 || fd==4))); metadata(fd, out); return 0;
}
static int raw_fstatat(int dir, const char *path, struct stat *out, int flags) {
  CHECK((dir == ROOT || dir==123) && flags == AT_SYMLINK_NOFOLLOW);
  int fd = !strcmp(path,OCI_POLICY_FILE) ? 130 : !strcmp(path,"tako-terminal-uplink.lock") ? 122 : !strcmp(path, OCI_UPLINK_FILE) ? 120 : !strcmp(path, OCI_EGRESS_FILE) ? EGFILE : !strcmp(path, "rootfs") ? ROOTFS : !strcmp(path, "bundle") ? BUNDLE :
           !strcmp(path, "runtime-state") ? STATE : RECEIPT;
  metadata(fd, out);if(fd==122 && up.bad_lock==3)out->st_ino++;return 0;
}
static int raw_fstatfs(int fd, struct statfs *out) {
  CHECK(fd==121 || (up.child && fd==3) || (eg.child_mode && fd==4) || fd == LOAN || fd == NETNS || fd == BIRTH_NS ||
        (fd >= PARENT_PIDNS && fd <= PARENT_OF_INIT));
  memset(out, 0, sizeof(*out)); out->f_type = (long)NSFS_MAGIC; return 0;
}
static int raw_close(int fd) {
  if(fd==130 || (fd>=430 && fd<=432) || (fd>=450 && fd<=473)){CHECK(fd>=0 && fd<600);up.closes[fd]++;if(pol.active && fd==459)pol.applied=1;return 0;}
  if((fd>=120 && fd<=123) || (fd>=400 && fd<=410) || (up.child && (fd==3 || fd==4))){
    CHECK(fd>=0 && fd<600);up.closes[fd]++;
    if(up.close_fault && (fd==406 || (up.close_fault==2 && fd==122))){errno=EINTR;return -1;}return 0;
  }
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
  if(pol.active && number==SYS_clone3){va_list ap;va_start(ap,number);struct clone_args *a=va_arg(ap,struct clone_args*);CHECK(va_arg(ap,size_t)==sizeof(*a));va_end(ap);CHECK(pol.spawns<3 && a->flags==(CLONE_PIDFD|CLONE_CLEAR_SIGHAND) && a->exit_signal==SIGCHLD && lock_taken);*(int *)(uintptr_t)a->pidfd=430+(int)pol.spawns;return 6000+(long)pol.spawns++;}
  if(pol.active && number==SYS_pidfd_send_signal){va_list ap;va_start(ap,number);int fd=va_arg(ap,int);if(fd>=430 && fd<=432){CHECK(va_arg(ap,int)==SIGKILL && pol.signals[fd-430]==0);pol.signals[fd-430]++;va_end(ap);return 0;}va_end(ap);}
  if(pol.child && number==SYS_execveat){va_list ap;va_start(ap,number);CHECK(va_arg(ap,int)==3);CHECK(!strcmp(va_arg(ap,char*),""));char *const *args=va_arg(ap,char*const*),*const *env=va_arg(ap,char*const*);CHECK(va_arg(ap,int)==AT_EMPTY_PATH);va_end(ap);CHECK(eg.ranges==3 && eg.entered && lock_taken && !strcmp(env[0],"PATH=/usr/sbin:/usr/bin:/sbin:/bin") && !env[1]);CHECK(!strcmp(args[0],"nft") && !strcmp(args[1],"-j") && !strcmp(args[2],"list") && !strcmp(args[3],"table") && !strcmp(args[4],"inet") && !strcmp(args[5],OCI_POLICY_TABLE) && !args[6]);longjmp(child_exit,1);}
  if(up.active && number==SYS_clone3){
    va_list ap;va_start(ap,number);struct clone_args *a=va_arg(ap,struct clone_args*);CHECK(va_arg(ap,size_t)==sizeof(*a));va_end(ap);
    CHECK(a->flags==(CLONE_PIDFD|CLONE_CLEAR_SIGHAND) && a->exit_signal==SIGCHLD && !lock_taken);*(int *)(uintptr_t)a->pidfd=404;return 5000;
  }
  if(up.active && number==SYS_pidfd_send_signal){va_list ap;va_start(ap,number);int fd=va_arg(ap,int);if(fd==404){CHECK(va_arg(ap,int)==SIGKILL);va_end(ap);up.signals++;return 0;}va_end(ap);}
  if(up.child && number==SYS_close_range){va_list ap;va_start(ap,number);unsigned int a=va_arg(ap,unsigned int),b=va_arg(ap,unsigned int);CHECK(va_arg(ap,unsigned int)==0);va_end(ap);CHECK((a==0 && b==2)||(a==5 && b==UINT_MAX));eg.ranges|=a==0?1:2;return 0;}
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
  CHECK(model.oci->init_joined && model.birth->kill_attempted);
  CHECK((model.birth->namespace_release_attempted && model.loan_closed && !model.birth_closed) || (!model.oci->uplink && !model.oci->command_pid));
  model.custodian_signals++;
  if (model.fault == CUSTODIAN_SIGNAL) { errno = EPERM; return -1; }
  model.custodian_exited = 1; return 0;
}
static int raw_poll(struct pollfd *p, nfds_t count, int timeout) {
  CHECK(count == 1);
  if((p->fd>=430 && p->fd<=432)||(p->fd>=450 && p->fd<=473)){CHECK(timeout>0);p->revents=p->events;return 1;}
  if(p->fd>=400 && p->fd<=410){CHECK(timeout>0);if(up.drop_ack && up.mutations && p->fd!=400 && p->fd!=404)return 0;p->revents=POLLIN;return 1;}
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
  if(id>=430 && id<=432){CHECK(flags==(WEXITED|WNOHANG));unsigned int i=(unsigned int)id-430;CHECK(!pol.joins[i]);pol.joins[i]++;out->si_pid=6000+(int)i;out->si_code=CLD_EXITED;out->si_status=0;return 0;}
  if(id==404){CHECK(flags==(WEXITED|WNOHANG));out->si_pid=5000;out->si_code=CLD_EXITED;out->si_status=0;up.joins++;return 0;}
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
  /* GET-only Host observation data for the original socket; no SET model. */
  if (request == SIOCGIFINDEX || request == SIOCGIFHWADDR || request == SIOCETHTOOL) {
    struct oci_uplink_owner *observed = model.oci ? model.oci->uplink : NULL;
    CHECK(fd == 407 && observed);
    struct ifreq *in = va_arg(ap, struct ifreq *); va_end(ap);
    CHECK(!memcmp(in->ifr_name, observed->expected.name, sizeof(in->ifr_name)));
    if (request == SIOCGIFINDEX) { in->ifr_ifindex = (int)observed->expected.index; return 0; }
    if (request == SIOCGIFHWADDR) {
      in->ifr_hwaddr.sa_family = ARPHRD_ETHER;
      memcpy(in->ifr_hwaddr.sa_data, observed->expected.mac, 6); return 0;
    }
    CHECK(in->ifr_data); uint32_t cmd; memcpy(&cmd, in->ifr_data, sizeof(cmd));
    if (cmd == ETHTOOL_GDRVINFO) {
      struct ethtool_drvinfo *out = (void *)in->ifr_data;
      memset(out, 0, sizeof(*out)); out->cmd = ETHTOOL_GDRVINFO;
      strcpy(out->driver, "raw-original-driver"); strcpy(out->version, "6.12"); return 0;
    }
    CHECK(cmd == ETHTOOL_GFEATURES);
    struct oci_uplink_features *out = (void *)in->ifr_data;
    CHECK(out->size == OCI_UPLINK_FEATURE_WORDS);
    memset(out, 0, sizeof(*out)); out->cmd = ETHTOOL_GFEATURES; out->size = 2;
    out->blocks[0].available = out->blocks[0].requested = out->blocks[0].active = 1; return 0;
  }
  if (request == NS_GET_NSTYPE) {
    va_end(ap); return fd == 121 || (up.child && fd==3) || fd == 4 || fd == LOAN || fd == NETNS || fd == BIRTH_NS ? CLONE_NEWNET : CLONE_NEWPID;
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
  if(fd==130){if((size_t)offset>=pol.file_size)return 0;size_t n=pol.file_size-(size_t)offset;if(n>count)n=count;memcpy(out,pol.file+(size_t)offset,n);return (ssize_t)n;}
  if(fd==120){if((size_t)offset>=up.file_size)return 0;size_t n=up.file_size-(size_t)offset;if(n>count)n=count;memcpy(out,up.file+(size_t)offset,n);return (ssize_t)n;}
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
static int eg_pipe2(int fd[2], int flags) {
  if(pol.active){CHECK(flags==(O_CLOEXEC|O_NONBLOCK) && pol.pipes<6);unsigned int stage=pol.pipes/2,side=pol.pipes%2;fd[0]=450+(int)(stage*8+side*2);fd[1]=fd[0]+1;pol.pipes++;return 0;}
  CHECK(flags==(O_CLOEXEC | O_NONBLOCK)); CHECK(eg.pipes<6);
  fd[0]=200+(int)(eg.pipes/2)*10+(eg.pipes%2 ? 2 : 0);fd[1]=fd[0]+1;eg.pipes++;return 0;
}
static ssize_t eg_write(int fd,const void *bytes,size_t size) {
  if(pol.active && (fd==451 || fd==459)){unsigned int i=fd==451?0u:1u;size_t n=size;if(pol.partial && n>137)n=137;CHECK(n<=sizeof(pol.sent[i])-pol.sent_size[i]);memcpy(pol.sent[i]+pol.sent_size[i],bytes,n);pol.sent_size[i]+=n;return (ssize_t)n;}
  CHECK(fd>=201 && fd<=221 && (fd-201)%10==0); size_t stage=(size_t)(fd-201)/10;
  CHECK(stage<2 && size>0);
  if(eg.fail_write){errno=EPIPE;return -1;}
  size_t n=size>17 ? 17 : size; CHECK(n<sizeof(eg.sent[stage])-eg.sent_size[stage]);
  memcpy(eg.sent[stage]+eg.sent_size[stage],bytes,n);eg.sent_size[stage]+=n;return (ssize_t)n;
}
static ssize_t eg_read(int fd,void *bytes,size_t size) {
  if(pol.active && (fd==452 || fd==460 || fd==468)){if(pol.fault==1 && fd==460){errno=EINTR;return -1;}if(fd!=468)return 0;if(!pol.readback_size)policy_raw_readback();if(pol.read_at==pol.readback_size)return 0;size_t n=pol.readback_size-pol.read_at;if(n>size)n=size;if(n>4093)n=4093;memcpy(bytes,pol.readback+pol.read_at,n);pol.read_at+=n;return (ssize_t)n;}
  CHECK(fd>=202 && fd<=222 && (fd-202)%10==0);size_t stage=(size_t)(fd-202)/10;eg.reads++;
  if(stage<2)return 0;
  size_t n=eg.table_size-eg.read_at[stage];if(n>size)n=size;if(n>31)n=31;
  memcpy(bytes,eg.table+eg.read_at[stage],n);eg.read_at[stage]+=n;
  if(!n && eg.cancel_read)tns_oci_note_cancel();
  return (ssize_t)n;
}
static int eg_fcntl(int fd,int command,...) {
  if(fd==122 && command==F_OFD_SETLK){va_list a;va_start(a,command);struct flock *l=va_arg(a,struct flock*);va_end(a);CHECK(l->l_whence==SEEK_SET && !l->l_start && !l->l_len);if(l->l_type==F_WRLCK){if(lock_busy){errno=EAGAIN;return -1;}CHECK(!lock_taken);lock_taken=1;}else{CHECK(l->l_type==F_UNLCK && lock_taken);if(up.unlock_fault){errno=EINTR;return -1;}lock_taken=0;}return 0;}
  if(command==F_GETFD){CHECK(fd>=400 && fd<=410);return FD_CLOEXEC;}
  CHECK(eg.child_mode || up.child);va_list ap;va_start(ap,command);
  if(command==F_DUPFD_CLOEXEC){CHECK(va_arg(ap,int)==10);va_end(ap);return 500+fd;}
  if(command==F_GETFL){CHECK(fd>=0 && fd<3);va_end(ap);return O_NONBLOCK;}
  CHECK((command==F_SETFL || command==F_SETFD) && va_arg(ap,int)==0);va_end(ap);return 0;
}
static int eg_dup2(int from,int to){CHECK(eg.child_mode && from>=500 && (to==0 || to==1));return to;}
static int eg_dup3(int from,int to,int flags){CHECK((eg.child_mode || up.child) && from>=500 && (to==3 || to==4) && flags==O_CLOEXEC);return to;}
static int eg_setns(int fd,int kind){CHECK((eg.child_mode || up.child) && fd==(up.child ? 3 : 4) && kind==CLONE_NEWNET && eg.ranges==3 && !eg.entered);eg.entered=1;return 0;}
static pid_t eg_getppid(void){CHECK(eg.child_mode || up.child);return 1000;}
static int eg_clock(clockid_t kind,struct timespec *out){CHECK(kind==CLOCK_MONOTONIC);*out=(struct timespec){.tv_sec=1};return 0;}
static _Noreturn void eg_exit(int code){CHECK(eg.child_mode || up.child);longjmp(child_exit,code ? code : 1);}

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
/* Independent raw rtnetlink byte producer. It models kernel responses, not
 * successful owner/namespace/OCI return values. All such bodies above are real. */
static struct oci_uplink_owner *subject;
static int up_socket(int family,int type,int protocol){CHECK(family==AF_NETLINK && type==(SOCK_RAW|SOCK_CLOEXEC|SOCK_NONBLOCK) && protocol==NETLINK_ROUTE);up.sockets++;return up.child?405:407;}
static int up_socketpair(int family,int type,int protocol,int pair[2]){CHECK(family==AF_UNIX && type==(SOCK_SEQPACKET|SOCK_CLOEXEC|SOCK_NONBLOCK) && !protocol);pair[0]=400;pair[1]=401;return 0;}
static int up_setsockopt(int fd,int level,int option,const void *value,socklen_t size){CHECK((fd==405 || fd==407) && level==SOL_NETLINK && size==4 && *(const int*)value==1);CHECK(option==NETLINK_GET_STRICT_CHK || option==NETLINK_EXT_ACK || option==NETLINK_CAP_ACK);return 0;}
static int up_getsockopt(int fd,int level,int option,void *value,socklen_t *size){CHECK(level==SOL_SOCKET && (fd==405 || fd==407));if(option==SO_NETNS_COOKIE){CHECK(*size==8);*(uint64_t*)value=fd==405?(up.cookie_fault?778u:777u):888u;return 0;}CHECK(*size==4);*(int*)value=option==SO_DOMAIN?AF_NETLINK:option==SO_PROTOCOL?NETLINK_ROUTE:SOCK_RAW;return 0;}
static int up_getsockname(int fd,struct sockaddr *address,socklen_t *size){CHECK((fd==405 || fd==407) && *size==sizeof(struct sockaddr_nl));*(struct sockaddr_nl*)address=(struct sockaddr_nl){.nl_family=AF_NETLINK,.nl_pid=fd==405?900:901};return 0;}
static int up_bind(int fd,const struct sockaddr *address,socklen_t size){CHECK((fd==405 || fd==407) && size==sizeof(struct sockaddr_nl) && address->sa_family==AF_NETLINK);return 0;}
static ssize_t up_sendmsg(int fd,const struct msghdr *m,int flags){CHECK(flags==MSG_NOSIGNAL && m->msg_iovlen==1);if(up.child){CHECK(fd==4 && eg.entered && eg.ranges==3 && m->msg_controllen==CMSG_SPACE(sizeof(int)));return (ssize_t)m->msg_iov[0].iov_len;}
 CHECK(fd==405 || fd==407);CHECK(m->msg_namelen==sizeof(struct sockaddr_nl) && ((struct sockaddr_nl*)m->msg_name)->nl_pid==0);memcpy(&up.request,m->msg_iov[0].iov_base,sizeof(up.request));CHECK(up.request.nlmsg_len==m->msg_iov[0].iov_len && up.request.nlmsg_len<=sizeof(up.request_bytes));memcpy(up.request_bytes,m->msg_iov[0].iov_base,up.request.nlmsg_len);
 if((up.request.nlmsg_flags & NLM_F_DUMP)==NLM_F_DUMP){up.dumps++;return (ssize_t)up.request.nlmsg_len;}
 CHECK(lock_taken);up.mutations++;struct nlmsghdr h=up.request;if(up.nack_at && up.mutations==(unsigned int)up.nack_at)return (ssize_t)h.nlmsg_len;
 if(h.nlmsg_type==RTM_NEWLINK && (h.nlmsg_flags&NLM_F_CREATE)){CHECK(fd==407 && subject->create_sent && !up.creates && (h.nlmsg_flags&NLM_F_EXCL));up.creates++;up.created=!up.bad_ack && up.drop_ack!=2;}
 else if(h.nlmsg_type==RTM_NEWLINK){struct ifinfomsg a;memcpy(&a,up.request_bytes+NLMSG_HDRLEN,sizeof(a));CHECK(a.ifi_flags==IFF_UP && a.ifi_change==IFF_UP && a.ifi_index==(fd==405?51:50));up.up[fd==405]=1;}
 else if(h.nlmsg_type==RTM_NEWADDR){struct ifaddrmsg a;memcpy(&a,up.request_bytes+NLMSG_HDRLEN,sizeof(a));CHECK((a.ifa_family==AF_INET && a.ifa_prefixlen==31)||(a.ifa_family==AF_INET6 && a.ifa_prefixlen==127));up.assigned[fd==405][a.ifa_family==AF_INET6]=1;}
 else if(h.nlmsg_type==RTM_NEWROUTE){CHECK(fd==405);struct rtmsg a;memcpy(&a,up.request_bytes+NLMSG_HDRLEN,sizeof(a));up.routes[a.rtm_family==AF_INET6]=1;}
 else if(h.nlmsg_type==RTM_NEWNEIGH){struct ndmsg a;memcpy(&a,up.request_bytes+NLMSG_HDRLEN,sizeof(a));CHECK(a.ndm_state==NUD_PERMANENT && !a.ndm_flags && a.ndm_ifindex==(fd==405?51:50));unsigned int v6=a.ndm_family==AF_INET6;CHECK(a.ndm_family==AF_INET || v6);pol.neighbors[fd==405][v6]++;}
 else {CHECK(h.nlmsg_type==RTM_DELLINK && fd==407 && subject->delete_sent && up.created && !up.deletes);up.deletes++;up.removed=1;}
 return (ssize_t)up.request.nlmsg_len;
}
static size_t raw_append(unsigned char *out,size_t at,struct oci_uplink_request *r,uint32_t port){r->h.nlmsg_seq=up.request.nlmsg_seq;r->h.nlmsg_pid=port;r->h.nlmsg_flags=NLM_F_MULTI;memcpy(out+at,r,r->h.nlmsg_len);return at+NLMSG_ALIGN((size_t)r->h.nlmsg_len);}
static void raw_link(struct oci_uplink_request *r,const char *name,int index,unsigned int flags,const unsigned char mac[6],uint32_t peer){struct ifinfomsg h={.ifi_family=AF_UNSPEC,.ifi_type=peer?ARPHRD_ETHER:ARPHRD_LOOPBACK,.ifi_index=index,.ifi_flags=flags};oci_uplink_request(r,RTM_NEWLINK,0,&h,sizeof(h));CHECK(oci_uplink_attr(r,IFLA_IFNAME,name,strlen(name)+1)==0);if(mac)CHECK(oci_uplink_attr(r,IFLA_ADDRESS,mac,6)==0);size_t xdp=NLMSG_ALIGN((size_t)r->h.nlmsg_len);uint8_t none=XDP_ATTACHED_NONE;CHECK(oci_uplink_attr(r,IFLA_XDP,"",0)==0);CHECK(oci_uplink_attr(r,IFLA_XDP_ATTACHED,&none,sizeof(none))==0 && oci_uplink_end(r,xdp)==0);if(peer){CHECK(oci_uplink_attr(r,IFLA_LINK,&peer,4)==0);size_t n=oci_uplink_nest(r,IFLA_LINKINFO);CHECK(oci_uplink_attr(r,IFLA_INFO_KIND,"veth",5)==0 && oci_uplink_end(r,n)==0);}}
static size_t raw_rules(unsigned char *out,uint32_t port){size_t at=0;for(unsigned int i=0;i<5;i++){struct fib_rule_hdr h={.family=i<3?AF_INET:AF_INET6,.table=(unsigned char)(i==0 || i==3?RT_TABLE_LOCAL:i==2?RT_TABLE_DEFAULT:RT_TABLE_MAIN),.action=FR_ACT_TO_TBL};struct oci_uplink_request r;oci_uplink_request(&r,RTM_NEWRULE,0,&h,sizeof(h));uint32_t priority=i==0 || i==3?0u:i==2?32767u:32766u;if(up.conflict==3 && i==1)priority=100;if(priority)CHECK(oci_uplink_attr(&r,FRA_PRIORITY,&priority,4)==0);at=raw_append(out,at,&r,port);}return at;}
static size_t raw_addresses(unsigned char *out,int guest,uint32_t port){size_t at=0;for(unsigned int i=0;i<4;i++){int own=i>=2;if(guest && !own)continue;int v6=(int)(i%2);if(own && (!up.created || up.removed || !up.assigned[guest][v6]))continue;
 struct ifaddrmsg h={.ifa_family=(unsigned char)(v6?AF_INET6:AF_INET),.ifa_prefixlen=(unsigned char)(own?(v6?127:31):(v6?64:24)),.ifa_index=own?(guest?51u:50u):2u};struct oci_uplink_request r;oci_uplink_request(&r,RTM_NEWADDR,0,&h,sizeof(h));const void *ip=own?(v6?(const void*)(guest?subject->expected.guest6:subject->expected.host6):(const void*)(guest?subject->expected.guest4:subject->expected.host4)):(v6?(const void*)subject->expected.local6:(const void*)subject->expected.local4);if(up.conflict==1 && !own && !v6)ip=subject->expected.host4;CHECK(oci_uplink_attr(&r,IFA_ADDRESS,ip,v6?16u:4u)==0);at=raw_append(out,at,&r,port);}return at;}
static size_t raw_routes(unsigned char *out,int guest,uint32_t port){size_t at=0;for(unsigned int i=0;i<2;i++){if(guest && !up.routes[i])continue;struct rtmsg h={.rtm_family=(unsigned char)(i?AF_INET6:AF_INET),.rtm_table=RT_TABLE_MAIN,.rtm_protocol=RTPROT_STATIC,.rtm_scope=RT_SCOPE_UNIVERSE,.rtm_type=RTN_UNICAST};struct oci_uplink_request r;oci_uplink_request(&r,RTM_NEWROUTE,0,&h,sizeof(h));uint32_t index=guest?51u:2u;const void *ip=guest?(i?(const void*)subject->expected.host6:(const void*)subject->expected.host4):(i?(const void*)subject->expected.gateway6:(const void*)subject->expected.gateway4);CHECK(oci_uplink_attr(&r,RTA_OIF,&index,4)==0 && oci_uplink_attr(&r,RTA_GATEWAY,ip,i?16u:4u)==0);if(up.conflict==2 && !guest){uint32_t nh=9;CHECK(oci_uplink_attr(&r,RTA_NH_ID,&nh,4)==0);}at=raw_append(out,at,&r,port);}return at;}
static ssize_t up_recvmsg(int fd,struct msghdr *m,int flags){CHECK(m->msg_iovlen==1);if(fd==400){CHECK(flags==(MSG_CMSG_CLOEXEC|MSG_DONTWAIT));uint64_t fact[3]={5,77,777};memcpy(m->msg_iov[0].iov_base,fact,sizeof(fact));CHECK(m->msg_controllen==CMSG_SPACE(sizeof(int)));struct cmsghdr *c=CMSG_FIRSTHDR(m);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(up.malformed?2*sizeof(int):sizeof(int));int rights[2]={up.malformed?406:405,408};memcpy(CMSG_DATA(c),rights,up.malformed?2*sizeof(int):sizeof(int));m->msg_flags=MSG_CMSG_CLOEXEC;return sizeof(fact);}
 CHECK(flags==MSG_DONTWAIT && (fd==405 || fd==407));CHECK(m->msg_namelen==sizeof(struct sockaddr_nl));*(struct sockaddr_nl*)m->msg_name=(struct sockaddr_nl){.nl_family=AF_NETLINK};unsigned char *out=m->msg_iov[0].iov_base;uint32_t port=fd==405?900u:901u;
 if((up.request.nlmsg_flags&NLM_F_DUMP)!=NLM_F_DUMP){struct nlmsghdr h={.nlmsg_len=NLMSG_LENGTH(sizeof(struct nlmsgerr)),.nlmsg_type=NLMSG_ERROR,.nlmsg_flags=NLM_F_CAPPED,.nlmsg_seq=up.request.nlmsg_seq,.nlmsg_pid=port};struct nlmsgerr e={.error=(up.bad_ack || (up.nack_at && up.mutations==(unsigned int)up.nack_at))?-EPERM:0,.msg=up.request};memcpy(out,&h,sizeof(h));memcpy(out+NLMSG_HDRLEN,&e,sizeof(e));return (ssize_t)h.nlmsg_len;}
 size_t at=0;struct oci_uplink_request r;if(up.request.nlmsg_type==RTM_GETLINK){if(fd==407){raw_link(&r,"eth0",2,IFF_UP,subject->expected.mac,0);((struct ifinfomsg*)r.body)->ifi_type=ARPHRD_ETHER;at=raw_append(out,at,&r,port);}else{raw_link(&r,"lo",1,IFF_LOOPBACK,NULL,0);at=raw_append(out,at,&r,port);}if(up.created && !up.removed){raw_link(&r,fd==405?subject->guest_name:subject->host_name,fd==405?51:50,up.up[fd==405]?IFF_UP:0,fd==405?subject->guest_mac:subject->host_mac,fd==405?50:51);at=raw_append(out,at,&r,port);}}
 else if(up.request.nlmsg_type==RTM_GETADDR)at=raw_addresses(out,fd==405,port);
 else if(up.request.nlmsg_type==RTM_GETROUTE)at=raw_routes(out,fd==405,port);
 else if(up.request.nlmsg_type==RTM_GETNEIGH){struct ndmsg request;memcpy(&request,up.request_bytes+NLMSG_HDRLEN,sizeof(request));int guest=fd==405,v6=request.ndm_family==AF_INET6;CHECK((request.ndm_family==AF_INET || v6) && !request.ndm_ifindex && !request.ndm_state && !request.ndm_flags && !request.ndm_type && pol.neighbors[guest][v6]==1);struct ndmsg a={.ndm_family=request.ndm_family,.ndm_ifindex=guest?51:50,.ndm_state=NUD_PERMANENT,.ndm_type=RTN_UNICAST};oci_uplink_request(&r,RTM_NEWNEIGH,0,&a,sizeof(a));const void *ip=v6?(const void*)(guest?subject->expected.host6:subject->expected.guest6):(const void*)(guest?subject->expected.host4:subject->expected.guest4);CHECK(oci_uplink_attr(&r,NDA_DST,ip,v6?16u:4u)==0 && oci_uplink_attr(&r,NDA_LLADDR,guest?subject->host_mac:subject->guest_mac,6)==0);if(pol.fault==2)((struct ndmsg*)r.body)->ndm_state=NUD_STALE;at=raw_append(out,at,&r,port);}
 else {CHECK(up.request.nlmsg_type==RTM_GETRULE);at=raw_rules(out,port);}
 struct {struct nlmsghdr h;int result;} done={.h={.nlmsg_len=NLMSG_LENGTH(sizeof(int)),.nlmsg_type=NLMSG_DONE,.nlmsg_flags=NLM_F_MULTI,.nlmsg_seq=up.request.nlmsg_seq,.nlmsg_pid=port}};if(up.read_fault)done.h.nlmsg_flags|=NLM_F_DUMP_INTR;memcpy(out+at,&done,sizeof(done));return (ssize_t)(at+sizeof(done));
}
static void prepare(struct tns_oci_owner *o,struct tns_owner *b){memset(&up,0,sizeof(up));lock_busy=lock_taken=0;initialize_egress(o,b);CHECK(oci_egress_select(o,9)==0 && oci_egress_guard_install(o)==0);o->command_pid=0;up.active=1;
 int n=snprintf(up.file,sizeof(up.file),"{\"kind\":\"linux-oci-owned-topology@1\",\"artifact\":%s,\"topology\":{\"interfaceName\":\"eth0\",\"interfaceIndex\":2,\"interfaceMac\":\"02:11:22:33:44:55\",\"ipv4Address\":\"192.0.2.2/24\",\"ipv4Gateway\":\"192.0.2.1\",\"ipv6Address\":\"2001:db8::2/64\",\"ipv6Gateway\":\"2001:db8::1\",\"peerIpv4Host\":\"10.77.0.2\",\"peerIpv4Guest\":\"10.77.0.3\",\"peerIpv6Host\":\"fd77::2\",\"peerIpv6Guest\":\"fd77::3\"}}",eg.artifact);CHECK(n>0 && (size_t)n<sizeof(up.file));up.file_size=(size_t)n;
 CHECK(oci_uplink_select(o,&o->uplink)==0 && o->uplink);subject=o->uplink;
}
static void discard(struct tns_oci_owner *o){free(o->uplink);o->uplink=NULL;subject=NULL;}
static void source_cases(void){struct tns_oci_owner o;struct tns_owner b;
 prepare(&o,&b);struct tns_identity actual;CHECK(tns_owner_observe_creator(&b,&actual)==0 && actual.inode==66);CHECK(oci_uplink_install(&o,o.uplink)==0);CHECK(up.creates==1 && up.mutations==9 && up.joins==1 && !lock_taken && o.uplink->configured);CHECK(oci_uplink_install(&o,o.uplink)<0 && up.creates==1);CHECK(oci_uplink_cleanup(&o.uplink)==0 && !o.uplink && up.deletes==1 && !lock_taken);
 prepare(&o,&b);lock_busy=1;CHECK(oci_uplink_install(&o,o.uplink)<0 && !up.creates && !up.mutations);CHECK(oci_uplink_cleanup(&o.uplink)==0 && !o.uplink);
 prepare(&o,&b);up.malformed=1;CHECK(oci_uplink_install(&o,o.uplink)<0 && subject->received_count==2 && !up.mutations);CHECK(oci_uplink_cleanup(&o.uplink)==0 && up.closes[406]==1 && up.closes[408]==1 && !o.uplink);
 prepare(&o,&b);up.malformed=up.close_fault=1;CHECK(oci_uplink_install(&o,o.uplink)<0);CHECK(oci_uplink_cleanup(&o.uplink)<0 && o.uplink && up.closes[406]==1 && up.closes[408]==1);CHECK(oci_uplink_cleanup(&o.uplink)<0 && up.closes[406]==1 && up.closes[408]==1);discard(&o);
 prepare(&o,&b);up.bad_ack=1;CHECK(oci_uplink_install(&o,o.uplink)<0 && up.creates==1 && subject->create_sent && !subject->create_known);CHECK(oci_uplink_cleanup(&o.uplink)<0 && up.deletes==0 && lock_taken);CHECK(oci_uplink_install(&o,o.uplink)<0 && up.creates==1);discard(&o);
 prepare(&o,&b);up.nack_at=3;CHECK(oci_uplink_install(&o,o.uplink)<0 && subject->pair_known && !subject->broken && up.creates==1);CHECK(oci_uplink_cleanup(&o.uplink)==0 && up.deletes==1);
 prepare(&o,&b);up.read_fault=1;CHECK(oci_uplink_install(&o,o.uplink)<0 && !up.mutations);CHECK(oci_uplink_cleanup(&o.uplink)==0);
 prepare(&o,&b);up.wrong_host=1;CHECK(oci_uplink_install(&o,o.uplink)<0 && !up.mutations);CHECK(oci_uplink_cleanup(&o.uplink)==0);
 prepare(&o,&b);CHECK(oci_uplink_install(&o,o.uplink)==0);o.command_pid=4000;o.init_joined=0;CHECK(oci_uplink_cleanup(&o.uplink)<0 && !up.deletes);o.init_joined=o.init_custody=1;o.init_stop_attempt=1;oci_cancel_requested=1;CHECK(oci_uplink_cleanup(&o.uplink)==0 && up.deletes==1);
}
static void new_edge_cases(void){struct tns_oci_owner o;struct tns_owner b;
 prepare(&o,&b);CHECK(oci_uplink_guest_channel(&o,subject)==0);CHECK(oci_uplink_host_channel(subject)==0);subject->phase=UINT_MAX;unsigned int sockets=up.sockets;CHECK(oci_uplink_install(&o,subject)<0 && subject->phase==UINT_MAX && up.sockets==sockets && !up.mutations);CHECK(oci_uplink_cleanup(&o.uplink)==0);
 for(int fault=1;fault<=3;fault++){prepare(&o,&b);up.bad_lock=fault;CHECK(oci_uplink_install(&o,subject)<0 && !up.mutations);up.bad_lock=0;CHECK(oci_uplink_cleanup(&o.uplink)==0);}
 for(int fault=1;fault<=3;fault++){prepare(&o,&b);up.conflict=fault;CHECK(oci_uplink_install(&o,subject)<0 && !up.mutations);CHECK(oci_uplink_cleanup(&o.uplink)==0);}
 prepare(&o,&b);up.cookie_fault=1;CHECK(oci_uplink_install(&o,subject)<0 && !up.mutations);CHECK(oci_uplink_cleanup(&o.uplink)==0);
 prepare(&o,&b);up.unlock_fault=1;CHECK(oci_uplink_install(&o,subject)<0 && subject->broken && lock_taken);CHECK(oci_uplink_cleanup(&o.uplink)<0 && !up.deletes && lock_taken);discard(&o);
 prepare(&o,&b);CHECK(oci_uplink_install(&o,subject)==0);up.close_fault=2;CHECK(oci_uplink_cleanup(&o.uplink)<0 && up.deletes==1 && up.closes[122]==1);CHECK(oci_uplink_cleanup(&o.uplink)<0 && up.closes[122]==1);discard(&o);

 prepare(&o,&b);up.nack_at=3;CHECK(oci_uplink_install(&o,subject)<0 && subject->pair_known && !subject->broken);CHECK(tns_oci_close_transport(&o)==0 && !o.uplink && up.deletes==1 && model.custodian_reaps==1);
 prepare(&o,&b);CHECK(oci_uplink_install(&o,subject)==0);o.command_pid=4000;CHECK(tns_oci_close_transport(&o)<0 && o.uplink && !model.custodian_signals && b.phase==TNS_HELD);CHECK(!up.deletes);discard(&o);
 prepare(&o,&b);up.bad_ack=1;CHECK(oci_uplink_install(&o,subject)<0);CHECK(tns_oci_close_transport(&o)<0 && o.uplink && !model.custodian_signals && b.phase==TNS_HELD && !up.deletes);discard(&o);
}
static void child_case(void){struct tns_oci_owner o;struct tns_owner b;prepare(&o,&b);subject->identity=o.identity;subject->cookie=777;up.child=1;eg.child_mode=1;eg.ranges=eg.entered=0;if(!setjmp(child_exit))oci_uplink_child(subject,401);CHECK(eg.ranges==3 && eg.entered && up.closes[3]==1 && up.closes[4]==1 && up.closes[405]==1 && !lock_taken);up.child=eg.child_mode=0;discard(&o);}
static void codec_cases_uplink(void){struct tns_oci_owner o;struct tns_owner b;prepare(&o,&b);struct oci_uplink_topology t;CHECK(oci_uplink_topology(up.file,up.file_size,eg.artifact,eg.artifact_size,&t)==0);for(size_t i=0;i<up.file_size;i++)CHECK(oci_uplink_topology(up.file,i,eg.artifact,eg.artifact_size,&t)<0);char text[64];unsigned char ip[16];strcpy(text,"::ffff:c000:201");CHECK(oci_uplink_ip(text,AF_INET6,ip,NULL)<0);strcpy(text,"0.1.2.3");CHECK(oci_uplink_ip(text,AF_INET,ip,NULL)<0);discard(&o);
 struct oci_uplink_dump *d=calloc(1,sizeof(*d));CHECK(d);struct{struct nlmsghdr h;int result;} done={.h={.nlmsg_len=NLMSG_LENGTH(4),.nlmsg_type=NLMSG_DONE,.nlmsg_flags=NLM_F_MULTI,.nlmsg_seq=1,.nlmsg_pid=9}};
 for(size_t i=0;i<sizeof(done);i++){memset(d,0,sizeof(*d));d->sequence=1;d->port=9;d->type=RTM_NEWLINK;CHECK(oci_uplink_dump_feed(d,&done,i)<0 && !d->done);}
 for(unsigned int i=0;i<4;i++){memset(d,0,sizeof(*d));d->sequence=1;d->port=9;d->type=RTM_NEWLINK;struct{struct nlmsghdr h;int result;} bad;memcpy(&bad,&done,sizeof(bad));if(i==0)bad.h.nlmsg_seq++;if(i==1)bad.h.nlmsg_flags|=NLM_F_DUMP_INTR;if(i==2)bad.result=-ENOBUFS;if(i==3)bad.h.nlmsg_pid++;CHECK(oci_uplink_dump_feed(d,&bad,sizeof(bad))<0 && !d->done);}
 memset(d,0,sizeof(*d));d->sequence=1;d->port=9;d->type=RTM_NEWLINK;CHECK(oci_uplink_dump_feed(d,&done,sizeof(done))==0 && d->done && d->records==0);CHECK(oci_uplink_dump_feed(d,&done,sizeof(done))<0);free(d);
}
static void ack_loss_cases(void){struct tns_oci_owner o;struct tns_owner b;for(int effect=1;effect<=2;effect++){prepare(&o,&b);up.drop_ack=effect;CHECK(oci_uplink_install(&o,subject)<0 && subject->broken && subject->create_sent && !subject->create_known && up.creates==1);CHECK(up.created==(effect==1));CHECK(oci_uplink_install(&o,subject)<0 && up.creates==1);CHECK(tns_oci_close_transport(&o)<0 && o.uplink && !up.deletes && !model.custodian_signals && b.phase==TNS_HELD && lock_taken);discard(&o);}}
static mode_t policy_umask(mode_t mask){CHECK(eg.child_mode && mask==077);return 077;}
static void policy_raw_readback(void){
  CHECK(policy_subject && policy_subject->expected_size);const char *in=policy_subject->expected;size_t at=0;pol.readback_size=0;
  while(at<policy_subject->expected_size){const char *extra=NULL;size_t take=1;
    if(!strncmp(in+at,"{\"counter\":{",12)){take=12;extra="\"packets\":7,\"bytes\":11,";}
    if(!strncmp(in+at,"{\"quota\":{",10)){take=10;extra="\"used\":13,";}
    CHECK(take<sizeof(pol.readback)-pol.readback_size);memcpy(pol.readback+pol.readback_size,in+at,take);pol.readback_size+=take;at+=take;
    if(extra){size_t n=strlen(extra);CHECK(n<sizeof(pol.readback)-pol.readback_size);memcpy(pol.readback+pol.readback_size,extra,n);pol.readback_size+=n;}
  }
  pol.readback[pol.readback_size]=0;
}
static void policy_prepare(struct tns_oci_owner *o,struct tns_owner *b){memset(&pol,0,sizeof(pol));prepare(o,b);CHECK(oci_uplink_install(o,o->uplink)==0);int n=snprintf(pol.file,sizeof(pol.file),"{\"kind\":\"linux-oci-owned-service@1\",\"artifact\":%s,\"service\":{\"httpPort\":8080,\"healthPath\":\"/health/%%E3%%81%%82\"}}",eg.artifact);CHECK(n>0 && (size_t)n<sizeof(pol.file));pol.file_size=(size_t)n;CHECK(oci_policy_select(o,&o->policy)==0 && o->policy);policy_subject=o->policy;}
static void policy_discard(struct tns_oci_owner *o){free(o->policy);o->policy=NULL;policy_subject=NULL;discard(o);}
static void policy_change(char *bytes,size_t *size,const char *from,const char *to){char *at=strstr(bytes,from);CHECK(at);size_t a=strlen(from),b=strlen(to),before=(size_t)(at-bytes);CHECK(*size-a+b<OCI_POLICY_JSON_MAX);memmove(at+b,at+a,*size-before-a+1);memcpy(at,to,b);*size=*size-a+b;}
static void policy_codec_cases(void){struct tns_oci_owner o;struct tns_owner b;policy_prepare(&o,&b);struct oci_policy_service service;
 CHECK(oci_policy_service(pol.file,pol.file_size,eg.artifact,eg.artifact_size,&service)==0 && service.port==8080 && !strcmp(service.health,"/health/%E3%81%82"));for(size_t i=0;i<pol.file_size;i++)CHECK(oci_policy_service(pol.file,i,eg.artifact,eg.artifact_size,&service)<0);
 const char *const good[]={"/","/health","/a/%E3%81%82","/a/%2525x","/a/.well-known"};const char *const bad[]={"//x","/../x","/a/%252e%252e/x","/a/%2f","/a/%255c","/a?x","/a/%C0%AF","/a/%00","/a/%E3%81"};for(size_t i=0;i<sizeof(good)/sizeof(good[0]);i++)CHECK(oci_policy_health(good[i])==0);for(size_t i=0;i<sizeof(bad)/sizeof(bad[0]);i++)CHECK(oci_policy_health(bad[i])<0);
 CHECK(oci_policy_inventory(policy_subject)==0 && policy_subject->denied_count>=2 && oci_policy_compile(policy_subject)==0);CHECK(strstr(policy_subject->script,"ct direction original accept") && strstr(policy_subject->script,"ct direction reply counter name host_replies jump budgeted") && strstr(policy_subject->script,"ct count over 65535") && !strstr(policy_subject->script,"ct mark") && !strstr(policy_subject->script,"health"));policy_raw_readback();CHECK(oci_policy_readback(policy_subject,pol.readback,pol.readback_size)==0 && policy_subject->observed_packets[0]==7 && policy_subject->observed_bytes[0]==11 && policy_subject->observed_quota==13);
 for(unsigned int i=0;i<6;i++){policy_raw_readback();if(i==0)policy_change(pol.readback,&pol.readback_size,"\"sport\"}},\"right\":8080","\"sport\"}},\"right\":8081");if(i==1)policy_change(pol.readback,&pol.readback_size,"10.0.0.0","11.0.0.0");if(i==2)policy_change(pol.readback,&pol.readback_size,"\"inv\":true","\"inv\":false");if(i==3)policy_change(pol.readback,&pol.readback_size,"\"packets\":7,","");if(i==4)policy_change(pol.readback,&pol.readback_size,"\"table\":{","\"table\":{\"grant\":true,");if(i==5)policy_change(pol.readback,&pol.readback_size,"\"bytes\":11","\"bytes\":18446744073709551616");CHECK(oci_policy_readback(policy_subject,pol.readback,pol.readback_size)<0);}
 policy_raw_readback();policy_change(pol.readback,&pol.readback_size,"\"set\":[\"new\",\"established\"]","\"set\":[\"established\",\"new\"]");CHECK(oci_policy_readback(policy_subject,pol.readback,pol.readback_size)==0);policy_change(pol.readback,&pol.readback_size,"\"set\":[\"established\",\"new\"]","\"set\":[\"new\",\"new\"]");CHECK(oci_policy_readback(policy_subject,pol.readback,pol.readback_size)<0);
 /* Compiler-data branch only: this is not another dispatched owner/policy. */policy_subject->limits.internet=0;CHECK(oci_policy_compile(policy_subject)==0 && strstr(policy_subject->script,"counter name outbound_denied drop"));policy_discard(&o);
}
static void policy_source_cases(void){struct tns_oci_owner o;struct tns_owner b;policy_prepare(&o,&b);pol.active=1;pol.partial=1;CHECK(oci_policy_install(policy_subject)==0 && policy_subject->verified && pol.spawns==3 && !lock_taken);for(unsigned int i=0;i<3;i++)CHECK(pol.joins[i]==1 && !pol.signals[i]);for(unsigned int i=0;i<2;i++)CHECK(pol.neighbors[i][0]==1 && pol.neighbors[i][1]==1);CHECK(pol.sent_size[0]==policy_subject->script_size && pol.sent_size[1]==policy_subject->script_size && !memcmp(pol.sent[0],policy_subject->script,pol.sent_size[0]));CHECK(oci_policy_install(policy_subject)<0 && pol.spawns==3);pol.active=0;CHECK(oci_policy_close(&o.policy)==0 && !o.policy);policy_subject=NULL;CHECK(oci_uplink_cleanup(&o.uplink)==0);
 policy_prepare(&o,&b);pol.active=1;pol.fault=1;CHECK(oci_policy_install(policy_subject)<0 && pol.applied && !policy_subject->verified && pol.spawns==2 && lock_taken);CHECK(oci_policy_install(policy_subject)<0 && pol.spawns==2);CHECK(tns_oci_close_transport(&o)<0 && o.policy && o.uplink && !up.deletes && b.phase==TNS_HELD);CHECK(pol.signals[1]==1 && pol.joins[1]==1);CHECK(tns_oci_close_transport(&o)<0 && pol.signals[1]==1 && !up.deletes);policy_discard(&o);
 policy_prepare(&o,&b);pol.active=1;pol.fault=2;CHECK(oci_policy_install(policy_subject)<0 && !pol.spawns && subject->broken && lock_taken);CHECK(tns_oci_close_transport(&o)<0 && !up.deletes && o.uplink && b.phase==TNS_HELD);policy_discard(&o);
}
static void policy_child_case(void){struct tns_oci_owner o;struct tns_owner b;policy_prepare(&o,&b);CHECK(oci_uplink_lock(subject)==0);pol.child=1;eg.child_mode=1;eg.ranges=eg.entered=0;if(!setjmp(child_exit))oci_policy_child(policy_subject,2,450,453);CHECK(lock_taken && eg.ranges==3 && eg.entered && eg.close_calls[4]>=1);pol.child=0;eg.child_mode=0;CHECK(oci_uplink_unlock(subject)==0);policy_discard(&o);}
static void recursive_health_case(void){CHECK(oci_policy_health("/%25x%2541")<0);CHECK(oci_policy_health("/%25x")==0);CHECK(oci_policy_health("/%E3%81%82")==0);CHECK(oci_policy_health("/%252e%252e/x")<0);}
int main(int argc,char **argv){(void)codec_cases_uplink;(void)source_cases;(void)new_edge_cases;(void)child_case;(void)ack_loss_cases;CHECK(argc==2);if(!strcmp(argv[1],"--recursive-percent"))recursive_health_case();else{CHECK(!strcmp(argv[1],"--all"));policy_codec_cases();policy_source_cases();policy_child_case();}printf("new selected policy raw boundary: %lu checks\n",checks);return 0;}
