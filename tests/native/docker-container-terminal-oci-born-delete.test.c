/* Actual namespace constructor and CLOSED syscall model are reused; the
 * previous cohort's main/cases are compiled but NEVER called. Namespace
 * owners are not manufactured by positive test stubs. */
int namespace_join_previous_cohort_never_run(void);
#define main namespace_join_previous_cohort_never_run
#include "docker-container-terminal-namespace-owner-join.test.c"
#undef main
#include <stdbool.h>
#include <setjmp.h>
#include "../../scripts/native/docker-container-terminal-oci.h"
static int oj_open(const char *path,int flags,...);
static int oj_openat(int fd,const char *path,int flags,...);
static int oj_fstat(int fd,struct stat *out);
static int oj_fstatat(int fd,const char *path,struct stat *out,int flags);
static int oj_fstatfs(int fd,struct statfs *out);
static int oj_ioctl(int fd,unsigned long command,...);
static int oj_close(int fd);
static ssize_t oj_pread(int fd,void *out,size_t size,off_t offset);
static int oj_prctl(int option,...);
static int oj_poll(struct pollfd *p,nfds_t count,int timeout);
static int oj_waitid(idtype_t type,id_t id,siginfo_t *out,int flags);
static pid_t oj_getpid(void);
static long bd_syscall(long number,...);
static int bd_fcntl(int fd,int command,...);
static int bd_dup3(int oldfd,int newfd,int flags);
static int bd_dup2(int oldfd,int newfd);
static mode_t bd_umask(mode_t mask);
static pid_t bd_getppid(void);
static _Noreturn void bd_exit(int code);
#define fcntl bd_fcntl
#define dup3 bd_dup3
#define dup2 bd_dup2
#define umask bd_umask
#define getppid bd_getppid
#define _exit bd_exit
#define open oj_open
#define openat oj_openat
#define fstat oj_fstat
#define fstatat oj_fstatat
#define fstatfs oj_fstatfs
#define ioctl oj_ioctl
#define close oj_close
#define pread oj_pread
#define prctl oj_prctl
#define poll oj_poll
#define waitid oj_waitid
#define getpid oj_getpid
#define geteuid raw_geteuid
#define syscall bd_syscall
#define sigaction(...) raw_sigaction(__VA_ARGS__)
#define clock_gettime raw_clock_gettime
#include "../../scripts/native/docker-container-terminal-oci.c"
#ifdef OCI_BORN_DELETE_OLD_COMMAND
#include OCI_BORN_DELETE_OLD_COMMAND
#endif
#undef fcntl
#undef dup3
#undef dup2
#undef umask
#undef getppid
#undef _exit
#undef open
#undef openat
#undef fstat
#undef fstatat
#undef fstatfs
#undef ioctl
#undef close
#undef pread
#undef prctl
#undef poll
#undef waitid
#undef getpid
#undef geteuid
#undef syscall
#undef sigaction
#undef clock_gettime

enum { O_ROOT=100,O_ROOTFS,O_RECEIPT,O_RUNTIME,O_BUNDLE,O_STATE,O_CONFIG,
 O_PARENT_PIDNS,O_INIT_PIDNS,O_SELF_PIDNS,O_CHILDREN_PIDNS,O_INIT_PARENT,
 O_INIT_PROC,O_INIT_PIDFD,O_INIT_NET,O_FRESH_PIDNS,O_END };
enum oj_fault { O_NONE,O_FOREIGN,O_BAD_CONFIG,O_BAD_PIDNS,O_LATE_BEGIN_CONFIG,
 O_LATE_READ_CONFIG,O_LOAN_CLOSE_UNKNOWN };
struct oj_model { enum oj_fault fault;int exited;unsigned int init_reaps;unsigned int temporary[O_END]; };
static struct oj_model j;
enum { D_STATE=200,D_PIDFD,D_EXEC };
enum bd_fault { D_NONE,D_TIMEOUT,D_POLL_ERROR,D_POLL_EXTRA,D_WAIT_ERROR,
 D_WAIT_PID,D_WAIT_CODE,D_WAIT_STATUS,D_WAIT_SIGNO,D_NONZERO,D_SIGNALED,
 D_PRESENT,D_ABSENCE_ERROR,D_CLONE_ERROR,D_STATE_REPLACED,D_LATE_CONFIG,
 D_CLOCK_FAIL,D_CLOCK_EXPIRED,D_OPEN_FAIL,D_STATE_BAD_MODE,D_PARENT_MISMATCH };
