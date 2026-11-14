/* Pure raw model of actual same-binary parent bodies. No native parent/helper,
 * clone, exec, wait, FD, signal, socket or old main/case is executed.
 * At product root, compile only this new TU with:
 * cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wpedantic \
 *   -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie \
 *   tests/native/docker-container-terminal-oci-parent.test.c -o "$OUT/parent-test"
 * "$OUT/parent-test"
 * Includes actual sources directly; no private extraction artifact is needed.
 */
#define main prior_admission_main_never_called
#include "docker-container-terminal-oci-admission.test.c"
#undef main
#undef CHECK
#define main prior_codec_main_never_called
#include "docker-container-terminal-oci-stdio.test.c"
#undef main
#undef CHECK
#define CHECK(c) do { ++checks; assert(c); } while (0)

static struct {
  int wrong_controller, not_root, tamper, close_fault, wait_kind, host_eof, host_epipe;
  int child, wrong_parent, read_error[2], eof[2], writes_again, write_toggle;
  unsigned int clones, waits, closes[256], pipes, duplicates, execs, ranges, writes, polls;
  unsigned int writable_interest, host_read_interest, bad_read_interest;
  int64_t clock;
  unsigned char *sent; size_t sent_size, chunk;
  const unsigned char *stream[2], *host_bytes;
  size_t stream_size[2], stream_at[2], host_size, host_at;
  unsigned char delivered[128]; size_t delivered_size;
} pm;
static jmp_buf parent_jump;
static int parent_exit_code;
static long parent_syscall(long number, ...);
static int parent_open(const char *name, int flags, ...);
static int parent_close(int fd);
static int parent_fstat(int fd, struct stat *out);
static int parent_fcntl(int fd, int command, ...);
static int parent_dup3(int source, int target, int flags);
static int parent_pipe2(int ends[2], int flags);
static ssize_t parent_read(int fd, void *bytes, size_t size);
static ssize_t parent_write(int fd, const void *bytes, size_t size);
static int parent_poll(struct pollfd *fds, nfds_t count, int timeout);
static int parent_waitid(idtype_t kind, id_t id, siginfo_t *out, int flags);
static pid_t parent_getpid(void);
static pid_t parent_getppid(void);
static uid_t parent_geteuid(void);
static int parent_prctl(int option, ...);
static int parent_sigaction(int number, const struct sigaction *in, struct sigaction *out);
static int parent_sigprocmask(int how, const sigset_t *in, sigset_t *out);
static int parent_clock(clockid_t kind, struct timespec *out);
static int parent_getsockopt(int fd, int level, int option, void *out, socklen_t *size);
static mode_t parent_umask(mode_t mask);
static int parent_pause(void);
static int parent_sigsuspend(const sigset_t *mask);
static _Noreturn void parent_exit(int status);
#define main parent_mode_main_never_called
#define syscall parent_syscall
#define open parent_open
#define close parent_close
#define fstat parent_fstat
#define fcntl parent_fcntl
#define dup3 parent_dup3
#define pipe2 parent_pipe2
#define read parent_read
#define write parent_write
#define poll parent_poll
#define waitid parent_waitid
#define getpid parent_getpid
#define getppid parent_getppid
#define geteuid parent_geteuid
#define prctl parent_prctl
#define sigaction(...) parent_sigaction(__VA_ARGS__)
#define sigprocmask parent_sigprocmask
#define clock_gettime parent_clock
#define getsockopt parent_getsockopt
#define umask parent_umask
#define pause parent_pause
#define sigsuspend parent_sigsuspend
#define _exit parent_exit
#include "../../scripts/native/docker-container-terminal-oci-stdio.c"
#undef _exit
#undef sigsuspend
#undef pause
#undef umask
#undef getsockopt
#undef clock_gettime
#undef sigprocmask
#undef sigaction
#undef prctl
#undef geteuid
#undef getppid
#undef getpid
#undef waitid
#undef poll
#undef write
#undef read
#undef pipe2
#undef dup3
#undef fcntl
#undef fstat
#undef close
#undef open
#undef syscall
#undef main

