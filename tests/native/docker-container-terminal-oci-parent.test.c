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

struct ocipp_owner;
static int model_management_send(const void *bytes,size_t size);
static struct {
  int wrong_controller, not_root, tamper, close_fault, wait_kind, host_eof, host_epipe;
  int child, wrong_parent, read_error[2], eof[2], writes_again, write_toggle;
  unsigned int clones, waits, closes[256], pipes, duplicates, execs, ranges, writes, polls;
  unsigned int writable_interest, host_read_interest, bad_read_interest;
  int64_t clock;
  unsigned char *sent; size_t sent_size, chunk;
  const unsigned char *stream[2], *host_bytes;
  size_t stream_size[2], stream_at[2], host_size, host_at;
  unsigned char delivered[256]; size_t delivered_size;
  uint64_t instance_cookie;
  unsigned int sockets, bindings, listeners, accepts;
  unsigned char address[128]; socklen_t address_size;
  const unsigned char *frontend_bytes; size_t frontend_size, frontend_at, frontend_chunk;
  unsigned char *frontend_sent; size_t frontend_sent_size;
  int frontend_eof, frontend_epipe, peer_uid, accept_ready, bind_error;
  size_t frontend_write_chunk;
  unsigned int frontend_reads; int frontend_oversize;
  unsigned int executable_stats; int tamper_after;
  int manage_mode; struct ocipp_owner *manage_owner;
  unsigned int manage_writes; unsigned char manage_output[4096], manage_h_reply[512]; size_t manage_output_size;
  int connector, pidfd_unsupported, pidfd_short, old_pidfs, peer_dead, boot_other, boot_short;
  unsigned int self_opens, peer_gets, peer_checks, cap_writes, readonly_writes, connects;
  uint64_t self_inode, peer_inode; size_t boot_at;
  unsigned char connector_reply[1024], expected_auth[124]; size_t connector_size, connector_at;
  size_t connector_auth_at, connector_request_at;

} pm;
static jmp_buf parent_jump;
static int parent_exit_code;
static long parent_syscall(long number, ...);
static int parent_open(const char *name, int flags, ...);
static int parent_close(int fd);
static int parent_fstat(int fd, struct stat *out);
static int parent_fstatfs(int fd, struct statfs *out);
static int parent_connect(int fd, const struct sockaddr *address, socklen_t size);
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
static int parent_socket(int family, int type, int protocol);
static int parent_bind(int fd, const struct sockaddr *address, socklen_t size);
static int parent_listen(int fd, int backlog);
static int parent_getsockname(int fd, struct sockaddr *address, socklen_t *size);
static int parent_accept4(int fd, struct sockaddr *address, socklen_t *size, int flags);
static mode_t parent_umask(mode_t mask);
static int parent_pause(void);
static int parent_sigsuspend(const sigset_t *mask);
static _Noreturn void parent_exit(int status);
#define main parent_mode_main_never_called
#define syscall parent_syscall
#define open parent_open
#define close parent_close
#define fstat parent_fstat
#define fstatfs parent_fstatfs
#define connect parent_connect
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
#define socket parent_socket
#define bind parent_bind
#define listen parent_listen
#define getsockname parent_getsockname
#define accept4 parent_accept4
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
#undef accept4
#undef getsockname
#undef listen
#undef bind
#undef socket
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
#undef fstatfs
#undef connect
#undef close
#undef open
#undef syscall
#undef main