struct bd_model {
 enum bd_fault fault;
 struct tns_oci_owner *owner;
 unsigned int spawns,waits,polls,state_opens,state_stats,absence_reads,clock_reads;
 unsigned int child_mode,exec_calls,exits,child_closes,fd_prepared,parent_death;
 int state_present,state_fd_live,command_fd_live;
};
static struct bd_model b;
static jmp_buf child_escape;

struct fixture { struct tns_owner *birth;struct tns_oci_owner o; };
static pid_t oj_getpid(void) { return j.fault==O_FOREIGN?1001:1000; }
static void oj_stat_data(int fd,struct stat *out) {
 memset(out,0,sizeof(*out));out->st_dev=3;out->st_ino=(ino_t)(1000+fd);out->st_uid=0;out->st_nlink=1;out->st_mode=S_IFDIR|0700;
 out->st_mtim.tv_sec=out->st_ctim.tv_sec=1;
 if(fd==O_CONFIG && b.spawns && b.fault==D_LATE_CONFIG)out->st_ino++;
 if(fd==O_ROOTFS)out->st_mode=S_IFDIR|0755;
 if(fd==O_RECEIPT || fd==O_CONFIG){out->st_mode=S_IFREG|0600;out->st_size=fd==O_RECEIPT?7:4;}
 if(fd==O_RUNTIME)out->st_mode=S_IFREG|0755;
 if(fd==O_PARENT_PIDNS || fd==O_SELF_PIDNS || fd==O_CHILDREN_PIDNS || fd==O_INIT_PARENT){out->st_dev=8;out->st_ino=2000;}
 if(fd==O_INIT_PIDNS || fd==O_FRESH_PIDNS){out->st_dev=8;out->st_ino=3000;if(j.fault==O_BAD_PIDNS)out->st_ino++;}
 if(fd==O_INIT_NET){out->st_dev=9;out->st_ino=701;}
 if(fd==O_CONFIG && (j.fault==O_BAD_CONFIG || (m.begin_calls && j.fault==O_LATE_BEGIN_CONFIG) || (m.read_calls && j.fault==O_LATE_READ_CONFIG)))out->st_ino++;
}
static int oj_open(const char *path,int flags,...) {
 if(b.child_mode){CHECK(!strcmp(path,"/dev/null") && flags==(O_RDWR|O_CLOEXEC|O_NOFOLLOW));return 0;}
 CHECK(flags & O_CLOEXEC);int fd=!strcmp(path,"/proc/self/ns/pid")?O_SELF_PIDNS:O_CHILDREN_PIDNS;
 CHECK(fd==O_SELF_PIDNS || !strcmp(path,"/proc/self/ns/pid_for_children"));CHECK(!j.temporary[fd]);j.temporary[fd]=1;return fd;
}
static int oj_openat(int fd,const char *path,int flags,...) {
 CHECK(flags & O_CLOEXEC);int out;
 if(fd==O_STATE){CHECK(!strcmp(path,b.owner->id));CHECK(flags==(O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));b.state_opens++;
  if(b.fault==D_OPEN_FAIL){errno=EACCES;return -1;}
  if(!b.state_present){errno=ENOENT;return -1;}
  CHECK(!b.state_fd_live);b.state_fd_live=1;return D_STATE;}

 if(fd==O_BUNDLE){CHECK(!strcmp(path,"config.json"));out=O_CONFIG;}
 else {CHECK(fd==O_INIT_PROC);if(!strcmp(path,"ns/pid"))out=j.temporary[O_INIT_PIDNS]?O_FRESH_PIDNS:O_INIT_PIDNS;else {CHECK(!strcmp(path,"ns/net"));out=O_INIT_NET;}}
 CHECK(!j.temporary[out]);j.temporary[out]=1;return out;
}
static int oj_fstat(int fd,struct stat *out) {
 if(b.child_mode && fd==0){memset(out,0,sizeof(*out));out->st_mode=S_IFCHR|0666;out->st_rdev=makedev(1,3);return 0;}
 if(fd==D_STATE){CHECK(b.state_fd_live);oj_stat_data(O_STATE,out);out->st_ino=9000;if(b.fault==D_STATE_BAD_MODE)out->st_mode=S_IFDIR|0777;return 0;}
 if(fd<O_ROOT)return raw_fstat(fd,out);
 CHECK(fd>=O_ROOT && fd<O_END);oj_stat_data(fd,out);return 0;
}
static int oj_fstatat(int fd,const char *path,struct stat *out,int flags) {
 CHECK(flags==AT_SYMLINK_NOFOLLOW);
 if(fd==O_STATE){CHECK(!strcmp(path,b.owner->id));b.state_stats++;
  if(b.spawns){b.absence_reads++;if(b.fault==D_ABSENCE_ERROR){errno=EACCES;return -1;}}
  if(!b.state_present){errno=ENOENT;return -1;}
  oj_stat_data(O_STATE,out);out->st_ino=b.fault==D_STATE_REPLACED?9001:9000;return 0;}
 CHECK(fd==O_ROOT);
 int target=!strcmp(path,"rootfs")?O_ROOTFS:!strcmp(path,"bundle")?O_BUNDLE:!strcmp(path,"runtime-state")?O_STATE:O_RECEIPT;
 CHECK(target!=O_RECEIPT || !strcmp(path,".tako-oci-artifact.json"));oj_stat_data(target,out);return 0;
}
static int oj_fstatfs(int fd,struct statfs *out) {
 if(fd<O_ROOT)return raw_fstatfs(fd,out);
 CHECK(fd>=O_PARENT_PIDNS && fd<O_END);
 memset(out,0,sizeof(*out));out->f_type=NSFS_MAGIC;return 0;
}
static int oj_ioctl(int fd,unsigned long command,...) {
 if(fd<O_ROOT){CHECK(command==NS_GET_NSTYPE);return raw_ioctl(fd,command);}
 if(command==NS_GET_NSTYPE)return fd==O_INIT_NET?CLONE_NEWNET:CLONE_NEWPID;
 if(command==NS_GET_PARENT){CHECK(fd==O_INIT_PIDNS && !j.temporary[O_INIT_PARENT]);j.temporary[O_INIT_PARENT]=1;return O_INIT_PARENT;}
 CHECK(command==NS_GET_PID_FROM_PIDNS && fd==O_FRESH_PIDNS);
 va_list ap;va_start(ap,command);CHECK(va_arg(ap,int)==1);va_end(ap);return 3000;
}
static int oj_close(int fd) {
 if(b.child_mode){CHECK(fd>=0 && fd<=2);b.child_closes++;return 0;}
 CHECK(fd!=D_STATE && fd!=D_PIDFD); /* Product retains these; fixture disposal is separate. */
 if(fd<O_ROOT){int result=raw_close(fd);if(fd==LOAN && j.fault==O_LOAN_CLOSE_UNKNOWN){errno=EINTR;return -1;}return result;}
 CHECK(fd>=O_ROOT && fd<O_END && j.temporary[fd]);j.temporary[fd]=0;return 0;
}
static ssize_t oj_pread(int fd,void *out,size_t size,off_t offset) {
 CHECK(fd==O_RECEIPT && offset>=0);static const char bytes[]="fixture";
 if((size_t)offset>=sizeof(bytes)-1)return 0;
 size_t n=sizeof(bytes)-1-(size_t)offset;CHECK(n<=size);memcpy(out,bytes+offset,n);return (ssize_t)n;
}
static int oj_prctl(int option,...) {
 if(b.child_mode){CHECK(option==PR_SET_PDEATHSIG);va_list ap;va_start(ap,option);CHECK(va_arg(ap,int)==SIGKILL);va_end(ap);b.parent_death++;return 0;}
 CHECK(option==PR_GET_CHILD_SUBREAPER);va_list ap;va_start(ap,option);int *out=va_arg(ap,int *);va_end(ap);*out=1;return 0;
}
static int oj_poll(struct pollfd *p,nfds_t count,int timeout) {
 if(count==1 && p->fd==D_PIDFD){CHECK(b.command_fd_live && b.spawns==1 && p->events==POLLIN && timeout>0 && timeout<=10000);b.polls++;
  if(b.fault==D_TIMEOUT)return 0;
  if(b.fault==D_POLL_ERROR){errno=EINTR;return -1;}
  p->revents=b.fault==D_POLL_EXTRA?POLLIN|POLLHUP:POLLIN;return 1;}
 if(count==1 && p->fd==O_INIT_PIDFD){CHECK(timeout==0 || timeout==10000);p->revents=j.exited?POLLIN:0;return j.exited?1:0;}
 return raw_poll(p,count,timeout);
}
static int oj_waitid(idtype_t type,id_t id,siginfo_t *out,int flags) {
 if(id==D_PIDFD){CHECK(type==P_PIDFD && flags==(WEXITED|WNOHANG));CHECK(b.command_fd_live && b.owner->delete_wait_attempted && !b.waits);b.waits++;
  if(b.fault==D_WAIT_ERROR){errno=EINTR;return -1;}
  memset(out,0,sizeof(*out));out->si_pid=b.fault==D_WAIT_PID?5001:5000;out->si_signo=b.fault==D_WAIT_SIGNO?SIGUSR1:SIGCHLD;
  out->si_code=b.fault==D_WAIT_CODE?CLD_STOPPED:b.fault==D_SIGNALED?CLD_KILLED:CLD_EXITED;
  out->si_status=b.fault==D_WAIT_STATUS?256:b.fault==D_NONZERO?1:b.fault==D_SIGNALED?SIGKILL:0;
  /* Modeled command effect may remove state even on nonzero/unknown reply;
   * source must still require its own exact joined-zero facts. */
  if(b.fault!=D_PRESENT)b.state_present=0;
  return 0;}
 if(id!=O_INIT_PIDFD)return raw_waitid(type,id,out,flags);
 CHECK(type==P_PIDFD && (flags==(WEXITED|WNOHANG) || flags==(WEXITED|WNOHANG|WNOWAIT)));
 memset(out,0,sizeof(*out));if(!j.exited){CHECK(flags & WNOWAIT);return 0;}
 out->si_pid=3000;out->si_code=CLD_EXITED;
 if(!(flags & WNOWAIT)){CHECK(!j.init_reaps);j.init_reaps++;}return 0;
}
static void setup(struct fixture *f) {
 memset(f,0,sizeof(*f));memset(&j,0,sizeof(j));memset(&b,0,sizeof(b));oci_cancel_requested=0;
 reset(&f->birth);CHECK(tns_owner_create(&f->birth)==0);
 struct tns_oci_owner *o=&f->o;o->birth=f->birth;o->network=tns_owner_dup_namespace(f->birth);CHECK(o->network==LOAN);
 CHECK(tns_owner_observe(f->birth,&o->identity)==0);
 /* Prepared original OCI artifact/command record only. Whole runc CREATE
  * is NOT run. Critical PIDNS custody/reap facts come from actual bodies. */
 o->root=O_ROOT;o->rootfs=O_ROOTFS;o->receipt=O_RECEIPT;o->runtime=O_RUNTIME;o->bundle=O_BUNDLE;o->state=O_STATE;
 o->controller_pid=1000;o->init_pid=3000;o->init_pidfd=O_INIT_PIDFD;o->init_proc=O_INIT_PROC;o->parent_pidns=O_PARENT_PIDNS;o->init_pidns=-1;
 o->command_pid=4000;o->command_joined=o->command_ok=1;o->config_created=1;o->stopped_exe=o->start_pidfd=-1;
 oj_stat_data(O_RUNTIME,&o->runtime_identity);oj_stat_data(O_ROOTFS,&o->rootfs_identity);oj_stat_data(O_CONFIG,&o->config_identity);oj_stat_data(O_PARENT_PIDNS,&o->parent_pidns_identity);
 memcpy(o->receipt_bytes,"fixture",7);o->receipt_size=7;memset(o->id,'a',64);o->id[64]=0;
 CHECK(oci_pin_pidns(o)==0 && o->init_custody);
 j.exited=1;struct tns_oci_init_reaped reaped;CHECK(tns_oci_stop_init(o,&reaped)==0);
 CHECK(o->init_joined && o->init_stop_attempt && j.init_reaps==1);
 b.owner=o;b.state_present=1;
 CHECK(oci_fd_path(o->statepath,sizeof(o->statepath),o->state)==0);
}
static void release_original(struct fixture *f) {
 struct tns_oci_namespace_lifetime life;CHECK(tns_oci_release_namespace(&f->o,&life)==0);
 CHECK(f->o.namespace_release_attempt && f->o.namespace_release_dispatched && f->o.network<0);
 CHECK(life.lifetime.reference_released && m.releases==1 && m.reaps==1);
}
static void same_owner(struct fixture *f) { CHECK(f->o.birth==f->birth && *m.slot==f->birth && f->birth->kernel_fd==DEVICE && m.fd_live[DEVICE]); }
static void dispose(struct fixture *f) {
 /* Fixture disposal only, never production born OCI cleanup/permission. */
 j.fault=O_NONE;oci_cancel_requested=0;
 CHECK(!j.temporary[O_FRESH_PIDNS]);
 CHECK(j.temporary[O_INIT_PIDNS]);j.temporary[O_INIT_PIDNS]=0;f->o.init_pidns=-1;
 for(int fd=O_ROOT;fd<O_END;fd++)CHECK(!j.temporary[fd]);
 if(f->o.network>=0){CHECK(raw_close(f->o.network)==0);f->o.network=-1;}
 dispose_fixture(&f->birth); /* original raw-only constructor owner; no runc born */
}

