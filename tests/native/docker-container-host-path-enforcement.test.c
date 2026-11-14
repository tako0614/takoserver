/* Pure syscall regression: prior admission fixture supplies actual unchanged
 * namespace/OCI/link/driver bodies; its main and cases are never invoked.
 * Repo-only recipe: extract all oci_host_path_* definitions from policy.h plus
 * whole oci_uplink_install/cleanup from uplink.h, in that order, as HOST_BODY.
 * No structs/helpers are copied. cc -std=gnu11 -Wall -Wextra -Werror
 * -Wno-unused-function -DHOST_BODY='"/absolute/actual-host-body.inc"' this.c
 * -fsanitize=address,undefined -fno-omit-frame-pointer -g -o raw; run only raw.
 * The extraction receipt binds exact definitions and original fixture inputs.
 * NONSECRET prepared OCI, synthetic kernel/nft bytes, no real child/netns/IO.
 */
#define main prior_admission_main
#include "docker-container-terminal-oci-admission.test.c"
#undef main
#ifndef HOST_BODY
#error "Extract actual source definitions as documented above and define HOST_BODY"
#endif
static struct {
  unsigned int pipes, spawns, joins[6], signals[6], closes[4000], reads[6], eof[6];
  size_t at[6], sent_size[6];
  char sent[6][8192], output[6][16384];
  size_t size[6];
  int fault, child, stage, execs, entered, ranges, nul, table, deleted;
} hp;
enum { H_COLLISION=1,H_ECHO,H_GET,H_WRONG_WAIT,H_WAIT_ERROR,H_SIGNAL,H_PIPE,
       H_WRITE,H_READ,H_CLOSE,H_CANCEL,H_REPLACED,H_DELETE,H_ABSENCE,H_LINKINDEX,H_HOSTCOOKIE };
static jmp_buf host_child_exit;
static long host_syscall(long number,...);
static int host_pipe(int fd[2],int flags);
static int host_close(int fd);
static int host_poll(struct pollfd *fd,nfds_t count,int timeout);
static int host_wait(idtype_t type,id_t id,siginfo_t *info,int flags);
static ssize_t host_read(int fd,void *out,size_t size);
static ssize_t host_write(int fd,const void *bytes,size_t size);
static int host_fcntl(int fd,int command,...);
static int host_dup3(int fd,int to,int flags);
static int host_dup2(int fd,int to);
static int host_stat(int fd,struct stat *st);
static int host_fs(int fd,struct statfs *fs);
static int host_ioctl(int fd,unsigned long request,...);
static int host_setns(int fd,int kind);
static int host_open(const char *path,int flags,...);
static int host_prctl(int option,...);
static pid_t host_ppid(void);
static mode_t host_umask(mode_t mask);
static _Noreturn void host_exit(int code);
#define oci_uplink_driver_link measured_driver_link
#define oci_host_path_current measured_current
#define oci_host_path_program measured_program
#define oci_host_path_readback measured_readback
#define oci_host_path_tables measured_tables
#define oci_host_path_close_fd measured_close_fd
#define oci_host_path_join measured_join
#define oci_host_path_child measured_child
#define oci_host_path_command measured_command
#define oci_host_path_install measured_host_install
#define oci_host_path_close measured_host_close
#define oci_uplink_install measured_install
#define oci_uplink_cleanup measured_cleanup
#define syscall host_syscall
#define pipe2 host_pipe
#define close host_close
#define poll host_poll
#define waitid host_wait
#define read host_read
#define write host_write
#define getpid raw_getpid
#define geteuid raw_geteuid
#define fcntl host_fcntl
#define dup2 host_dup2
#define dup3 host_dup3
#define fstat host_stat
#define fstatfs host_fs
#define ioctl host_ioctl
#define setns host_setns
#define open host_open
#define prctl host_prctl
#define getppid host_ppid
#define umask host_umask
#define _exit host_exit
#include HOST_BODY
#undef syscall
#undef pipe2
#undef close
#undef poll
#undef waitid
#undef read
#undef write
#undef getpid
#undef geteuid
#undef fcntl
#undef dup2
#undef dup3
#undef fstat
#undef fstatfs
#undef ioctl
#undef setns
#undef open
#undef prctl
#undef getppid
#undef umask
#undef _exit

