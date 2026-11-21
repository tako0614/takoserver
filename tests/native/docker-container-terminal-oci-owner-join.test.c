/* Actual namespace constructor and CLOSED syscall model are reused; the
 * previous cohort's main/cases are compiled but NEVER called. Namespace
 * owners are not manufactured by positive test stubs. */
int namespace_join_previous_cohort_never_run(void);
#define main namespace_join_previous_cohort_never_run
#include "docker-container-terminal-namespace-owner-join.test.c"
#undef main
#include <stdbool.h>
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
#define syscall raw_syscall
#define sigaction(...) raw_sigaction(__VA_ARGS__)
#define clock_gettime raw_clock_gettime
#include "../../scripts/native/docker-container-terminal-oci.c"
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
struct fixture { struct tns_owner *birth;struct tns_oci_owner o; };
static pid_t oj_getpid(void) { return j.fault==O_FOREIGN?1001:1000; }
static void oj_stat_data(int fd,struct stat *out) {
 memset(out,0,sizeof(*out));out->st_dev=3;out->st_ino=(ino_t)(1000+fd);out->st_uid=0;out->st_nlink=1;out->st_mode=S_IFDIR|0700;
 out->st_mtim.tv_sec=out->st_ctim.tv_sec=1;
 if(fd==O_ROOTFS)out->st_mode=S_IFDIR|0755;
 if(fd==O_RECEIPT || fd==O_CONFIG){out->st_mode=S_IFREG|0600;out->st_size=fd==O_RECEIPT?7:4;}
 if(fd==O_RUNTIME)out->st_mode=S_IFREG|0755;
 if(fd==O_PARENT_PIDNS || fd==O_SELF_PIDNS || fd==O_CHILDREN_PIDNS || fd==O_INIT_PARENT){out->st_dev=8;out->st_ino=2000;}
 if(fd==O_INIT_PIDNS || fd==O_FRESH_PIDNS){out->st_dev=8;out->st_ino=3000;if(j.fault==O_BAD_PIDNS)out->st_ino++;}
 if(fd==O_INIT_NET){out->st_dev=9;out->st_ino=701;}
 if(fd==O_CONFIG && (j.fault==O_BAD_CONFIG || (m.begin_calls && j.fault==O_LATE_BEGIN_CONFIG) || (m.read_calls && j.fault==O_LATE_READ_CONFIG)))out->st_ino++;
}
static int oj_open(const char *path,int flags,...) {
 CHECK(flags & O_CLOEXEC);int fd=!strcmp(path,"/proc/self/ns/pid")?O_SELF_PIDNS:O_CHILDREN_PIDNS;
 CHECK(fd==O_SELF_PIDNS || !strcmp(path,"/proc/self/ns/pid_for_children"));CHECK(!j.temporary[fd]);j.temporary[fd]=1;return fd;
}
static int oj_openat(int fd,const char *path,int flags,...) {
 CHECK(flags & O_CLOEXEC);int out;
 if(fd==O_BUNDLE){CHECK(!strcmp(path,"config.json"));out=O_CONFIG;}
 else {CHECK(fd==O_INIT_PROC);if(!strcmp(path,"ns/pid"))out=j.temporary[O_INIT_PIDNS]?O_FRESH_PIDNS:O_INIT_PIDNS;else {CHECK(!strcmp(path,"ns/net"));out=O_INIT_NET;}}
 CHECK(!j.temporary[out]);j.temporary[out]=1;return out;
}
static int oj_fstat(int fd,struct stat *out) {
 if(fd<O_ROOT)return raw_fstat(fd,out);
 CHECK(fd>=O_ROOT && fd<O_END);oj_stat_data(fd,out);return 0;
}
static int oj_fstatat(int fd,const char *path,struct stat *out,int flags) {
 CHECK(fd==O_ROOT && flags==AT_SYMLINK_NOFOLLOW);
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
 if(fd<O_ROOT){int result=raw_close(fd);if(fd==LOAN && j.fault==O_LOAN_CLOSE_UNKNOWN){errno=EINTR;return -1;}return result;}
 CHECK(fd>=O_ROOT && fd<O_END && j.temporary[fd]);j.temporary[fd]=0;return 0;
}
static ssize_t oj_pread(int fd,void *out,size_t size,off_t offset) {
 CHECK(fd==O_RECEIPT && offset>=0);static const char bytes[]="fixture";
 if((size_t)offset>=sizeof(bytes)-1)return 0;
 size_t n=sizeof(bytes)-1-(size_t)offset;CHECK(n<=size);memcpy(out,bytes+offset,n);return (ssize_t)n;
}
static int oj_prctl(int option,...) {
 CHECK(option==PR_GET_CHILD_SUBREAPER);va_list ap;va_start(ap,option);int *out=va_arg(ap,int *);va_end(ap);*out=1;return 0;
}
static int oj_poll(struct pollfd *p,nfds_t count,int timeout) {
 if(count==1 && p->fd==O_INIT_PIDFD){CHECK(timeout==0 || timeout==10000);p->revents=j.exited?POLLIN:0;return j.exited?1:0;}
 return raw_poll(p,count,timeout);
}
static int oj_waitid(idtype_t type,id_t id,siginfo_t *out,int flags) {
 if(id!=O_INIT_PIDFD)return raw_waitid(type,id,out,flags);
 CHECK(type==P_PIDFD && (flags==(WEXITED|WNOHANG) || flags==(WEXITED|WNOHANG|WNOWAIT)));
 memset(out,0,sizeof(*out));if(!j.exited){CHECK(flags & WNOWAIT);return 0;}
 out->si_pid=3000;out->si_code=CLD_EXITED;
 if(!(flags & WNOWAIT)){CHECK(!j.init_reaps);j.init_reaps++;}return 0;
}
static void setup(struct fixture *f) {
 memset(f,0,sizeof(*f));memset(&j,0,sizeof(j));oci_cancel_requested=0;
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
static void success(void) {
 struct fixture f;setup(&f);release_original(&f);struct tns_oci_owner *o=&f.o;
 CHECK(tns_oci_read_tracked_join(o)<0 && errno==EINVAL && !m.read_calls);
 tns_oci_note_cancel(); /* generic cancel neither grants nor disables factual cleanup */
 CHECK(tns_oci_begin_tracked_join(o)==0 && m.begin_calls==1);
 CHECK(tns_oci_read_tracked_join(o)<0 && errno==EAGAIN && m.read_calls==1);
 unsigned int reads=m.observes+m.life_reads,release=m.releases,signal=m.signals;
 CHECK(tns_oci_begin_tracked_join(o)<0 && errno==EALREADY && m.begin_calls==1);
 raw_final_object_free();CHECK(tns_oci_read_tracked_join(o)==0 && m.read_calls==2);
 CHECK(m.observes+m.life_reads==reads && m.releases==release && m.signals==signal && !m.after_begin_old_reads);
 same_owner(&f);dispose(&f);
}
static void unknowns(void) {
 const enum fault faults[]={BEGIN_LOST_EFFECT,BEGIN_LOST_NO_EFFECT,BEGIN_POSITIVE};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct fixture f;setup(&f);release_original(&f);m.fault=faults[i];CHECK(tns_oci_begin_tracked_join(&f.o)<0);
  CHECK(m.begin_calls==1 && f.birth->tracked_join_attempted);m.fault=NONE;
  CHECK(tns_oci_begin_tracked_join(&f.o)<0 && errno==EALREADY && m.begin_calls==1);
  CHECK(tns_oci_read_tracked_join(&f.o)<0 && errno==(faults[i]==BEGIN_LOST_NO_EFFECT?ENODATA:EAGAIN));
  raw_final_object_free();if(faults[i]==BEGIN_LOST_NO_EFFECT)CHECK(tns_oci_read_tracked_join(&f.o)<0 && errno==ENODATA);else CHECK(tns_oci_read_tracked_join(&f.o)==0);
  CHECK(m.begin_calls==1 && m.releases==1 && !m.after_begin_old_reads);same_owner(&f);dispose(&f);
 }
}
static void currentness(void) {
 const enum oj_fault faults[]={O_FOREIGN,O_BAD_CONFIG,O_BAD_PIDNS};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct fixture f;setup(&f);release_original(&f);j.fault=faults[i];
  CHECK(tns_oci_begin_tracked_join(&f.o)<0 && !m.begin_calls);same_owner(&f);dispose(&f);
 }
 for(unsigned int operation=0;operation<2;operation++) {
  struct fixture f;setup(&f);release_original(&f);
  if(operation){CHECK(tns_oci_begin_tracked_join(&f.o)==0);raw_final_object_free();j.fault=O_LATE_READ_CONFIG;CHECK(tns_oci_read_tracked_join(&f.o)<0 && m.read_calls==1);}
  else {j.fault=O_LATE_BEGIN_CONFIG;CHECK(tns_oci_begin_tracked_join(&f.o)<0 && m.begin_calls==1);}
  same_owner(&f);CHECK(f.birth->tracked_join_attempted);j.fault=O_NONE;
  CHECK(tns_oci_begin_tracked_join(&f.o)<0 && errno==EALREADY && m.begin_calls==1);
  if(!operation)raw_final_object_free();
  CHECK(tns_oci_read_tracked_join(&f.o)==0 && !m.after_begin_old_reads);dispose(&f);
 }
}
static void refusal_phases(void) {
 struct tns_oci_owner empty={0};CHECK(tns_oci_begin_tracked_join(NULL)<0 && errno==EINVAL);CHECK(tns_oci_read_tracked_join(&empty)<0 && errno==EINVAL);
 for(unsigned int phase=0;phase<5;phase++) {
  struct fixture f;setup(&f);if(phase)release_original(&f);
  if(phase==1)f.o.init_joined=0;
  if(phase==2)f.o.command_joined=0;
  if(phase==3){f.o.start_pid=5000;f.o.start_joined=0;}if(phase==4)f.o.namespace_loan_close_unknown=1;
  CHECK(tns_oci_begin_tracked_join(&f.o)<0 && !m.begin_calls);CHECK(tns_oci_read_tracked_join(&f.o)<0 && !m.read_calls);same_owner(&f);dispose(&f);
 }
 const bool own[]={true,false};
 for(size_t i=0;i<2;i++) {
  struct fixture f;setup(&f);if(own[i])j.fault=O_LOAN_CLOSE_UNKNOWN;else m.fault=CLOSE_UNKNOWN;
  struct tns_oci_namespace_lifetime life;CHECK(tns_oci_release_namespace(&f.o,&life)<0);
  j.fault=O_NONE;m.fault=NONE;CHECK(tns_oci_continue_namespace_release(&f.o,&life)<0 && errno==EUCLEAN);
  CHECK(f.o.namespace_loan_close_unknown || f.birth->namespace_close_unknown);
  CHECK(tns_oci_begin_tracked_join(&f.o)<0 && !m.begin_calls);same_owner(&f);dispose(&f);
 }
}
int main(void) {
 success();unknowns();currentness();refusal_phases();
 printf("PASS %u actual OCI/namespace tracked-join raw checks; native effects0\n",checks);return 0;
}