/* Actual fixed child body is executed only over these CLOSED syscall models.
 * Exec and _exit longjmp to the test; no process, FD or binary is created. */
static long bd_syscall(long number,...) {
 va_list ap;va_start(ap,number);
 if(number==SYS_clone3){struct clone_args *a=va_arg(ap,struct clone_args *);size_t n=va_arg(ap,size_t);
  CHECK(n==sizeof(*a) && a->flags==(CLONE_PIDFD|CLONE_CLEAR_SIGHAND) && a->exit_signal==SIGCHLD);
  CHECK(a->pidfd==(uintptr_t)&b.owner->delete_pidfd && b.owner->delete_attempt==1 && b.owner->delete_state_pinned);
  CHECK(b.owner->command_pid==4000 && b.owner->command_joined && b.owner->command_ok);
  CHECK(!b.spawns);b.spawns++;
  if(b.fault==D_CLONE_ERROR){va_end(ap);errno=EAGAIN;return -1;}
  *(int *)(uintptr_t)a->pidfd=D_PIDFD;b.command_fd_live=1;va_end(ap);return 5000;}
 if(number==SYS_close_range){CHECK(b.child_mode && va_arg(ap,unsigned int)==4u && va_arg(ap,unsigned int)==UINT_MAX && va_arg(ap,unsigned int)==0u);va_end(ap);return 0;}
 CHECK(number==SYS_execveat && b.child_mode && va_arg(ap,int)==3);
 const char *path=va_arg(ap,const char *);char *const *args=va_arg(ap,char *const *);char *const *env=va_arg(ap,char *const *);int flags=va_arg(ap,int);
 CHECK(!*path && flags==AT_EMPTY_PATH && b.child_closes==3 && b.parent_death==1 && b.fd_prepared==4);
 CHECK(!strcmp(args[0],"runc") && !strcmp(args[1],"--root") && !strcmp(args[2],b.owner->statepath) && !strcmp(args[3],"delete") && !strcmp(args[4],b.owner->id) && !args[5]);
 CHECK(!strcmp(env[0],"PATH=/usr/sbin:/usr/bin:/sbin:/bin") && !env[1]);b.exec_calls++;va_end(ap);longjmp(child_escape,1);
}
static int bd_fcntl(int fd,int command,...) {
 CHECK(b.child_mode);va_list ap;va_start(ap,command);int arg=va_arg(ap,int);va_end(ap);
 if(command==F_DUPFD_CLOEXEC){CHECK(fd==O_RUNTIME && arg==4);return D_EXEC;}
 CHECK(fd==0 && command==F_SETFD && arg==0);b.fd_prepared++;return 0;
}
static int bd_dup3(int oldfd,int newfd,int flags) {CHECK(b.child_mode && oldfd==D_EXEC && newfd==3 && flags==O_CLOEXEC);b.fd_prepared++;return 3;}
static int bd_dup2(int oldfd,int newfd) {CHECK(b.child_mode && oldfd==0 && (newfd==1 || newfd==2));b.fd_prepared++;return newfd;}
static mode_t bd_umask(mode_t mask) {CHECK(b.child_mode && mask==077);return 077;}
static pid_t bd_getppid(void) {CHECK(b.child_mode);return b.fault==D_PARENT_MISMATCH?1001:1000;}
static _Noreturn void bd_exit(int code) {CHECK(b.child_mode && code==125);b.exits++;longjmp(child_escape,2);}

