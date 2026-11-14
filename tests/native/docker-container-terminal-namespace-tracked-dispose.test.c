#ifndef TRACKED_DISPOSE_RAW_MODEL
#define TRACKED_DISPOSE_RAW_MODEL
/* Reenter this test only at the old model's actual namespace include seam.
 * The previous cohort main/cases compile but are NEVER called. No positive
 * opaque owner factory, actual descriptor or actual syscall is substituted. */
static int td_close(int fd);
static void td_free(void *allocation);
int namespace_dispose_previous_cohort_never_run(void);
#define NAMESPACE_SOURCE "docker-container-terminal-namespace-tracked-dispose.test.c"
#define main namespace_dispose_previous_cohort_never_run
#include "docker-container-terminal-namespace-owner-join.test.c"
#undef main
#undef NAMESPACE_SOURCE

struct td_model {
  int active, failed_fd, no_effect, reused_fd, wrong_after, legacy;
  unsigned int calls[4], order[4], total, frees, reads_before;
  unsigned int ioctl_seq_before, signals_before, release_before, begin_before;
};
static struct td_model d;
static const int td_fds[] = {DEVICE, CHILD_PROC, PROCROOT, PIDFD};
static int td_index(int fd) {
  for (size_t i=0;i<4;i++) if(td_fds[i]==fd)return (int)i;
  CHECK(!"not an original remaining descriptor");return -1;
}
static int td_close(int fd) {
  if(!d.active)return raw_close(fd);
  if(d.legacy){int result=raw_close(fd);if(fd==d.failed_fd){errno=EINTR;return -1;}return result;}
  int i=td_index(fd);struct tns_owner *o=original_owner();
  int *slots[]={&o->kernel_fd,&o->procfd,&o->procroot,&o->pidfd};
  CHECK(o->tracked_dispose_started && *slots[i]==-1 && !d.calls[i]);
  CHECK(m.read_calls==d.reads_before+1 && !m.after_begin_old_reads);
  CHECK(d.total<4);d.calls[i]++;d.order[d.total++]=(unsigned int)i;
  if(fd==d.failed_fd) {
    if(d.no_effect){fd_current(fd);m.closes[fd]++;}
    else CHECK(raw_close(fd)==0);
    errno=EINTR;return -1;
  }
  int result=raw_close(fd);
  if(fd==d.wrong_after)m.fault=WRONG_CONTROLLER;
  return result;
}
static void td_free(void *allocation) {
  if(d.active && d.legacy){d.frees++;free(allocation);return;}
  if(d.active){
    struct tns_owner *o=allocation;
    CHECK(o==*m.slot && !d.frees && o->tracked_dispose_started && !o->tracked_dispose_close_unknown);
    CHECK(o->kernel_fd<0 && o->procfd<0 && o->procroot<0 && o->pidfd<0);
    CHECK(d.total==4);
    for(size_t i=0;i<4;i++)CHECK(d.calls[i]==1 && m.fd_live[td_fds[i]]==(td_fds[i]==d.reused_fd));
    d.frees++;
  }
  free(allocation);
}
static void prepare(struct tns_owner **slot, int complete) {
  memset(&d,0,sizeof(d));d.failed_fd=d.reused_fd=d.wrong_after=-1;
  create_and_loan(slot);released(*slot);CHECK(tns_owner_begin_tracked_join(*slot)==0);
  if(complete)raw_final_object_free();
  d.reads_before=m.read_calls;d.ioctl_seq_before=m.seq;
  d.signals_before=m.signals;d.release_before=m.releases;d.begin_before=m.begin_calls;
}
static void immutable_effects(void) {
  CHECK(m.signals==d.signals_before && m.releases==d.release_before && m.begin_calls==d.begin_before);
  CHECK(!m.after_begin_old_reads);
}
static void retained_disposal(struct tns_owner *o) {
  CHECK(o && *m.slot==o && !d.frees && o->tracked_dispose_started);
  CHECK(o->kernel_fd==-1 && d.calls[0]==1);
  immutable_effects();
}
static void raw_teardown(struct tns_owner **slot) {
  /* Raw fixture disposal ONLY after retained/error assertions. Never call
   * legacy product close to convert new UNKNOWN into a product success. */
  d.active=0;m.fault=NONE;m.late_bad_device=0;
  if(m.tracked_allocation)raw_final_object_free();
  for(int fd=ROOT;fd<MAX_FD;fd++)m.fd_live[fd]=0;
  free(*slot);*slot=NULL;
}
static void known_success(void) {
  struct tns_owner *o;prepare(&o,1);d.active=1;
  CHECK(tns_owner_dispose_tracked(&o)==0 && !o && d.frees==1 && d.total==4);
  for(unsigned int i=0;i<4;i++)CHECK(d.order[i]==i && d.calls[i]==1);
  CHECK(m.read_calls==d.reads_before+1 && m.seq==d.ioctl_seq_before+1);
  for(int fd=ROOT;fd<MAX_FD;fd++)CHECK(!m.fd_live[fd]);
  immutable_effects();CHECK(tns_owner_dispose_tracked(&o)<0 && errno==EINVAL && d.frees==1);
}
static void missing_and_pending(void) {
  CHECK(tns_owner_dispose_tracked(NULL)<0 && errno==EINVAL);
  struct tns_owner *o=NULL;CHECK(tns_owner_dispose_tracked(&o)<0 && errno==EINVAL);
  for(unsigned int phase=0;phase<4;phase++){
    memset(&d,0,sizeof(d));d.failed_fd=d.wrong_after=-1;
    if(phase==0)create_and_loan(&o);
    else {create_and_loan(&o);released(o);if(phase>=2)CHECK(tns_owner_begin_tracked_join(o)==0);if(phase==3)raw_final_object_free();}
    if(phase==3)o->namespace_close_unknown=1;
    unsigned int closes=0;for(int fd=ROOT;fd<MAX_FD;fd++)closes+=m.closes[fd];
    CHECK(tns_owner_dispose_tracked(&o)<0 && o && !o->tracked_dispose_started && !d.frees);
    unsigned int after=0;for(int fd=ROOT;fd<MAX_FD;fd++)after+=m.closes[fd];CHECK(closes==after);
    raw_teardown(&o);
  }
  prepare(&o,0);d.active=1;
  CHECK(tns_owner_dispose_tracked(&o)<0 && errno==EAGAIN && !o->tracked_dispose_started && !d.total);
  d.active=0;raw_final_object_free();d.reads_before=m.read_calls;d.active=1;
  CHECK(tns_owner_dispose_tracked(&o)==0 && !o && d.frees==1);immutable_effects();
}
static void currentness(void) {
  const enum fault faults[]={WRONG_CONTROLLER,BAD_DEVICE,MISSING_DEVICE,READ_INTERRUPTED,READ_POSITIVE,READ_UNCLEAN,READ_NO_DATA,READ_LATE_DEVICE};
  for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
    struct tns_owner *o;prepare(&o,1);d.active=1;m.fault=faults[i];
    CHECK(tns_owner_dispose_tracked(&o)<0 && !d.total && !d.frees && !o->tracked_dispose_started);
    CHECK(o->kernel_fd==DEVICE && o->procfd==CHILD_PROC && o->procroot==PROCROOT && o->pidfd==PIDFD);
    immutable_effects();raw_teardown(&o);
  }
  struct tns_owner *o;prepare(&o,1);int held=o->procfd;o->procfd=-1;d.active=1;
  CHECK(tns_owner_dispose_tracked(&o)<0 && errno==EUCLEAN && !d.total && m.read_calls==d.reads_before);
  o->procfd=held;raw_teardown(&o);
}
static void unknown_closes(void) {
  for(unsigned int target=0;target<4;target++)for(unsigned int effect=0;effect<2;effect++)for(unsigned int reuse=0;reuse<=effect;reuse++) {
    struct tns_owner *o;prepare(&o,1);d.active=1;d.failed_fd=td_fds[target];d.no_effect=!effect;
    CHECK(tns_owner_dispose_tracked(&o)<0 && errno==EINTR && o->tracked_dispose_close_unknown && d.total==target+1);
    retained_disposal(o);CHECK(m.fd_live[d.failed_fd]==!effect);
    if(reuse){CHECK(!m.fd_live[d.failed_fd]);m.fd_live[d.failed_fd]=1;d.reused_fd=d.failed_fd;}
    unsigned int read=m.read_calls,seq=m.seq;
    m.fault=WRONG_CONTROLLER;CHECK(tns_owner_dispose_tracked(&o)<0 && errno==EPERM && d.total==target+1);m.fault=NONE;
    CHECK(tns_owner_dispose_tracked(&o)<0 && errno==EUCLEAN && d.total==4 && !d.frees);
    CHECK(m.read_calls==read && m.seq==seq);retained_disposal(o);
    for(unsigned int i=0;i<4;i++)CHECK(d.calls[i]==1 && d.order[i]==i);
    CHECK(m.fd_live[d.failed_fd]==(!effect || reuse));
    CHECK(tns_owner_dispose_tracked(&o)<0 && errno==EUCLEAN && d.total==4 && !d.frees);
    CHECK(m.read_calls==read && m.seq==seq);raw_teardown(&o);
  }
}
static void known_phase_continuation(void) {
  for(unsigned int target=0;target<4;target++) {
    struct tns_owner *o;prepare(&o,1);d.active=1;d.wrong_after=td_fds[target];
    CHECK(tns_owner_dispose_tracked(&o)<0 && errno==EPERM && o && !o->tracked_dispose_close_unknown && !d.frees && d.total==target+1);
    retained_disposal(o);CHECK(m.read_calls==d.reads_before+1);
    /* A reused retired numeric FD must never receive a close or ioctl. */
    CHECK(!m.fd_live[DEVICE]);m.fd_live[DEVICE]=1;d.reused_fd=DEVICE;
    unsigned int read=m.read_calls,seq=m.seq;m.fault=NONE;d.wrong_after=-1;
    CHECK(tns_owner_dispose_tracked(&o)==0 && !o && d.frees==1 && d.total==4);
    CHECK(m.read_calls==read && m.seq==seq && m.fd_live[DEVICE]);immutable_effects();
    m.fd_live[DEVICE]=0; /* Unrelated modeled descriptor teardown only. */
  }
}
int main(void) {
#ifdef TD_USE_LEGACY_DISPOSE
  /* Expected comparison RED: unchanged legacy close has an explicitly weaker
   * contract and cannot supply this new sticky-UNKNOWN disposal receipt. */
  struct tns_owner *old;prepare(&old,1);d.active=d.legacy=1;d.failed_fd=DEVICE;
  CHECK(tns_owner_close(&old)<0 && old && !d.frees);
#endif
  known_success();missing_and_pending();currentness();unknown_closes();known_phase_continuation();
  printf("PASS %u actual tracked-disposal syscall-model checks; native effects0\n",checks);return 0;
}
#else
/* The immutable old model already established its syscall macros/prototypes.
 * Only actual namespace source close/free are intercepted; raw fixture model
 * frees and old cases keep their original meanings and are never evaluated. */
#undef close
#define close td_close
#define free td_free
#include "../../scripts/native/docker-container-terminal-namespace.c"
#undef free
#undef close
#define close raw_close
#endif
