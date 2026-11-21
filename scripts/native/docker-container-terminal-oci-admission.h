#ifndef DOCKER_CONTAINER_TERMINAL_OCI_ADMISSION_H
#define DOCKER_CONTAINER_TERMINAL_OCI_ADMISSION_H
/* Private original-owner transition. No caller script/target/policy witness or
 * coverage flag is accepted. An ACK never grants serving or terminal. */
struct oci_admission_owner {
  struct tns_oci_owner *original;
  unsigned int attempted[3],wait_attempted[3],joined[3],ok[3],killed[3];
  pid_t pid[3];
  int pidfd[3],incoming[3],outgoing[3],close_unknown,finished,open_acknowledged;
};
static const char oci_admission_drop_script[]="delete table inet " OCI_EGRESS_TABLE "\n";
static int oci_admission_cut(struct tns_oci_owner *o) {
  if (!o || !o->birth) return 0;
  return tns_owner_cut_admission(o->birth);
}
static int oci_admission_observable(struct tns_oci_owner *o) {
  if(!o || !o->policy)return 0;
  if(!o->admission || o->admission->original!=o || !o->admission->finished ||
      !o->admission_ruleset_reads){errno=EAGAIN;return -1;}
  return tns_owner_admission_current(o->birth);
}
static int oci_admission_original(struct oci_admission_owner *a) {
  struct tns_oci_owner *o=a?a->original:NULL;
  if (!o || o->admission!=a || o->controller_pid!=getpid() || o->invalid ||
      !o->policy || !o->policy->verified || a->close_unknown ||
      !o->start_attempt || !o->start_joined || !o->start_ok ||
      (a->open_acknowledged && tns_owner_admission_current(o->birth)<0) ||
      oci_egress_original(o)<0 || oci_private_init_current(o)<0) {
    if (!errno) errno=ESTALE;
    return -1;
  }
  return oci_not_canceled();
}
static int oci_admission_close_fd(struct oci_admission_owner *a,int *slot) {
  if (*slot<0) return 0;
  int fd=*slot;*slot=-1;
  if (close(fd)<0) {a->close_unknown=1;return -1;}
  return 0;
}
static int oci_admission_join(struct oci_admission_owner *a,unsigned int stage,int timeout) {
  if (!a->pid[stage] || a->joined[stage]) return 0;
  if (a->wait_attempted[stage]) {errno=EUCLEAN;return -1;}
  struct pollfd p={.fd=a->pidfd[stage],.events=POLLIN};
  int n=poll(&p,1,timeout);
  if (n!=1 || p.revents!=POLLIN) {if(!errno)errno=n?EPROTO:ETIMEDOUT;return -1;}
  siginfo_t info;memset(&info,0,sizeof(info));a->wait_attempted[stage]=1;
  if (waitid(P_PIDFD,(id_t)a->pidfd[stage],&info,WEXITED|WNOHANG)<0 ||
      info.si_pid!=a->pid[stage] ||
      (info.si_code!=CLD_EXITED && info.si_code!=CLD_KILLED && info.si_code!=CLD_DUMPED)) {
    if(!errno)errno=EPROTO;
    return -1;
  }
  a->joined[stage]=1;a->ok[stage]=info.si_code==CLD_EXITED && !info.si_status;
  return 0;
}
static _Noreturn void oci_admission_child(struct oci_admission_owner *a,unsigned int stage,int input,int output) {
  struct tns_oci_owner *o=a->original;
  int executable=fcntl(o->egress_binary,F_DUPFD_CLOEXEC,10);
  int network=fcntl(o->network,F_DUPFD_CLOEXEC,10);
  int incoming=fcntl(input,F_DUPFD_CLOEXEC,10),outgoing=fcntl(output,F_DUPFD_CLOEXEC,10);
  if (executable<0 || network<0 || incoming<0 || outgoing<0 || dup3(executable,3,O_CLOEXEC)<0 ||
      dup3(network,4,O_CLOEXEC)<0 || dup2(incoming,0)!=0 || dup2(outgoing,1)!=1 ||
      syscall(SYS_close_range,2u,2u,0u)<0 || syscall(SYS_close_range,5u,UINT_MAX,0u)<0 ||
      prctl(PR_SET_PDEATHSIG,SIGKILL)<0 || getppid()!=o->controller_pid) _exit(125);
  struct stat st;struct statfs fs;
  if (fstat(4,&st)<0 || fstatfs(4,&fs)<0 || (unsigned long)fs.f_type!=(unsigned long)NSFS_MAGIC ||
      ioctl(4,NS_GET_NSTYPE)!=CLONE_NEWNET || (uint64_t)st.st_dev!=o->identity.device ||
      (uint64_t)st.st_ino!=o->identity.inode || setns(4,CLONE_NEWNET)<0 || close(4)<0) _exit(125);
  int null=open("/dev/null",O_WRONLY|O_CLOEXEC|O_NOFOLLOW);
  if (null!=2 || fstat(null,&st)<0 || !S_ISCHR(st.st_mode) || major(st.st_rdev)!=1 || minor(st.st_rdev)!=3) _exit(125);
  for(int fd=0;fd<3;fd++) {int flags=fcntl(fd,F_GETFL);if(flags<0 || fcntl(fd,F_SETFL,flags&~O_NONBLOCK)<0 || fcntl(fd,F_SETFD,0)<0)_exit(125);}
  char *const before[]={"nft","-j","list","table","inet",OCI_EGRESS_TABLE,NULL};
  char *const apply[]={"nft","-f","-",NULL};
  char *const after[]={"nft","-j","list","ruleset",NULL};
  char *const environment[]={"PATH=/usr/sbin:/usr/bin:/sbin:/bin",NULL};
  char *const *argv=stage==0?before:stage==1?apply:stage==2?after:NULL;
  if(!argv)_exit(125);
  umask(077);syscall(SYS_execveat,3,"",argv,environment,AT_EMPTY_PATH);_exit(125);
}
static int oci_admission_command(struct oci_admission_owner *a,unsigned int stage,int64_t deadline,char *output,size_t *used) {
  if(stage>=3 || tns_oci_once(&a->attempted[stage])<0 || (stage && !a->ok[stage-1]) ||
      oci_admission_original(a)<0 || oci_egress_left(deadline)<0)return -1;
  int in[2],out[2];
  if(pipe2(in,O_CLOEXEC|O_NONBLOCK)<0)return -1;
  a->incoming[stage]=in[1];
  if(pipe2(out,O_CLOEXEC|O_NONBLOCK)<0){(void)oci_admission_close_fd(a,&in[0]);return -1;}
  a->outgoing[stage]=out[0];
  struct clone_args args;memset(&args,0,sizeof(args));args.flags=CLONE_PIDFD|CLONE_CLEAR_SIGHAND;
  args.exit_signal=SIGCHLD;args.pidfd=(uint64_t)(uintptr_t)&a->pidfd[stage];
  long child=syscall(SYS_clone3,&args,sizeof(args));
  if(!child)oci_admission_child(a,stage,in[0],out[1]);
  if(child>0)a->pid[stage]=(pid_t)child;
  int failed=oci_admission_close_fd(a,&in[0])<0;
  if(oci_admission_close_fd(a,&out[1])<0)failed=1;
  if(child<0 || failed || oci_admission_original(a)<0)return -1;
  size_t at=0,size=stage==1?sizeof(oci_admission_drop_script)-1:0;
  while(at<size){int left=oci_egress_left(deadline);struct pollfd fd={.fd=a->incoming[stage],.events=POLLOUT};
    if(left<0 || oci_not_canceled()<0 || poll(&fd,1,left)!=1 || fd.revents!=POLLOUT)return -1;
    ssize_t n=write(a->incoming[stage],oci_admission_drop_script+at,size-at);if(n<=0)return -1;at+=(size_t)n;
  }
  if(oci_admission_close_fd(a,&a->incoming[stage])<0)return -1;
  *used=0;
  for(;;){int left=oci_egress_left(deadline);struct pollfd fd={.fd=a->outgoing[stage],.events=POLLIN};
    if(left<0 || oci_not_canceled()<0 || poll(&fd,1,left)!=1 ||
        (fd.revents!=POLLIN && fd.revents!=POLLHUP && fd.revents!=(POLLIN|POLLHUP)))return -1;
    ssize_t n=read(a->outgoing[stage],output+*used,OCI_POLICY_JSON_MAX-*used);if(n<0)return -1;if(!n)break;
    *used+=(size_t)n;if(*used==OCI_POLICY_JSON_MAX){errno=EOVERFLOW;return -1;}
  }
  if(oci_admission_close_fd(a,&a->outgoing[stage])<0)return -1;
  int left=oci_egress_left(deadline);
  if(left<0 || oci_admission_join(a,stage,left)<0 || !a->ok[stage] || oci_admission_original(a)<0)return -1;
  return 0;
}
static int oci_admission_stop(struct tns_oci_owner *o) {
  if(!o || !o->admission)return 0;
  struct oci_admission_owner *a=o->admission;
  if(a->original!=o || o->controller_pid!=getpid()){errno=EPERM;return -1;}
  int saved=0;
  for(unsigned int i=0;i<3;i++){
    if(a->pid[i] && !a->joined[i] && !a->killed[i]){a->killed[i]=1;
      if(syscall(SYS_pidfd_send_signal,a->pidfd[i],SIGKILL,NULL,0)<0 && errno!=ESRCH && !saved)saved=errno;
    }
    if(oci_admission_join(a,i,1000)<0 && !saved)saved=errno?errno:EPROTO;
    if(oci_admission_close_fd(a,&a->incoming[i])<0 && !saved)saved=errno;
    if(oci_admission_close_fd(a,&a->outgoing[i])<0 && !saved)saved=errno;
  }
  if(a->close_unknown && !saved)saved=EUCLEAN;
  if(saved){errno=saved;return -1;}return 0;
}
static int oci_admission_close(struct tns_oci_owner *o) {
  if(!o || !o->admission)return 0;
  struct oci_admission_owner *a=o->admission;
  if(a->original!=o || o->controller_pid!=getpid() ||
      (o->command_pid && (!o->init_joined || !o->init_custody || !o->init_stop_attempt ||
       !o->command_joined || !o->command_ok || (o->start_pid && !o->start_joined)))){errno=EBUSY;return -1;}
  if(oci_admission_cut(o)<0 || oci_admission_stop(o)<0)return -1;
  for(unsigned int i=0;i<3;i++){
    if(a->pid[i] && !a->joined[i]){errno=EUCLEAN;return -1;}
    if(oci_admission_close_fd(a,&a->pidfd[i])<0)return -1;
  }
  if(a->close_unknown){errno=EUCLEAN;return -1;}
  explicit_bzero(a,sizeof(*a));free(a);o->admission=NULL;return 0;
}
static int oci_admission_open(struct tns_oci_owner *o) {
  if(!o || !o->policy)return 0; /* Legacy remains kernel denied. */
  if(tns_oci_once(&o->admission_attempt)<0){errno=EALREADY;return -1;}
  struct oci_admission_owner *a=calloc(1,sizeof(*a));
  if(!a)goto fail;
  a->original=o;o->admission=a;
  for(unsigned int i=0;i<3;i++)a->pidfd[i]=a->incoming[i]=a->outgoing[i]=-1;
  char *output=malloc(OCI_POLICY_JSON_MAX);if(!output)goto fail;
  size_t used=0;int result=-1;int64_t now=oci_now();
  if(now<0 || oci_admission_original(a)<0 || oci_policy_runtime_current(o)<0)goto done;
  int64_t deadline=now+10000;
  if(oci_admission_command(a,0,deadline,output,&used)<0 || oci_egress_readback(output,used)<0 ||
      oci_policy_runtime_current(o)<0 || oci_not_canceled()<0 || tns_owner_open_admission(o->birth)<0)goto done;
  a->open_acknowledged=1;
  if(oci_policy_runtime_current(o)<0 || oci_admission_command(a,1,deadline,output,&used)<0 || used ||
      oci_admission_command(a,2,deadline,output,&used)<0 || oci_policy_readback(o->policy,output,used)<0)goto done;
  /* This recorded source phase selects stricter whole-ruleset reads. It does
   * not certify that OPEN remains current or that any packet was admitted. */
  o->admission_ruleset_reads=1;
  if(oci_policy_runtime_current(o)<0 || oci_admission_original(a)<0 || oci_not_canceled()<0)goto done;
  a->finished=1;result=0;
done:
  free(output);
  if(result==0)return 0;
fail: {
  int saved=errno?errno:ESTALE;o->invalid=1;
  int cut=oci_admission_cut(o),cut_error=errno;
  if(oci_admission_stop(o)<0)return -1;
  if(cut<0){errno=cut_error;return -1;}
  errno=saved;return -1;
  }
}
#endif