static void prepare(struct fixture *f) {
 setup(f);release_original(f);CHECK(tns_oci_begin_tracked_join(&f->o)==0);
 raw_final_object_free();CHECK(tns_oci_read_tracked_join(&f->o)==0);
 tns_oci_note_cancel(); /* Cleanup must not be disabled by the original STOP. */
}
static void destroy_fixture(struct fixture *f) {
 /* Only raw-model allocations are disposed here. Product born cleanup does
  * not close/delete/free any of these retained original resources. */
 CHECK(f->o.command_pid==4000 && f->o.command_joined && f->o.command_ok);
 same_owner(f);b.state_fd_live=b.command_fd_live=0;dispose(f);
}
static void positive(void) {
 struct fixture f;prepare(&f);unsigned int old_reads=m.observes+m.life_reads;
 CHECK(tns_oci_delete_born(&f.o)==0 && b.spawns==1 && b.waits==1 && b.state_opens==1 && b.absence_reads==1);
 CHECK(f.o.delete_joined && f.o.delete_ok && f.o.delete_pid==5000 && f.o.delete_pidfd==D_PIDFD && b.state_fd_live && b.command_fd_live);
 CHECK(!m.after_begin_old_reads && m.observes+m.life_reads==old_reads);
 CHECK(tns_oci_delete_born(&f.o)<0 && errno==EALREADY && b.spawns==1);
 CHECK(tns_oci_join_born_delete(&f.o)==0 && b.spawns==1 && b.waits==1);
 destroy_fixture(&f);
}
static void fixed_child(void) {
 struct fixture f;prepare(&f);b.child_mode=1;
 int result=setjmp(child_escape);
 if(!result) {
#ifdef OCI_BORN_DELETE_OLD_COMMAND
  oci_old_command_child(&f.o,f.o.controller_pid,OCI_COMMAND_DELETE);
#else
  oci_command_child(&f.o,f.o.controller_pid,OCI_COMMAND_DELETE);
#endif
 }
 CHECK(result==1 && b.exec_calls==1 && !b.exits);b.child_mode=0;destroy_fixture(&f);
 prepare(&f);b.child_mode=1;b.fault=D_PARENT_MISMATCH;
 result=setjmp(child_escape);if(!result)oci_command_child(&f.o,f.o.controller_pid,OCI_COMMAND_DELETE);
 CHECK(result==2 && b.exec_calls==0 && b.exits==1);b.child_mode=0;destroy_fixture(&f);
 /* Original CREATE and START still reject the same canceled latch. */
 for(volatile int k=OCI_COMMAND_CREATE;k<=OCI_COMMAND_START;k++) {
  prepare(&f);b.child_mode=1;result=setjmp(child_escape);
  if(!result)oci_command_child(&f.o,f.o.controller_pid,(enum oci_command_kind)k);
  CHECK(result==2 && b.exits==1 && !b.exec_calls && !b.fd_prepared);b.child_mode=0;destroy_fixture(&f);
 }
}
static void pending_and_currentness(void) {
 CHECK(tns_oci_delete_born(NULL)<0 && errno==EINVAL);
 CHECK(tns_oci_join_born_delete(NULL)<0 && errno==EINVAL);
 for(unsigned int phase=0;phase<8;phase++) {
  struct fixture f;setup(&f);
  if(phase){release_original(&f);CHECK(tns_oci_begin_tracked_join(&f.o)==0);if(phase!=1)raw_final_object_free();}
  if(phase==2)f.o.init_joined=0;
  if(phase==3)f.o.namespace_loan_close_unknown=1;
  if(phase==4)j.fault=O_FOREIGN;
  if(phase==5)j.fault=O_BAD_CONFIG;
  if(phase==6)j.fault=O_BAD_PIDNS;
  if(phase==7)f.o.statepath[0]='x';
  CHECK(tns_oci_delete_born(&f.o)<0 && !b.spawns && !b.state_opens && !f.o.delete_attempt);
  destroy_fixture(&f);
 }
}
static void same_child_continuation(void) {
 const enum bd_fault faults[]={D_TIMEOUT,D_POLL_ERROR,D_POLL_EXTRA};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct fixture f;prepare(&f);b.fault=faults[i];CHECK(tns_oci_delete_born(&f.o)<0 && b.spawns==1 && !b.waits);
  CHECK(tns_oci_delete_born(&f.o)<0 && errno==EALREADY && b.spawns==1);
  b.fault=D_NONE;CHECK(tns_oci_join_born_delete(&f.o)==0 && b.spawns==1 && b.waits==1);destroy_fixture(&f);
 }
}
static void unknown_wait(void) {
 const enum bd_fault faults[]={D_WAIT_ERROR,D_WAIT_PID,D_WAIT_CODE,D_WAIT_STATUS,D_WAIT_SIGNO};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct fixture f;prepare(&f);b.fault=faults[i];CHECK(tns_oci_delete_born(&f.o)<0 && b.spawns==1 && b.waits==1 && f.o.delete_wait_attempted && !f.o.delete_joined);
  b.fault=D_NONE;CHECK(tns_oci_join_born_delete(&f.o)<0 && errno==EUCLEAN && b.waits==1 && b.spawns==1);
  CHECK(tns_oci_delete_born(&f.o)<0 && errno==EALREADY && b.spawns==1);destroy_fixture(&f);
 }
}
static void outcomes(void) {
 const enum bd_fault faults[]={D_NONZERO,D_SIGNALED,D_PRESENT,D_ABSENCE_ERROR,D_LATE_CONFIG,D_CLONE_ERROR,D_OPEN_FAIL,D_STATE_BAD_MODE,D_STATE_REPLACED};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct fixture f;prepare(&f);b.fault=faults[i];CHECK(tns_oci_delete_born(&f.o)<0 && f.o.delete_attempt);
  unsigned int spawns=b.spawns,waits=b.waits;
  CHECK(tns_oci_delete_born(&f.o)<0 && errno==EALREADY && b.spawns==spawns);
  if(faults[i]==D_NONZERO || faults[i]==D_SIGNALED){CHECK(f.o.delete_joined && !f.o.delete_ok && !b.state_present);b.fault=D_NONE;CHECK(tns_oci_join_born_delete(&f.o)<0 && errno==EUCLEAN);}
  if(faults[i]==D_PRESENT){CHECK(f.o.delete_joined && f.o.delete_ok && b.state_present);CHECK(tns_oci_join_born_delete(&f.o)<0 && errno==EEXIST);}
  if(faults[i]==D_LATE_CONFIG || faults[i]==D_ABSENCE_ERROR){CHECK(f.o.delete_joined && f.o.delete_ok);b.fault=D_NONE;CHECK(tns_oci_join_born_delete(&f.o)==0);}
  if(faults[i]==D_CLONE_ERROR || faults[i]==D_OPEN_FAIL || faults[i]==D_STATE_BAD_MODE || faults[i]==D_STATE_REPLACED){b.fault=D_NONE;CHECK(tns_oci_join_born_delete(&f.o)<0 && errno==EUCLEAN);}
  CHECK(b.spawns==spawns && b.waits==waits);destroy_fixture(&f);
 }
}
int main(void) {
 positive();fixed_child();pending_and_currentness();same_child_continuation();unknown_wait();outcomes();
 printf("PASS %u actual born DELETE/namespace syscall-model checks; native effects0\n",checks);return 0;
}