static struct ocipp_owner cloned_image;
static int parent_open(const char *name, int flags, ...) {
  if(!strcmp(name,"/proc/sys/kernel/random/boot_id")){CHECK(flags==(O_RDONLY|O_CLOEXEC|O_NOFOLLOW));pm.boot_at=0;return 62;}
  CHECK(!strcmp(name, "/proc/self/exe") && flags == (O_PATH | O_CLOEXEC)); return 60;
}
static int parent_fstat(int fd, struct stat *out) {
  if(fd==61 || fd==92){*out=(struct stat){.st_dev=42,.st_ino=fd==61?pm.self_inode:pm.peer_inode,.st_mode=0700};return 0;}
  CHECK(fd == 60 || (pm.child && fd == 3));
  if(fd==60)pm.executable_stats++;
  *out = (struct stat){.st_dev=99,.st_ino=(pm.tamper || (pm.tamper_after && pm.executable_stats>1)) ? 2u : 1u,.st_mode=S_IFREG|0755,
    .st_uid=0,.st_gid=0,.st_nlink=1,.st_size=12345}; return 0;
}
static int parent_fstatfs(int fd,struct statfs *out){
  CHECK(fd==61 || fd==62 || fd==92);memset(out,0,sizeof(*out));
  out->f_type=fd==62?PROC_SUPER_MAGIC:pm.old_pidfs?ANON_INODE_FS_MAGIC:PID_FS_MAGIC;return 0;
}
static int parent_connect(int fd,const struct sockaddr *address,socklen_t size){
  CHECK(pm.connector && fd==90 && size==pm.address_size && !memcmp(address,pm.address,size));pm.connects++;return 0;
}
static pid_t parent_getpid(void) { return pm.wrong_controller ? 9 : pm.child ? 5001 : pm.connector ? 5002 : 5000; }
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
  if(command==F_SETFD){CHECK((fd==61 || fd==92) && minimum==FD_CLOEXEC);return 0;}
  CHECK(pm.child && command==F_DUPFD_CLOEXEC && minimum==10);
  CHECK(fd==70 || fd==73 || fd==75 || fd==60); return 100+(int)pm.duplicates++;
}
static int parent_dup3(int source,int target,int flags) {
  CHECK(pm.child && source==100+target && target>=0 && target<=3);
  CHECK(flags==(target==3?O_CLOEXEC:0)); return target;
}
static long parent_syscall(long number, ...) {
  va_list ap; va_start(ap,number);
  if(number==SYS_pidfd_open){int pid=va_arg(ap,int);unsigned int flags=va_arg(ap,unsigned int);
    CHECK(!pm.connector && pid==parent_getpid() && !flags);pm.self_opens++;va_end(ap);
    if(pm.pidfd_unsupported){errno=ENOSYS;return -1;}return 61;
  }
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
  CHECK(level==SOL_SOCKET);
  if(fd==90){
    if(option==SO_PEERPIDFD){CHECK(pm.connector && *size==sizeof(int));pm.peer_gets++;
      if(pm.pidfd_unsupported){errno=ENOPROTOOPT;return -1;}*(int*)out=92;*size=pm.pidfd_short?3:sizeof(int);return 0;}
    CHECK(option==SO_COOKIE && *size==sizeof(uint64_t));memcpy(out,&pm.instance_cookie,sizeof(uint64_t));return 0;
  }
  CHECK(fd==91 && option==SO_PEERCRED && *size==sizeof(struct ucred));
  *(struct ucred*)out=(struct ucred){.pid=7000,.uid=(uid_t)pm.peer_uid,.gid=0};return 0;
}
static int parent_socket(int family,int type,int protocol){CHECK(family==AF_UNIX && type==(SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC) && !protocol);pm.sockets++;return 90;}
static int parent_bind(int fd,const struct sockaddr *address,socklen_t size){
  CHECK(fd==90 && size<=sizeof(pm.address));const struct sockaddr_un *a=(const struct sockaddr_un*)address;
  CHECK(a->sun_family==AF_UNIX && !a->sun_path[0] && !memcmp(a->sun_path+1,"tako-oci-parent-v1:",19));
  memcpy(pm.address,address,size);pm.address_size=size;pm.bindings++;
  if(pm.bind_error){errno=EADDRINUSE;return -1;}return 0;
}
static int parent_listen(int fd,int backlog){CHECK(fd==90 && backlog==1);pm.listeners++;return 0;}
static int parent_getsockname(int fd,struct sockaddr *address,socklen_t *size){CHECK(fd==90 && *size>=pm.address_size);memcpy(address,pm.address,pm.address_size);*size=pm.address_size;return 0;}
static int parent_accept4(int fd,struct sockaddr *address,socklen_t *size,int flags){CHECK(fd==90 && !address && !size && flags==(SOCK_CLOEXEC|SOCK_NONBLOCK));pm.accepts++;pm.accept_ready=0;return 91;}
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
  if(fd==62){const char *boot=pm.boot_other?"22222222-2222-4222-8222-222222222222\n":"11111111-1111-4111-8111-111111111111\n";
    if(pm.boot_at)return 0;
    size_t n=pm.boot_short?36:37;CHECK(size>=n);memcpy(bytes,boot,n);pm.boot_at=n;return (ssize_t)n;}
  if(fd==90 && pm.connector){size_t n=pm.connector_size-pm.connector_at;if(n>size)n=size;
    if(!n){errno=EAGAIN;return -1;}memcpy(bytes,pm.connector_reply+pm.connector_at,n);pm.connector_at+=n;return (ssize_t)n;}
  if(fd==91){
    pm.frontend_reads++;
    if(pm.frontend_oversize)return (ssize_t)(size+1); /* impossible oversized syscall return, no memory write */
    if(pm.frontend_at<pm.frontend_size){size_t n=pm.frontend_size-pm.frontend_at;if(n>size)n=size;if(pm.frontend_chunk && n>pm.frontend_chunk)n=pm.frontend_chunk;memcpy(bytes,pm.frontend_bytes+pm.frontend_at,n);pm.frontend_at+=n;return (ssize_t)n;}
    if(pm.frontend_eof)return 0;
    errno=EAGAIN;return -1;
  }
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
  if(fd==90 && pm.connector){
    if(pm.connector_auth_at<sizeof(pm.expected_auth)){CHECK(size<=sizeof(pm.expected_auth)-pm.connector_auth_at);
      CHECK(!memcmp(bytes,pm.expected_auth+pm.connector_auth_at,size));pm.connector_auth_at+=size;pm.cap_writes++;}
    else if(pm.manage_mode) return model_management_send(bytes,size);
    else {static const char request[]="{\"kind\":\"linux-oci-parent-read-result@1\"}";
      unsigned char frame[4+sizeof(request)-1];size_t n=sizeof(request)-1;frame[0]=frame[1]=frame[2]=0;frame[3]=(unsigned char)n;memcpy(frame+4,request,n);
      CHECK(size<=sizeof(frame)-pm.connector_request_at && !memcmp(bytes,frame+pm.connector_request_at,size));pm.connector_request_at+=size;pm.readonly_writes++;}
    return (ssize_t)size;
  }
  if(fd==91){if(pm.frontend_epipe){errno=EPIPE;return -1;}if(pm.frontend_write_chunk && size>pm.frontend_write_chunk)size=pm.frontend_write_chunk;CHECK(pm.frontend_sent_size+size<=TNS_OCI_MAX_JSON+1024);memcpy(pm.frontend_sent+pm.frontend_sent_size,bytes,size);pm.frontend_sent_size+=size;return (ssize_t)size;}
  if(fd==71) {
    pm.writes++;
    if(pm.writes_again && !pm.write_toggle++){errno=EAGAIN;return -1;}
    pm.write_toggle=0;size_t n=size;if(pm.chunk && n>pm.chunk)n=pm.chunk;
    CHECK(pm.sent_size+n<=TNS_OCI_MAX_JSON+4);memcpy(pm.sent+pm.sent_size,bytes,n);pm.sent_size+=n;return (ssize_t)n;
  }
  CHECK(fd==1 || fd==2);
  if(pm.manage_mode && fd==1){CHECK(pm.manage_output_size+size<=sizeof(pm.manage_output));memcpy(pm.manage_output+pm.manage_output_size,bytes,size);pm.manage_output_size+=size;return (ssize_t)size;}
  if(pm.host_epipe){errno=EPIPE;return -1;}
  CHECK(pm.delivered_size+size<=sizeof(pm.delivered));memcpy(pm.delivered+pm.delivered_size,bytes,size);pm.delivered_size+=size;return (ssize_t)size;
}
static int parent_poll(struct pollfd *fds,nfds_t count,int timeout) {
  if(count==1){
    if(timeout==0 && (fds[0].fd==61 || fds[0].fd==92)){CHECK(fds[0].events==POLLIN);fds[0].revents=0;
      if(fds[0].fd==92){pm.peer_checks++;if(pm.peer_dead){fds[0].revents=POLLIN;return 1;}}return 0;}
    if(fds[0].fd==90 && pm.connector){fds[0].revents=0;if(fds[0].events==POLLIN && pm.connector_at<pm.connector_size){fds[0].revents=POLLIN;return 1;}
      if(fds[0].events==POLLOUT){fds[0].revents=POLLOUT;return 1;}CHECK(timeout==0);return 0;}
    CHECK(fds[0].fd==1 && fds[0].events==POLLOUT && timeout>0);fds[0].revents=POLLOUT;pm.clock++;return 1;
  }
  CHECK(count==7 && timeout==1000);pm.polls++;int ready=0;
  for(nfds_t i=0;i<count;i++) {
    fds[i].revents=0;if(fds[i].fd<0)continue;
    if(fds[i].fd==0) {
      if(fds[i].events&POLLIN)pm.host_read_interest++;
      if(pm.host_eof)fds[i].revents=POLLHUP;
      else if(pm.host_at<pm.host_size && (fds[i].events&POLLIN))fds[i].revents=POLLIN;
    } else if(fds[i].fd==90){if(pm.accept_ready)fds[i].revents=POLLIN;}
    else if(fds[i].fd==91){if(fds[i].events&POLLOUT)fds[i].revents=POLLOUT;else if(pm.frontend_eof)fds[i].revents=POLLHUP;else if(pm.frontend_at<pm.frontend_size)fds[i].revents=POLLIN;}
    else if(fds[i].fd==71) {CHECK(fds[i].events==POLLOUT);pm.writable_interest++;fds[i].revents=POLLOUT;}
    else {
      CHECK(fds[i].fd==72 || fds[i].fd==74);unsigned int which=fds[i].fd==72?0u:1u;
      if(pm.eof[which])fds[i].revents=POLLHUP;
      else if(pm.stream_at[which]<pm.stream_size[which] || pm.read_error[which])fds[i].revents=POLLIN;
    }
    if(fds[i].revents)ready++;
  }
  pm.clock+=ready?1:timeout;return ready;
}
static void prepare_bootstrap(struct ocipp_owner *o) {
  memset(&pm,0,sizeof(pm));ocipp_interrupted=0;
  pm.sent=calloc(1,TNS_OCI_MAX_JSON+4);pm.frontend_sent=calloc(1,TNS_OCI_MAX_JSON+1024);
  CHECK(pm.sent && pm.frontend_sent);pm.instance_cookie=UINT64_C(0xfedcba9876543210);
  memset(o,0,sizeof(*o));
  /* Explicit NONSECRET fixed capability fixture; no key generation occurs. */
  unsigned char bootstrap[112];memcpy(bootstrap,"TKOBIND1",8);memcpy(bootstrap+8,CLAIM,64);
  ocipp_put64(bootstrap+72,1);memset(bootstrap+80,0xa5,32);
  CHECK(ocipp_bootstrap(o,bootstrap,sizeof(bootstrap))==0 && !o->create && !pm.clones);
}
static void prepare_parent(struct ocipp_owner *o,size_t size) {
  prepare_bootstrap(o);size_t n=strlen(valid);if(!size)size=n;CHECK(size>=n);
  unsigned char *body=malloc(size);CHECK(body);memcpy(body,valid,n);memset(body+n,' ',size-n);
  CHECK(ocipp_first_create(o,body,(uint32_t)size)==0 && !strcmp(o->claim,CLAIM) && o->generation==1);
  CHECK(!memcmp(o->create+4,body,size));free(body);
}
static void dispose_fixture(struct ocipp_owner *o) {
  /* Raw heap only, no product disposal or permission after UNKNOWN. */
  free(o->create);free(o->incoming);free(o->captured[0]);free(o->captured[1]);free(o->frontend_input);free(o->management_output);free(pm.sent);free(pm.frontend_sent);
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
  CHECK(ocipp_first_create(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))<0 && o.attempted && pm.clones==1);
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
static size_t frame_bytes(unsigned char *out,const char *body) {
  size_t n=strlen(body);CHECK(n && n<=TNS_OCI_MAX_JSON);
  out[0]=(unsigned char)(n>>24);out[1]=(unsigned char)(n>>16);
  out[2]=(unsigned char)(n>>8);out[3]=(unsigned char)n;memcpy(out+4,body,n);return n+4;
}
static void auth_bytes(struct ocipp_owner *o,unsigned char out[124]) {
  memcpy(out,(unsigned char[]){0,0,0,120},4);memcpy(out+4,"TKOAUTH1",8);
  memcpy(out+12,o->claim,64);ocipp_put64(out+76,o->generation);
  ocipp_put64(out+84,o->listener_cookie);memcpy(out+92,o->capability,32);
}
static void authenticate_frontend(struct ocipp_owner *o,int fault) {
  unsigned char bytes[124];auth_bytes(o,bytes);
  if(fault==1)bytes[92]^=1; /* fixed nonsecret capability mismatch */
  if(fault==2)bytes[12]^=1;
  if(fault==3)bytes[83]^=1;
  if(fault==4)bytes[91]^=1; /* another P instance cookie */
  if(fault==5)bytes[4]^=1; /* purpose */
  pm.peer_uid=fault==6?1:0;pm.frontend_eof=0;pm.frontend_epipe=0;
  pm.frontend_bytes=bytes;pm.frontend_size=sizeof(bytes);pm.frontend_at=0;pm.frontend_chunk=7;
  CHECK(ocipp_accept(o)==0);
  unsigned int rounds=0;
  while(o->candidate>=0){CHECK(ocipp_read_authentication(o)==0 && ++rounds<30);}
  if(fault){CHECK(o->frontend<0 && o->host_lost);return;}
  CHECK(o->frontend==91 && !o->host_lost && o->replay_required);
  CHECK(ocipp_management_flush(o)==0 && o->management_sent==o->management_size);
  CHECK(memmem(pm.frontend_sent,pm.frontend_sent_size,"linux-oci-parent-authenticated@1",strlen("linux-oci-parent-authenticated@1")));
  pm.frontend_sent_size=0;
}
static int frontend_command(struct ocipp_owner *o,const char *body) {
  unsigned char frame[256];size_t n=frame_bytes(frame,body);CHECK(n<=sizeof(frame));
  pm.frontend_bytes=frame;pm.frontend_size=n;pm.frontend_at=0;pm.frontend_chunk=5;
  unsigned int rounds=0;int result=0;
  while(pm.frontend_at<n && o->frontend>=0){result=ocipp_frontend_read(o);CHECK(++rounds<100);}
  if(o->frontend>=0)CHECK(ocipp_management_flush(o)==0);
  return result;
}
static void bootstrap_and_authentication(void) {
  struct ocipp_owner o;prepare_bootstrap(&o);
  CHECK(ocipp_bootstrap_reply(&o)==0 && !o.create && !o.attempted && !pm.clones && !pm.pipes && !pm.sent_size);
  CHECK(pm.delivered_size==92 && !memcmp(pm.delivered,(unsigned char[]){0,0,0,88},4));
  CHECK(!memcmp(pm.delivered+4,"TKOINFO1",8) && ocipp_u64(pm.delivered+84)==pm.instance_cookie);
  CHECK(pm.instance_cookie>UINT64_C(9007199254740991));
  CHECK(!memmem(pm.address,pm.address_size,o.capability,32));
  unsigned char again[112]={0};memcpy(again,"TKOBIND1",8);memcpy(again+8,CLAIM,64);
  ocipp_put64(again+72,1);memset(again+80,0xa5,32);
  CHECK(ocipp_bootstrap(&o,again,sizeof(again))<0 && pm.sockets==1 && !pm.clones);
  ocipp_host_lost(&o);
  for(int fault=1;fault<=6;fault++){authenticate_frontend(&o,fault);CHECK(!pm.clones && !pm.sent_size);}
  authenticate_frontend(&o,0);
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-read-outcome@1\"}")==0 && !o.replay_required);
  CHECK(ocipp_queue(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))==0 && pm.clones==1);
  CHECK(ocipp_queue(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))<0 && pm.clones==1);
  dispose_fixture(&o);
  prepare_bootstrap(&o);pm.instance_cookie++;
  CHECK(ocipp_first_create(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))<0 && !pm.clones);
  dispose_fixture(&o);
  prepare_bootstrap(&o);o.generation=2;
  CHECK(ocipp_first_create(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))<0 && o.create_attempt && !pm.clones);
  dispose_fixture(&o);
  prepare_bootstrap(&o);pm.bind_error=1; /* fresh new record, original endpoint remains exclusive */
  struct ocipp_owner other={0};CHECK(ocipp_bootstrap(&other,again,sizeof(again))<0 && !other.bound && !pm.clones);
  free(other.incoming);free(other.frontend_input);free(other.management_output);free(other.captured[0]);free(other.captured[1]);
  dispose_fixture(&o);
}
static void reconnect_outcome_and_effects(void) {
  static const unsigned char reply[]={0,0,0,2,'{','}'};
  struct ocipp_owner o;prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0 && ocipp_flush_input(&o)==0);
  pm.stream[0]=reply;pm.stream_size[0]=sizeof(reply);
  CHECK(ocipp_drain(&o,0)==1 && ocipp_parse_reply(&o)==0);
  pm.host_epipe=1;CHECK(ocipp_forward(&o,0)<0 && o.host_lost && o.delivery_unknown);
  unsigned int writes=pm.writes;size_t issued=o.issued_size;
  authenticate_frontend(&o,0);
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-read-outcome@1\"}")==0);
  CHECK(!o.awaiting && !o.replay_required && o.delivery_unknown && o.effects==(1u<<TNS_OCIP_CREATE));
  CHECK(pm.writes==writes && o.issued_size==issued && pm.clones==1);
  CHECK(pm.frontend_sent_size>sizeof(reply) && !memcmp(pm.frontend_sent+pm.frontend_sent_size-sizeof(reply),reply,sizeof(reply)));
  pm.frontend_sent_size=0;
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-start@1\"}")==0 && o.pending);
  CHECK(ocipp_flush_input(&o)==0 && pm.clones==1 && o.effects&(1u<<TNS_OCIP_START));
  /* Repeat START cannot resend even when the preceding delivery became unknown. */
  ocipp_host_lost(&o);authenticate_frontend(&o,0);
  writes=pm.writes;CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-start@1\"}")<0 && o.reply_unknown && pm.writes==writes);
  CHECK(!pm.closes[71] && pm.clones==1);dispose_fixture(&o);
}
static void authenticated_result_reader(void) {
  for(int fault=0;fault<4;++fault) {
    struct ocipp_owner o;prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0);
    pm.wait_kind=fault==2?2:fault==3?4:1;CHECK(ocipp_wait(&o)==(fault==3?-1:0));
    pm.eof[0]=1;CHECK(ocipp_drain(&o,0)==0);
    if(fault!=1){pm.eof[1]=1;CHECK(ocipp_drain(&o,1)==0);}
    ocipp_host_lost(&o);authenticate_frontend(&o,0);unsigned int waits=pm.waits;
    CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-read-result@1\"}")==0);
    CHECK(pm.waits==waits && pm.clones==1 && !pm.closes[71]);
    const char *kind=fault?"linux-oci-parent-h-result-refused@1":"linux-oci-parent-h-exited@1";
    CHECK(memmem(pm.frontend_sent,pm.frontend_sent_size,kind,strlen(kind)));
    CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-read-result@1\"}")==0 && pm.waits==waits);
    dispose_fixture(&o);
  }
}
static void replay_delivery_loss(void) {
  static const unsigned char reply[]={0,0,0,2,'{','}'};
  struct ocipp_owner o;prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0 && ocipp_flush_input(&o)==0);
  pm.stream[0]=reply;pm.stream_size[0]=sizeof(reply);
  CHECK(ocipp_drain(&o,0)==1 && ocipp_parse_reply(&o)==0);ocipp_host_lost(&o);
  authenticate_frontend(&o,0);
  const char body[]="{\"kind\":\"linux-oci-parent-read-outcome@1\"}";
  unsigned char frame[128];size_t n=frame_bytes(frame,body);
  pm.frontend_bytes=frame;pm.frontend_size=n;pm.frontend_at=0;pm.frontend_chunk=0;
  CHECK(ocipp_frontend_read(&o)==0 && ocipp_frontend_read(&o)==0 && o.management_resume);
  pm.frontend_write_chunk=2;CHECK(ocipp_management_flush(&o)==0 && o.awaiting);
  pm.frontend_epipe=1;CHECK(ocipp_management_flush(&o)<0 && o.host_lost && o.awaiting);
  pm.frontend_write_chunk=0;pm.frontend_sent_size=0;
  authenticate_frontend(&o,0);CHECK(o.awaiting && o.reply_ready && !o.management_resume);
  /* Auth ACK cannot complete a previously interrupted original reply delivery. */
  unsigned int writes=pm.writes;
  CHECK(frontend_command(&o,body)==0 && !o.awaiting && o.delivery_unknown && pm.writes==writes);
  CHECK(pm.clones==1 && o.effects==(1u<<TNS_OCIP_CREATE));dispose_fixture(&o);
}
static void unsent_resume_is_explicit(void) {
  struct ocipp_owner o;prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0);
  ocipp_host_lost(&o);CHECK(o.input_paused && !o.incoming_sent);
  authenticate_frontend(&o,0);
  CHECK(ocipp_step(&o)<0 && ocipp_flush_input(&o)==0 && !pm.sent_size);
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-read-outcome@1\"}")==0);
  CHECK(!o.replay_required && o.input_paused && ocipp_step(&o)<0 && ocipp_flush_input(&o)==0 && !pm.sent_size);
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-continue-frame@1\"}")==0 && !o.input_paused);
  CHECK(ocipp_step(&o)<0 && pm.sent_size==o.create_size && pm.clones==1);
  dispose_fixture(&o);
}
static void partial_loss_and_readonly(void) {
  static const unsigned char reply[]={0,0,0,2,'{','}'};
  struct ocipp_owner o;prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0 && ocipp_flush_input(&o)==0);
  pm.stream[0]=reply;pm.stream_size[0]=sizeof(reply);
  CHECK(ocipp_drain(&o,0)==1 && ocipp_parse_reply(&o)==0);
  ocipp_host_lost(&o);authenticate_frontend(&o,0);
  unsigned char partial[]={0,0,0,50,'{'};pm.frontend_bytes=partial;pm.frontend_size=sizeof(partial);
  pm.frontend_at=0;pm.frontend_chunk=0;
  CHECK(ocipp_frontend_read(&o)==0 && ocipp_frontend_read(&o)==0 && o.frontend_used==sizeof(partial));
  pm.frontend_eof=1;CHECK(ocipp_frontend_read(&o)<0 && o.reply_unknown && o.host_lost);
  CHECK(!pm.closes[71] && pm.sent_size==o.create_size && pm.clones==1);
  authenticate_frontend(&o,0);unsigned int writes=pm.writes;
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-read-outcome@1\"}")==0 && o.reply_unknown);
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-read-result@1\"}")==0 && o.reply_unknown);
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-start@1\"}")<0 && pm.writes==writes && pm.clones==1);
  dispose_fixture(&o);
  prepare_bootstrap(&o);ocipp_host_lost(&o);
  unsigned char auth[124];auth_bytes(&o,auth);pm.frontend_bytes=auth;pm.frontend_size=9;pm.frontend_at=0;pm.frontend_eof=1;
  CHECK(ocipp_accept(&o)==0 && ocipp_read_authentication(&o)==0 && ocipp_read_authentication(&o)==0);
  CHECK(o.candidate<0 && o.frontend<0 && !pm.clones);dispose_fixture(&o);
}
static void actual_frontend_loop(void) {
  struct ocipp_owner o;prepare_parent(&o,0);CHECK(ocipp_spawn(&o)==0 && pm.clones==1);
  ocipp_host_lost(&o);CHECK(o.input_paused && !o.incoming_sent && !pm.sent_size);
  unsigned char auth[124];auth_bytes(&o,auth);
  pm.frontend_bytes=auth;pm.frontend_size=sizeof(auth);pm.frontend_at=0;pm.frontend_chunk=7;pm.accept_ready=1;
  unsigned int turns=0;
  while(o.frontend<0 || o.management_size!=o.management_sent) {
    CHECK(ocipp_step(&o)<0 && ++turns<40 && !pm.sent_size);
  }
  CHECK(pm.accepts==1 && o.frontend==91 && o.replay_required && o.input_paused);
  const char *requests[]={"{\"kind\":\"linux-oci-parent-read-outcome@1\"}",
    "{\"kind\":\"linux-oci-parent-read-result@1\"}",
    "{\"kind\":\"linux-oci-parent-continue-frame@1\"}"};
  for(unsigned int i=0;i<3;++i) {
    unsigned char frame[128];size_t n=frame_bytes(frame,requests[i]);
    pm.frontend_bytes=frame;pm.frontend_size=n;pm.frontend_at=0;pm.frontend_chunk=9;
    turns=0;
    while(pm.frontend_at<n || o.management_size!=o.management_sent) {
      CHECK(ocipp_step(&o)<0 && ++turns<20);
      if(i<2)CHECK(!pm.sent_size && o.input_paused);
    }
    if(i<2)CHECK(pm.clones==1 && !pm.sent_size);
  }
  if(o.pending)CHECK(ocipp_step(&o)<0);
  CHECK(!o.pending && o.awaiting && !o.input_paused && pm.clones==1);
  CHECK(pm.sent_size==o.create_size && !memcmp(pm.sent,o.create,o.create_size));
  CHECK(o.effects==(1u<<TNS_OCIP_CREATE) && !pm.closes[71]);dispose_fixture(&o);
}
static void authentication_bounds_only(void) {
  const size_t invalid[]={124,125,SIZE_MAX};
  for(unsigned int i=0;i<sizeof(invalid)/sizeof(invalid[0]);++i) {
    struct ocipp_owner o;prepare_bootstrap(&o);ocipp_host_lost(&o);
    CHECK(ocipp_accept(&o)==0 && o.candidate==91);o.authentication_used=invalid[i];
    unsigned int reads=pm.frontend_reads;
    CHECK(ocipp_read_authentication(&o)<0 && errno==EPROTO);
    CHECK(o.candidate<0 && o.frontend<0 && pm.frontend_reads==reads && pm.closes[91]==1);
    CHECK(o.authentication_used==invalid[i] && !pm.clones && !pm.sent_size);dispose_fixture(&o);
  }
  struct ocipp_owner o;prepare_bootstrap(&o);ocipp_host_lost(&o);
  CHECK(ocipp_accept(&o)==0 && o.candidate==91);pm.frontend_oversize=1;
  CHECK(ocipp_read_authentication(&o)<0 && errno==EPROTO);
  CHECK(o.candidate<0 && o.frontend<0 && !o.authentication_used && pm.frontend_reads==1);
  CHECK(pm.closes[91]==1 && !pm.clones && !pm.sent_size);dispose_fixture(&o);
}
static void prepare_peer_parent(struct ocipp_owner *o) {
  memset(&pm,0,sizeof(pm));ocipp_interrupted=0;pm.sent=calloc(1,TNS_OCI_MAX_JSON+4);
  pm.frontend_sent=calloc(1,TNS_OCI_MAX_JSON+1024);CHECK(pm.sent && pm.frontend_sent);
  pm.instance_cookie=UINT64_C(0xfedcba9876543210);pm.self_inode=pm.peer_inode=UINT64_C(0x1000000000000123);
  memset(o,0,sizeof(*o));unsigned char body[112];memcpy(body,"TKOBIND2",8);memcpy(body+8,CLAIM,64);
  ocipp_put64(body+72,1);memset(body+80,0xa5,32);
  CHECK(ocipp_peer_bootstrap(o,body,sizeof(body))==0 && pm.self_opens==1 && !pm.clones);
  CHECK(ocipp_peer_bootstrap_reply(o)==0 && pm.delivered_size==144 && !pm.sent_size);
  CHECK(!memcmp(pm.delivered+4,"TKOINFO2",8) && ocipp_u64(pm.delivered+100)==pm.self_inode);
}
static void peer_request(const struct ocipp_owner *o,unsigned char request[172]) {
  memcpy(request,"TKOPEER2",8);memcpy(request+8,o->claim,64);ocipp_put64(request+72,o->generation);
  ocipp_put64(request+80,o->listener_cookie);memcpy(request+88,o->capability,32);
  ocipp_put64(request+120,o->self_device);ocipp_put64(request+128,o->self_inode);memcpy(request+136,o->boot_id,36);
}
static void peer_server_replies(struct ocipp_owner *o,int pending) {
  CHECK(ocipp_first_create(o,(const unsigned char*)valid,(uint32_t)strlen(valid))==0);
  CHECK(ocipp_spawn(o)==0 && ocipp_flush_input(o)==0);pm.wait_kind=1;CHECK(ocipp_wait(o)==0);
  pm.eof[0]=1;CHECK(ocipp_drain(o,0)==0);
  if(!pending){pm.eof[1]=1;CHECK(ocipp_drain(o,1)==0 && ocipp_fact(o)==0);}
  ocipp_host_lost(o);authenticate_frontend(o,0);
  memcpy(pm.connector_reply,o->management_output,o->management_size);pm.connector_size=o->management_size;
  auth_bytes(o,pm.expected_auth);
  CHECK(frontend_command(o,"{\"kind\":\"linux-oci-parent-read-result@1\"}")==0);
  CHECK(pm.connector_size+pm.frontend_sent_size<=sizeof(pm.connector_reply));
  memcpy(pm.connector_reply+pm.connector_size,pm.frontend_sent,pm.frontend_sent_size);pm.connector_size+=pm.frontend_sent_size;
  pm.connector=1;
}
static int model_management_send(const void *bytes,size_t size) {
  CHECK(size>4 && size<256);const unsigned char *frame=bytes;
  CHECK(frame[0]==0 && frame[1]==0 && frame[2]==0 && frame[3]==size-4);
  char command[256];memcpy(command,frame+4,size-4);command[size-4]=0;
  CHECK(!strcmp(command,"{\"kind\":\"linux-oci-parent-read-outcome@1\"}") ||
    !strcmp(command,"{\"kind\":\"linux-oci-stop-init@1\"}") || !strcmp(command,"{\"kind\":\"linux-oci-join-init@1\"}"));
  pm.manage_writes++;pm.frontend_sent_size=0;
  /* Raw process switch: original P has its own controller, not connector PID. */
  pm.connector=0;
  CHECK(frontend_command(pm.manage_owner,command)==0);
  if(pm.manage_owner->pending){
    CHECK(ocipp_step(pm.manage_owner)<0 && !pm.manage_owner->pending);
    const char *reply=pm.manage_owner->request_kind==TNS_OCIP_STOP_INIT ?
      "{\"kind\":\"linux-oci-init-reaped@1\",\"nativeId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"namespaceDevice\":4,\"namespaceInode\":55,\"pidNamespaceDevice\":6,\"pidNamespaceInode\":77,\"barrier\":\"unproven\"}" :
      "{\"kind\":\"linux-oci-init-reaped-observation@1\",\"nativeId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"namespaceDevice\":4,\"namespaceInode\":55,\"pidNamespaceDevice\":6,\"pidNamespaceInode\":77,\"barrier\":\"unproven\"}";
    pm.stream_size[0]=frame_bytes(pm.manage_h_reply,reply);pm.stream[0]=pm.manage_h_reply;pm.stream_at[0]=0;
    CHECK(ocipp_step(pm.manage_owner)<0 && !pm.manage_owner->awaiting);
  }
  CHECK(pm.connector_size+pm.frontend_sent_size<=sizeof(pm.connector_reply));
  memcpy(pm.connector_reply+pm.connector_size,pm.frontend_sent,pm.frontend_sent_size);pm.connector_size+=pm.frontend_sent_size;
  pm.connector=1;
  return (int)size;
}
static void peer_management_only(void) {
  struct ocipp_owner o;prepare_peer_parent(&o);unsigned char request[172];peer_request(&o,request);
  CHECK(ocipp_first_create(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))==0);
  CHECK(ocipp_spawn(&o)==0 && ocipp_flush_input(&o)==0);pm.delivered_size=0;
  static const char created[]="{\"kind\":\"linux-oci-created-stopped@1\",\"nativeId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"namespaceDevice\":4,\"namespaceInode\":55,\"barrier\":\"unproven\"}";
  pm.stream_size[0]=frame_bytes(pm.manage_h_reply,created);pm.stream[0]=pm.manage_h_reply;pm.stream_at[0]=0;
  CHECK(ocipp_step(&o)<0 && !o.awaiting);ocipp_host_lost(&o);authenticate_frontend(&o,0);
  memcpy(pm.connector_reply,o.management_output,o.management_size);pm.connector_size=o.management_size;
  auth_bytes(&o,pm.expected_auth);pm.connector=pm.manage_mode=1;pm.manage_owner=&o;
  struct ocipp_connector c={0};unsigned char reply[512];size_t size=0;
  CHECK(ocipp_connector_open(&c,request,sizeof(request))==0 && pm.cap_writes==1);
  unsigned int writes=pm.writes,clones=pm.clones;
  CHECK(ocipp_connector_init(&c,(const unsigned char*)"{\"kind\":\"linux-oci-stop-init@1\"}",strlen("{\"kind\":\"linux-oci-stop-init@1\"}"),reply,&size)<0 && !pm.manage_writes);
  CHECK(ocipp_connector_outcome(&c,c.deadline)==0 && c.outcome_phase==2);
  CHECK(pm.writes==writes && pm.clones==clones && pm.manage_writes==1);
  CHECK(memmem(pm.manage_output,pm.manage_output_size,"linux-oci-parent-outcome@1",25));
  CHECK(ocipp_connector_outcome(&c,c.deadline)<0 && pm.manage_writes==1);
  static const char stop[]="{\"kind\":\"linux-oci-stop-init@1\"}";
  CHECK(ocipp_connector_init(&c,(const unsigned char*)stop,strlen(stop),reply,&size)==0 && c.init_attempt);
  CHECK(o.effects&(1u<<TNS_OCIP_STOP_INIT));CHECK(pm.writes==writes+1 && pm.clones==clones);
  CHECK(ocipp_connector_init(&c,(const unsigned char*)stop,strlen(stop),reply,&size)<0 && pm.writes==writes+1);
  CHECK(ocipp_queue(&o,(const unsigned char*)stop,(uint32_t)strlen(stop))<0);
  CHECK(ocipp_connector_close(&c)==0);ocipp_connector_free(&c);pm.connector=0;
  CHECK(ocipp_close(&o,&o.self_pidfd)==0);dispose_fixture(&o);
  const char *bad[]={"{}","{\"kind\":\"linux-oci-parent-outcome@1\",\"requestKind\":00}","{\"kind\":\"linux-oci-parent-outcome@1\",\"requestKind\":999999999999999999999999999999}"};
  for(size_t i=0;i<sizeof(bad)/sizeof(bad[0]);++i){size_t amount=0;CHECK(ocipp_connector_outcome_size((const unsigned char*)bad[i],strlen(bad[i]),&amount)<0);}
}
static void peer_instance_only(void) {
  for(int pending=0;pending<2;++pending){
    struct ocipp_owner o;prepare_peer_parent(&o);unsigned char request[172];peer_request(&o,request);peer_server_replies(&o,pending);
    unsigned int waits=pm.waits,clones=pm.clones;struct ocipp_connector c={0};unsigned char reply[512];size_t size=0;
    CHECK(ocipp_connector_read(&c,request,sizeof(request),reply,&size)==0);
    CHECK(pm.cap_writes==1 && pm.readonly_writes==1 && pm.peer_gets==1 && pm.self_opens==1);
    CHECK(memmem(reply,size,pending?"result-refused":"h-exited",pending?14:8));
    CHECK(pm.waits==waits && pm.clones==clones && !pm.closes[71]);
    CHECK(ocipp_connector_read(&c,request,sizeof(request),reply,&size)<0 && pm.cap_writes==1);
    CHECK(ocipp_connector_close(&c)==0 && pm.closes[92]==1 && pm.closes[90]==1);
    CHECK(ocipp_connector_close(&c)==0 && pm.closes[92]==1 && pm.closes[90]==1);
    ocipp_connector_free(&c);pm.connector=0;CHECK(ocipp_close(&o,&o.self_pidfd)==0);dispose_fixture(&o);
  }
  for(int fault=1;fault<=8;++fault){
    struct ocipp_owner o;prepare_peer_parent(&o);unsigned char request[172];peer_request(&o,request);pm.connector=1;
    if(fault==1)pm.peer_inode++; /* Same numeric peer/name, different struct pid inode. */
    if(fault==2)pm.boot_other=1;
    if(fault==3)pm.pidfd_unsupported=1;
    if(fault==4)pm.pidfd_short=1;
    if(fault==5)pm.old_pidfs=1;
    if(fault==6)pm.peer_dead=1;
    if(fault==7)pm.boot_short=1;
    if(fault==8){pm.executable_stats=0;pm.tamper_after=1;}
    struct ocipp_connector c={0};unsigned char reply[512];size_t size=0;
    CHECK(ocipp_connector_read(&c,request,sizeof(request),reply,&size)<0 && !pm.cap_writes && !pm.readonly_writes);
    if(c.custody.controller==parent_getpid())CHECK(ocipp_connector_close(&c)==0);
    CHECK(pm.closes[92]<=1 && pm.closes[90]<=1 && !pm.clones && !pm.sent_size);
    ocipp_connector_free(&c);pm.connector=0;CHECK(ocipp_close(&o,&o.self_pidfd)==0);dispose_fixture(&o);
  }
  struct ocipp_owner o;prepare_peer_parent(&o);unsigned char request[172];peer_request(&o,request);peer_server_replies(&o,0);
  struct ocipp_connector c={0};unsigned char reply[512];size_t size=0;CHECK(ocipp_connector_read(&c,request,sizeof(request),reply,&size)==0);
  pm.close_fault=92;CHECK(ocipp_connector_close(&c)<0 && c.custody.close_unknown && c.peer_pidfd==-1);
  CHECK(ocipp_connector_close(&c)<0 && pm.closes[92]==1 && pm.closes[90]==1);ocipp_connector_free(&c);
  pm.connector=0;CHECK(ocipp_close(&o,&o.self_pidfd)==0);dispose_fixture(&o);
}
int main(int argc,char **argv) {
  if(argc==2 && !strcmp(argv[1],"peer-management")){peer_management_only();printf("new peer management only: %lu checks\n",checks);return 0;}
  if(argc==2 && !strcmp(argv[1],"peer-instance")){peer_instance_only();printf("new peer-instance only: %lu checks\n",checks);return 0;}
  if(argc==2 && !strcmp(argv[1],"authentication-bounds")) {
    authentication_bounds_only();printf("new authentication bounds only: %lu checks\n",checks);return 0;
  }
  wait_and_eof();refusal_cases();host_loss_and_delivery();readiness_and_child();
  bootstrap_and_authentication();reconnect_outcome_and_effects();authenticated_result_reader();replay_delivery_loss();unsent_resume_is_explicit();partial_loss_and_readonly();actual_frontend_loop();
  printf("new actual authenticated-parent raw boundary: %lu checks\n",checks);return 0;
}