static struct ocipp_owner cloned_image;
static int parent_open(const char *name, int flags, ...) {
  CHECK(!strcmp(name, "/proc/self/exe") && flags == (O_PATH | O_CLOEXEC)); return 60;
}
static int parent_fstat(int fd, struct stat *out) {
  CHECK(fd == 60 || (pm.child && fd == 3));
  *out = (struct stat){.st_dev=99,.st_ino=pm.tamper ? 2u : 1u,.st_mode=S_IFREG|0755,
    .st_uid=0,.st_gid=0,.st_nlink=1,.st_size=12345}; return 0;
}
static pid_t parent_getpid(void) { return pm.wrong_controller ? 9 : pm.child ? 5001 : 5000; }
static pid_t parent_getppid(void) { return pm.wrong_parent ? 9 : 5000; }
static uid_t parent_geteuid(void) { return pm.not_root ? 1 : 0; }
static int parent_close(int fd) {
  CHECK(fd >= 0 && fd < 256); pm.closes[fd]++;
  if (fd == pm.close_fault) { errno=EINTR; return -1; } return 0;
}
static int parent_pipe2(int ends[2], int flags) {
  CHECK(flags == (O_CLOEXEC|O_NONBLOCK) && pm.pipes < 3);
  ends[0]=70+(int)pm.pipes*2; ends[1]=ends[0]+1; pm.pipes++; return 0;
}
static int parent_fcntl(int fd, int command, ...) {
  va_list ap; va_start(ap,command); int minimum=va_arg(ap,int); va_end(ap);
  CHECK(pm.child && command==F_DUPFD_CLOEXEC && minimum==10);
  CHECK(fd==70 || fd==73 || fd==75 || fd==60); return 100+(int)pm.duplicates++;
}
static int parent_dup3(int source,int target,int flags) {
  CHECK(pm.child && source==100+target && target>=0 && target<=3);
  CHECK(flags==(target==3?O_CLOEXEC:0)); return target;
}
static long parent_syscall(long number, ...) {
  va_list ap; va_start(ap,number);
  if(number==SYS_clone3) {
    struct clone_args *a=va_arg(ap,struct clone_args*);size_t n=va_arg(ap,size_t);
    CHECK(!pm.child && n==sizeof(*a) && a->flags==CLONE_PIDFD && a->exit_signal==SIGCHLD);
    cloned_image=*(struct ocipp_owner*)((unsigned char*)(uintptr_t)a->pidfd - offsetof(struct ocipp_owner,pidfd));
    *(int*)(uintptr_t)a->pidfd=80;pm.clones++;va_end(ap);return 2001;
  }
  if(number==SYS_close_range) {
    unsigned int first=va_arg(ap,unsigned int),last=va_arg(ap,unsigned int),flags=va_arg(ap,unsigned int);
    CHECK(pm.child && first==4 && last==~0u && !flags);pm.ranges++;va_end(ap);return 0;
  }
  CHECK(number==SYS_execveat && pm.child);
  int fd=va_arg(ap,int);const char *path=va_arg(ap,const char*);
  char *const *args=va_arg(ap,char*const*),*const *env=va_arg(ap,char*const*);int flags=va_arg(ap,int);
  CHECK(fd==3 && !*path && !strcmp(args[0],"docker-container-terminal-oci") && !args[1] && !env[0] && flags==AT_EMPTY_PATH);
  CHECK(pm.ranges==1 && pm.duplicates==4);pm.execs++;va_end(ap);longjmp(parent_jump,1);
}
static int parent_prctl(int option,...) {
  va_list ap;va_start(ap,option);int signal=va_arg(ap,int);va_end(ap);
  CHECK(option==PR_SET_PDEATHSIG && signal==(pm.child?SIGTERM:0));return 0;
}
static int parent_sigaction(int number,const struct sigaction *in,struct sigaction *out) {
  (void)out;CHECK(in && (number==SIGCHLD || number==SIGTERM || number==SIGINT || number==SIGPIPE));return 0;
}
static int parent_sigprocmask(int how,const sigset_t *in,sigset_t *out) {
  (void)out;CHECK(in && (how==SIG_SETMASK || how==SIG_UNBLOCK || how==SIG_BLOCK));return 0;
}
static mode_t parent_umask(mode_t mask) { CHECK(pm.child && mask==077);return 077; }
static _Noreturn void parent_exit(int status) { parent_exit_code=status;longjmp(parent_jump,2); }
static int parent_clock(clockid_t kind,struct timespec *out) {
  CHECK(kind==CLOCK_MONOTONIC);out->tv_sec=(time_t)(pm.clock/1000);out->tv_nsec=(long)(pm.clock%1000)*1000000;return 0;
}
static int parent_getsockopt(int fd,int level,int option,void *out,socklen_t *size) {
  (void)fd;(void)level;(void)option;(void)out;(void)size;CHECK(0);return -1;
}
static int parent_pause(void) { CHECK(0);return -1; }
static int parent_sigsuspend(const sigset_t *mask) { (void)mask;CHECK(0);return -1; }
static int parent_waitid(idtype_t kind,id_t id,siginfo_t *out,int flags) {
  CHECK(kind==P_PIDFD && id==80 && flags==(WEXITED|WNOHANG));pm.waits++;memset(out,0,sizeof(*out));
  if(pm.wait_kind==7){errno=EINTR;return -1;}
  if(pm.wait_kind==4){errno=ECHILD;return -1;}
  if(!pm.wait_kind)return 0;
  out->si_signo=SIGCHLD;out->si_pid=pm.wait_kind==5?2002:2001;
  out->si_code=pm.wait_kind==3?CLD_KILLED:pm.wait_kind==6?CLD_STOPPED:CLD_EXITED;
  out->si_status=pm.wait_kind==2?1:pm.wait_kind==3?SIGKILL:0;return 0;
}
static ssize_t parent_read(int fd,void *bytes,size_t size) {
  if(fd==0) {
    if(pm.host_at<pm.host_size){size_t n=pm.host_size-pm.host_at;if(n>size)n=size;memcpy(bytes,pm.host_bytes+pm.host_at,n);pm.host_at+=n;return (ssize_t)n;}
    if(pm.host_eof)return 0;
    errno=EAGAIN;return -1;
  }
  unsigned int which=fd==72?0u:1u;CHECK(fd==72 || fd==74);
  if(pm.read_error[which]){errno=EIO;return -1;}
  if(pm.stream_at[which]<pm.stream_size[which]) {
    size_t n=pm.stream_size[which]-pm.stream_at[which];if(n>size)n=size;
    memcpy(bytes,pm.stream[which]+pm.stream_at[which],n);pm.stream_at[which]+=n;return (ssize_t)n;
  }
  if(pm.eof[which])return 0;
  errno=EAGAIN;return -1;
}
static ssize_t parent_write(int fd,const void *bytes,size_t size) {
  if(fd==71) {
    pm.writes++;
    if(pm.writes_again && !pm.write_toggle++){errno=EAGAIN;return -1;}
    pm.write_toggle=0;size_t n=size;if(pm.chunk && n>pm.chunk)n=pm.chunk;
    CHECK(pm.sent_size+n<=TNS_OCI_MAX_JSON+4);memcpy(pm.sent+pm.sent_size,bytes,n);pm.sent_size+=n;return (ssize_t)n;
  }
  CHECK(fd==1 || fd==2);
  if(pm.host_epipe){errno=EPIPE;return -1;}
  CHECK(pm.delivered_size+size<=sizeof(pm.delivered));memcpy(pm.delivered+pm.delivered_size,bytes,size);pm.delivered_size+=size;return (ssize_t)size;
}
static int parent_poll(struct pollfd *fds,nfds_t count,int timeout) {
  CHECK(count==4 && timeout==1000);pm.polls++;int ready=0;
  for(nfds_t i=0;i<count;i++) {
    fds[i].revents=0;if(fds[i].fd<0)continue;
    if(fds[i].fd==0) {
      if(fds[i].events&POLLIN)pm.host_read_interest++;
      if(pm.host_eof)fds[i].revents=POLLHUP;
      else if(pm.host_at<pm.host_size && (fds[i].events&POLLIN))fds[i].revents=POLLIN;
    } else if(fds[i].fd==71) {CHECK(fds[i].events==POLLOUT);pm.writable_interest++;fds[i].revents=POLLOUT;}
    else {
      CHECK(fds[i].fd==72 || fds[i].fd==74);unsigned int which=fds[i].fd==72?0u:1u;
      if(pm.eof[which])fds[i].revents=POLLHUP;
      else if(pm.stream_at[which]<pm.stream_size[which] || pm.read_error[which])fds[i].revents=POLLIN;
    }
    if(fds[i].revents)ready++;
  }
  pm.clock+=ready?1:timeout;return ready;
}
static void prepare_parent(struct ocipp_owner *o,size_t size) {
  memset(&pm,0,sizeof(pm));ocipp_interrupted=0;pm.sent=calloc(1,TNS_OCI_MAX_JSON+4);CHECK(pm.sent);
  memset(o,0,sizeof(*o));size_t n=strlen(valid);if(!size)size=n;CHECK(size>=n);
  unsigned char *body=malloc(size);CHECK(body);memcpy(body,valid,n);memset(body+n,' ',size-n);
  CHECK(ocipp_prepare(o,body,(uint32_t)size)==0 && !strcmp(o->claim,CLAIM) && o->generation==1);
  CHECK(!memcmp(o->create+4,body,size));free(body);
}
static void dispose_fixture(struct ocipp_owner *o) {
  /* Raw heap only, no product disposal or permission after UNKNOWN. */
  free(o->create);free(o->incoming);free(o->captured[0]);free(o->captured[1]);free(pm.sent);
}
static void wait_and_eof(void) {
  struct ocipp_owner o;
  for(unsigned int order=0;order<3;++order) {
    prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0 && pm.clones==1);
    CHECK(ocipp_fact(&o)<0);pm.wait_kind=1;
    if(order==0){CHECK(ocipp_wait(&o)==0 && o.joined && ocipp_fact(&o)<0);}
    pm.eof[0]=1;CHECK(ocipp_drain(&o,0)==0 && ocipp_fact(&o)<0);
    if(order==1){CHECK(ocipp_wait(&o)==0 && ocipp_fact(&o)<0);}
    pm.eof[1]=1;CHECK(ocipp_drain(&o,1)==0);
    if(order==2){CHECK(ocipp_fact(&o)<0 && ocipp_wait(&o)==0);}
    CHECK(ocipp_fact(&o)==0 && pm.closes[72]==1 && pm.closes[74]==1);
    unsigned int waits=pm.waits;CHECK(ocipp_wait(&o)==0 && pm.waits==waits);
    CHECK(ocipp_spawn(&o)<0 && pm.clones==1);dispose_fixture(&o);
  }
}
static void refusal_cases(void) {
  struct ocipp_owner o;
  for(int fault=2;fault<=7;++fault) {
    prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0);pm.wait_kind=fault;
    int r=ocipp_wait(&o);CHECK(fault==7?r==1:r==(fault==2 || fault==3?0:-1));
    pm.eof[0]=pm.eof[1]=1;CHECK(ocipp_drain(&o,0)==0 && ocipp_drain(&o,1)==0 && ocipp_fact(&o)<0);
    if(fault==4 || fault==5 || fault==6){unsigned int calls=pm.waits;pm.wait_kind=1;CHECK(ocipp_wait(&o)<0 && pm.waits==calls);}
    dispose_fixture(&o);
  }
  prepare_parent(&o,0);pm.wrong_controller=1;CHECK(ocipp_spawn(&o)<0 && !pm.clones && !pm.pipes);pm.wrong_controller=0;
  pm.tamper=1;CHECK(ocipp_spawn(&o)<0 && !pm.clones);pm.tamper=0;CHECK(ocipp_spawn(&o)==0);
  CHECK(ocipp_prepare(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))<0 && o.attempted && pm.clones==1);
  pm.read_error[0]=1;CHECK(ocipp_drain(&o,0)<0 && o.pipe_unknown[0]);pm.read_error[0]=0;pm.eof[0]=1;
  CHECK(ocipp_drain(&o,0)<0 && !o.eof[0]);dispose_fixture(&o);
  prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0);pm.close_fault=72;pm.eof[0]=1;
  CHECK(ocipp_drain(&o,0)<0 && o.eof[0] && o.output[0]==-1 && o.close_unknown);
  CHECK(ocipp_drain(&o,0)==0 && pm.closes[72]==1 && ocipp_fact(&o)<0);dispose_fixture(&o);
}
static void host_loss_and_delivery(void) {
  static const unsigned char reply[]={0,0,0,2,'{','}'};
  struct ocipp_owner o;prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0);
  pm.chunk=7;CHECK(ocipp_flush_input(&o)==0 && o.incoming_sent==7);ocipp_host_lost(&o);
  while(o.pending)CHECK(ocipp_flush_input(&o)==0);
  CHECK(pm.sent_size==o.create_size && !memcmp(pm.sent,o.create,o.create_size) && !pm.closes[71]);
  pm.stream[0]=reply;pm.stream_size[0]=sizeof(reply);CHECK(ocipp_drain(&o,0)==1 && ocipp_parse_reply(&o)==0);
  CHECK(ocipp_forward(&o,0)==0 && !pm.delivered_size && !memcmp(o.captured[0],reply,sizeof(reply)));
  pm.eof[0]=pm.eof[1]=1;pm.wait_kind=1;CHECK(ocipp_drain(&o,0)==0 && ocipp_drain(&o,1)==0 && ocipp_wait(&o)==0 && ocipp_fact(&o)==0);
  CHECK(o.host_lost && !pm.closes[71]);dispose_fixture(&o);
  prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0);pm.host_eof=1;CHECK(ocipp_step(&o)<0 && o.host_lost && !pm.sent_size && !pm.closes[71]);
  dispose_fixture(&o);
  prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0 && ocipp_flush_input(&o)==0);
  pm.stream[0]=reply;pm.stream_size[0]=sizeof(reply);CHECK(ocipp_drain(&o,0)==1 && ocipp_parse_reply(&o)==0);
  pm.host_epipe=1;CHECK(ocipp_forward(&o,0)<0 && o.host_lost && o.delivered[0]==0 && o.used[0]==sizeof(reply));
  CHECK(ocipp_fact(&o)<0 && !pm.closes[71]);dispose_fixture(&o);
}
static void readiness_and_child(void) {
  struct ocipp_owner o;prepare_parent(&o,TNS_OCI_MAX_JSON);CHECK(ocipp_spawn(&o)==0);
  pm.chunk=16384;pm.writes_again=1;
  while(o.pending){CHECK(ocipp_step(&o)<0);CHECK(pm.polls<200);}
  CHECK(pm.sent_size==o.create_size && !memcmp(pm.sent,o.create,o.create_size));
  CHECK(pm.writable_interest==pm.polls && pm.clock<4000 && !pm.host_read_interest);
  /* Cadence/readiness model only, not actual H scheduling or its 4s deadline. */
  pm.host_bytes=(const unsigned char*)"queued";pm.host_size=6;
  unsigned int polls=pm.polls;CHECK(ocipp_step(&o)<0 && pm.polls==polls+1 && !pm.host_at && !pm.host_read_interest);
  pm.child=1;int r=setjmp(parent_jump);if(!r)ocipp_child(&cloned_image);CHECK(r==1 && pm.execs==1 && pm.ranges==1);
  pm.duplicates=pm.ranges=pm.execs=0;pm.wrong_parent=1;r=setjmp(parent_jump);if(!r)ocipp_child(&cloned_image);
  CHECK(r==2 && parent_exit_code==126 && !pm.execs && !pm.ranges);pm.child=0;dispose_fixture(&o);
}
int main(void) {
  wait_and_eof();refusal_cases();host_loss_and_delivery();readiness_and_child();
  printf("new actual persistent-parent raw boundary: %lu checks\n",checks);return 0;
}