/* Independent v1.1.1 output shape: ifindex's actual datatype printer returns
 * names while links exist; list-tables cleanup has no interface expression. */
static void output_stage(unsigned int stage) {
  struct oci_host_path_owner *p=subject->host_path;
  char *out=hp.output[stage];size_t at=0;
  if(stage==0 || stage==4){out[0]=0;hp.size[stage]=0;return;}
  int n=snprintf(out,16384,"{\"nftables\":[{\"metainfo\":{\"version\":\"1.1.1\",\"release_name\":\"raw\",\"json_schema_version\":1}}");
  CHECK(n>0);at=(size_t)n;
  if(stage==5 && hp.fault!=H_ABSENCE)goto finish;
  unsigned long long handle=(hp.fault==H_REPLACED && stage==3)?7002ULL:7001ULL;
  n=snprintf(out+at,16384-at,",%s{\"table\":{\"family\":\"inet\",\"name\":\"%s\",\"handle\":%llu,\"flags\":[]}}%s",
    stage==1?"{\"create\":" : "",p->table,handle,stage==1?"}":"");CHECK(n>0);at+=(size_t)n;
  if(stage>=3)goto finish;
  n=snprintf(out+at,16384-at,",%s{\"chain\":{\"family\":\"inet\",\"table\":\"%s\",\"name\":\"forward\",\"handle\":11,\"type\":\"filter\",\"hook\":\"forward\",\"prio\":0,\"policy\":\"accept\"}}%s",stage==1?"{\"add\":" : "",p->table,stage==1?"}":"");CHECK(n>0);at+=(size_t)n;
  for(unsigned int i=0;i<6;i++){
    const char *a=i<3?"iif":"oif";
    const char *b=i==0?"iifname":i==1?"oif":i==2?"oifname":i==3?"oifname":i==4?"iif":"iifname";
    const char *value=i==0||i==3?p->host_name:p->uplink_name;
    n=snprintf(out+at,16384-at,",%s{\"rule\":{\"family\":\"inet\",\"table\":\"%s\",\"chain\":\"forward\",\"handle\":%u,\"expr\":[{\"match\":{\"op\":\"==\",\"left\":{\"meta\":{\"key\":\"%s\"}},\"right\":\"%s\"}},{\"match\":{\"op\":\"!=\",\"left\":{\"meta\":{\"key\":\"%s\"}},\"right\":\"%s\"}},{\"drop\":null}],\"comment\":\"host_path_%u\"}}%s",stage==1?"{\"add\":" : "",p->table,20+i,a,p->host_name,b,value,i,stage==1?"}":"");CHECK(n>0);at+=(size_t)n;
  }
finish:
  CHECK(at+3<16384);memcpy(out+at,"]}",3);at+=2;hp.size[stage]=at;
  if((hp.fault==H_ECHO && stage==1)||(hp.fault==H_GET && stage==2))out[at-1]='x';
}
static long host_syscall(long number,...) {
  va_list ap;va_start(ap,number);
  if(number==SYS_clone3){
    struct clone_args *a=va_arg(ap,struct clone_args*);CHECK(va_arg(ap,size_t)==sizeof(*a));va_end(ap);
    struct oci_host_path_owner *p=subject->host_path;CHECK(p && lock_taken);
    unsigned int stage=0;while(stage<6 && a->pidfd!=(uint64_t)(uintptr_t)&p->pidfd[stage])stage++;
    CHECK(stage<6 && hp.spawns==stage && p->attempted[stage] && !p->pid[stage]);
    CHECK(a->flags==(CLONE_PIDFD|CLONE_CLEAR_SIGHAND) && a->exit_signal==SIGCHLD);
    CHECK(stage>=3?up.removed:(!up.up[0]&&!up.up[1]));
    CHECK(hp.pipes==2*(stage+1));*(int*)(uintptr_t)a->pidfd=3000+(int)stage;
    output_stage(stage);hp.spawns++;return 60000+(long)stage;
  }
  if(number==SYS_pidfd_send_signal){int fd=va_arg(ap,int);CHECK(fd>=3000 && fd<3006 && va_arg(ap,int)==SIGKILL);va_end(ap);CHECK(!hp.signals[fd-3000]++);return 0;}
  if(number==SYS_close_range){unsigned int a=va_arg(ap,unsigned int),b=va_arg(ap,unsigned int);CHECK(hp.child && va_arg(ap,unsigned int)==0 && ((a==2 && b==2)||(a==5 && b==UINT_MAX)));va_end(ap);hp.ranges|=a==2?1:2;return 0;}
  CHECK(number==SYS_execveat && hp.child);CHECK(va_arg(ap,int)==3 && !strcmp(va_arg(ap,char*),""));
  char *const *args=va_arg(ap,char*const*),*const *env=va_arg(ap,char*const*);CHECK(va_arg(ap,int)==AT_EMPTY_PATH);va_end(ap);
  CHECK(hp.entered && hp.ranges==3 && hp.nul && !strcmp(args[0],"nft"));
  CHECK(!strcmp(env[0],"PATH=/usr/sbin:/usr/bin:/sbin:/bin") && !env[1]);
  if(hp.stage==0)CHECK(!strcmp(args[1],"-c") && !strcmp(args[2],"-f") && !strcmp(args[3],"-") && !args[4]);
  else if(hp.stage==1)CHECK(!strcmp(args[1],"-j") && !strcmp(args[2],"-a") && !strcmp(args[3],"-n") && !strcmp(args[4],"-e") && !strcmp(args[5],"-f") && !strcmp(args[6],"-") && !args[7]);
  else if(hp.stage==2)CHECK(!strcmp(args[1],"-j") && !strcmp(args[2],"-a") && !strcmp(args[3],"-n") && !strcmp(args[4],"list") && !strcmp(args[5],"table") && !strcmp(args[6],"inet") && !strcmp(args[7],subject->host_path->table) && !args[8]);
  else if(hp.stage==4)CHECK(!strcmp(args[1],"-f") && !strcmp(args[2],"-") && !args[3]);
  else CHECK(!strcmp(args[1],"-j") && !strcmp(args[2],"-a") && !strcmp(args[3],"-n") && !strcmp(args[4],"list") && !strcmp(args[5],"tables") && !args[6]);
  hp.execs++;longjmp(host_child_exit,1);
}
static int host_pipe(int fd[2],int flags){CHECK(flags==(O_CLOEXEC|O_NONBLOCK));if(hp.fault==H_PIPE && hp.pipes==2){errno=EMFILE;return -1;}CHECK(hp.pipes<12);fd[0]=2000+(int)hp.pipes*2;fd[1]=fd[0]+1;hp.pipes++;return 0;}
static int host_close(int fd){
  if(hp.child){CHECK(fd==4 && hp.entered);return 0;}
  if(fd<2000)return raw_close(fd);
  CHECK(fd<4000 && !hp.closes[fd]++);
  if(hp.fault==H_CLOSE && fd==2005){errno=EINTR;return -1;}return 0;
}
static int host_poll(struct pollfd *p,nfds_t count,int timeout){if(p->fd<2000)return raw_poll(p,count,timeout);CHECK(count==1 && timeout>0);p->revents=p->events;return 1;}
static int host_wait(idtype_t type,id_t id,siginfo_t *info,int flags){
  if(id<3000)return raw_waitid(type,id,info,flags);
  CHECK(id<3006 && type==P_PIDFD && flags==(WEXITED|WNOHANG));unsigned int i=id-3000;CHECK(!hp.joins[i]++ && hp.eof[i]);
  if(hp.fault==H_WAIT_ERROR && i==1){errno=ECHILD;return -1;}
  info->si_pid=60000+(int)i+(hp.fault==H_WRONG_WAIT && i==1);info->si_code=hp.fault==H_SIGNAL&&i==1?CLD_KILLED:CLD_EXITED;
  info->si_status=(hp.fault==H_COLLISION&&i==1)||(hp.fault==H_DELETE&&i==4)?1:0;return 0;
}
static ssize_t host_write(int fd,const void *bytes,size_t size){
  CHECK(fd>=2000 && fd<2024 && (fd-2000)%4==1);unsigned int i=(unsigned int)(fd-2000)/4;
  if(hp.fault==H_WRITE && i==1){errno=EPIPE;return -1;}size_t n=size>31?31:size;CHECK(hp.sent_size[i]+n<8192);
  memcpy(hp.sent[i]+hp.sent_size[i],bytes,n);hp.sent_size[i]+=n;
  if(hp.fault==H_CANCEL && i==1)oci_cancel_requested=1;
  if(hp.fault==H_HOSTCOOKIE && i==1)subject->host_cookie++;
  return (ssize_t)n;
}
static ssize_t host_read(int fd,void *bytes,size_t size){
  CHECK(fd>=2000 && fd<2024 && (fd-2000)%4==2);unsigned int i=(unsigned int)(fd-2000)/4;hp.reads[i]++;
  if(hp.fault==H_READ && i==1){errno=EIO;return -1;}
  size_t n=hp.size[i]-hp.at[i];if(n>size)n=size;if(n>43)n=43;
  memcpy(bytes,hp.output[i]+hp.at[i],n);hp.at[i]+=n;if(!n)hp.eof[i]=1;return (ssize_t)n;
}
static int host_fcntl(int fd,int command,...){va_list ap;va_start(ap,command);CHECK(hp.child);if(command==F_DUPFD_CLOEXEC){CHECK(va_arg(ap,int)==10);va_end(ap);CHECK(fd==EGNFT || fd==121 || fd==2000 || fd==2003);return fd+4000;}if(command==F_GETFL){va_end(ap);CHECK(fd>=0&&fd<3);return O_NONBLOCK;}CHECK((command==F_SETFL||command==F_SETFD)&&va_arg(ap,int)==0);va_end(ap);return 0;}
static int host_dup3(int fd,int to,int flags){CHECK(hp.child && fd>=4000 && (to==3||to==4)&&flags==O_CLOEXEC);return to;}
static int host_dup2(int fd,int to){CHECK(hp.child && fd>=4000 && (to==0||to==1));return to;}
static int host_stat(int fd,struct stat *st){CHECK(hp.child);memset(st,0,sizeof(*st));if(fd==4){st->st_dev=(dev_t)subject->creator.device;st->st_ino=(ino_t)subject->creator.inode;}else{CHECK(fd==2);st->st_mode=S_IFCHR|0600;st->st_rdev=makedev(1,3);}return 0;}
static int host_fs(int fd,struct statfs *fs){CHECK(hp.child && fd==4);memset(fs,0,sizeof(*fs));fs->f_type=NSFS_MAGIC;return 0;}
static int host_ioctl(int fd,unsigned long request,...){
  if(hp.child){CHECK(fd==4 && request==NS_GET_NSTYPE);return CLONE_NEWNET;}
  va_list ap;va_start(ap,request);struct ifreq *in=va_arg(ap,struct ifreq*);va_end(ap);
  int result=raw_ioctl(fd,request,in);
  if(hp.fault==H_LINKINDEX && request==SIOCGIFINDEX)in->ifr_ifindex++;
  return result;
}
static int host_setns(int fd,int kind){CHECK(hp.child && fd==4 && kind==CLONE_NEWNET && hp.ranges==3);hp.entered=1;return 0;}
static int host_open(const char *path,int flags,...){CHECK(hp.child && hp.entered && !strcmp(path,"/dev/null") && flags==(O_WRONLY|O_CLOEXEC|O_NOFOLLOW));hp.nul=1;return 2;}
static int host_prctl(int option,...){CHECK(hp.child && option==PR_SET_PDEATHSIG);return 0;}
static pid_t host_ppid(void){CHECK(hp.child);return 1000;}
static mode_t host_umask(mode_t mask){CHECK(hp.child && mask==077);return 077;}
static _Noreturn void host_exit(int code){CHECK(hp.child);longjmp(host_child_exit,code+100);}
static void fresh(struct tns_oci_owner *o,struct tns_owner *b){memset(&hp,0,sizeof(hp));memset(&pol,0,sizeof(pol));memset(&rt,0,sizeof(rt));memset(&ad,0,sizeof(ad));prepare(o,b);}
/* UNKNOWN fixtures are released only as model memory teardown, not successful
 * product cleanup or authority. Held numerical fds are synthetic model values. */
static void teardown(struct tns_oci_owner *o){if(o->uplink){free(o->uplink->host_path);o->uplink->host_path=NULL;discard(o);}}
/* Interpret only the emitted six elementary FORWARD negative matches. This is
 * script-contract evidence, not Linux packet traversal or TC/onward coverage. */
static int fence_drop(const char *script,unsigned int incoming,unsigned int outgoing,const char *inname,const char *outname){
  unsigned int rules=0;int dropped=0;const char *line=strchr(script,'\n');CHECK(line);line=strchr(line+1,'\n');CHECK(line);
  while(*++line){char table[80],first[16],second[16],value[64];unsigned int index=0,id=99;
    CHECK(sscanf(line,"add rule inet %79s forward meta %15s %u meta %15s != %63s drop comment \"host_path_%u\"",table,first,&index,second,value,&id)==6 && id==rules);
    unsigned int actual=!strcmp(first,"iif")?incoming:outgoing;int mismatch=0;
    if(!strcmp(second,"iif")||!strcmp(second,"oif")){unsigned int desired=0;CHECK(sscanf(value,"%u",&desired)==1);mismatch=(!strcmp(second,"iif")?incoming:outgoing)!=desired;}
    else {size_t n=strlen(value);CHECK(n>2 && value[0]=='"' && value[n-1]=='"');value[n-1]=0;mismatch=strcmp(value+1,!strcmp(second,"iifname")?inname:outname)!=0;}
    if(actual==index && mismatch)dropped=1;
    rules++;line=strchr(line,'\n');CHECK(line);
  }
  CHECK(rules==6);return dropped;
}
static void canonical(void){
  struct tns_oci_owner o;struct tns_owner b;fresh(&o,&b);
  CHECK(measured_install(&o,o.uplink)==0 && o.uplink->configured && hp.spawns==3 && up.up[0]&&up.up[1]);
  struct oci_host_path_owner *p=o.uplink->host_path;CHECK(p && p->verified && p->handle==7001 && !p->unknown);
  CHECK(!strcmp(hp.sent[0],p->script) && !strcmp(hp.sent[1],p->script) && hp.eof[1] && hp.joins[1]==1);
  CHECK(strstr(p->script,"meta iif 50 meta oif != 2 drop") && strstr(p->script,"meta oif 50 meta iif != 2 drop"));
  CHECK(strstr(p->expected,"\"key\":\"iif\"}},\"right\":\"tkh") && !strstr(p->expected,"\"right\":50"));
  CHECK(!fence_drop(p->script,50,2,p->host_name,p->uplink_name));
  CHECK(fence_drop(p->script,50,3,p->host_name,"foreign"));
  CHECK(fence_drop(p->script,50,2,p->host_name,"renamed"));
  CHECK(fence_drop(p->script,50,3,p->host_name,p->uplink_name));
  CHECK(!fence_drop(p->script,2,50,p->uplink_name,p->host_name));
  CHECK(fence_drop(p->script,3,50,"foreign",p->host_name));
  CHECK(fence_drop(p->script,2,50,"renamed",p->host_name));
  CHECK(!fence_drop(p->script,7,8,"unrelated","unrelated"));
  CHECK(measured_install(&o,o.uplink)<0 && hp.spawns==3 && up.creates==1);
  CHECK(measured_cleanup(&o.uplink)==0 && !o.uplink && up.removed && hp.spawns==6);
  CHECK(!strcmp(hp.sent[4],"delete table inet handle 7001\n") && !strstr(hp.sent[4],"tako_host_"));
  for(unsigned int i=0;i<6;i++)CHECK(hp.eof[i]&&hp.joins[i]==1 && hp.closes[3000+i]==1);
  subject=NULL;
}
static void refusal(void){
  struct tns_oci_owner o;struct tns_owner b;
  int faults[]={H_COLLISION,H_ECHO,H_GET,H_WRONG_WAIT,H_WAIT_ERROR,H_SIGNAL,H_PIPE,H_WRITE,H_READ,H_CLOSE,H_CANCEL,H_HOSTCOOKIE};
  for(size_t i=0;i<sizeof(faults)/sizeof(*faults);i++){
    fresh(&o,&b);hp.fault=faults[i];CHECK(measured_install(&o,o.uplink)<0 && !up.up[0]&&!up.up[1]);
    struct oci_host_path_owner *p=o.uplink->host_path;CHECK(p && (p->unknown||p->close_unknown));unsigned int spawned=hp.spawns;
    CHECK(measured_install(&o,o.uplink)<0 && hp.spawns==spawned && up.creates==1);teardown(&o);
  }
  fresh(&o,&b);hp.fault=H_LINKINDEX;CHECK(measured_install(&o,o.uplink)<0 && up.creates==1 && !hp.spawns && !up.up[0]&&!up.up[1]);teardown(&o);
  fresh(&o,&b);model.fault=WRONG_CONTROLLER;CHECK(measured_install(&o,o.uplink)<0 && !up.creates && !hp.spawns);model.fault=NONE;teardown(&o);
  fresh(&o,&b);up.cookie_fault=1;CHECK(measured_install(&o,o.uplink)<0 && !up.creates && !hp.spawns);teardown(&o);
}
static void cleanup_refusal(void){
  struct tns_oci_owner o;struct tns_owner b;
  for(int fault=H_REPLACED;fault<=H_ABSENCE;fault++){
    fresh(&o,&b);CHECK(measured_install(&o,o.uplink)==0);hp.fault=fault;
    CHECK(measured_cleanup(&o.uplink)<0 && o.uplink && o.uplink->host_path && up.removed);
    unsigned int spawns=hp.spawns;CHECK(measured_cleanup(&o.uplink)<0 && hp.spawns==spawns);
    if(fault==H_REPLACED)CHECK(hp.spawns==4 && !hp.sent_size[4]);
    teardown(&o);
  }
  fresh(&o,&b);CHECK(measured_install(&o,o.uplink)==0);up.bad_ack=1;
  CHECK(measured_cleanup(&o.uplink)<0 && hp.spawns==3 && o.uplink->host_path->verified);teardown(&o);
  fresh(&o,&b);CHECK(measured_install(&o,o.uplink)==0);o.command_pid=4000;
  CHECK(measured_cleanup(&o.uplink)<0 && hp.spawns==3 && !up.deletes);
  o.init_joined=o.init_custody=o.init_stop_attempt=1;oci_cancel_requested=1;
  CHECK(measured_cleanup(&o.uplink)==0 && !o.uplink && hp.spawns==6);subject=NULL;
}
static void child_arguments(void){struct tns_oci_owner o;struct tns_owner b;fresh(&o,&b);CHECK(measured_install(&o,o.uplink)==0);hp.child=1;
  for(int i=0;i<6;i++){hp.stage=i;hp.entered=hp.ranges=hp.nul=0;int result=setjmp(host_child_exit);if(!result)measured_child(o.uplink->host_path,(unsigned int)i,2000,2003);CHECK(result==1);}
  CHECK(hp.execs==6);hp.child=0;CHECK(measured_cleanup(&o.uplink)==0);subject=NULL;
}
int main(void){canonical();refusal();cleanup_refusal();child_arguments();printf("%lu checks; actual Host install/cleanup under closed raw models only\n",checks);return 0;}
