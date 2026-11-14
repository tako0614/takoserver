/* Repository-only raw reproduction from the product root, using existing
 * scratch: extract the four actual bodies with the recipe in
 * docker-container-terminal-oci-born-dispose.test.c. Append this one line to
 * that generated include (not any product source):
 *   #define main born_dispose_cohort_never_run
 * Then compile this test instead, with OCI_DISPOSE_RAW_BODY naming that include:
 * cc -std=gnu11 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
 *   -Wall -Wextra -Werror -Wshadow -Wformat=2 -Wstrict-prototypes \
 *   -Wmissing-prototypes -Wno-unused-parameter \
 *   -DOCI_DISPOSE_RAW_BODY='"/absolute/existing-scratch/actual-bodies.inc"' \
 *   tests/native/docker-container-terminal-oci-retirement-stdio.test.c \
 *   -o /absolute/existing-scratch/retirement-raw
 * ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
 * UBSAN_OPTIONS=halt_on_error=1 /absolute/existing-scratch/retirement-raw
 *
 * Reuses immutable C27/C25/C21 raw syscall models and their actual namespace
 * and OCI bodies. All previous mains/cases and the native main are compiled
 * but NEVER called. Prepared OCI artifact/command data is not whole CREATE.
 * No positive producer substitute; od_dispose is the four-body extraction's
 * exact actual C27 body under its original closed close/unlink/free model.
 */
int born_dispose_cohort_never_run(void);
#include "docker-container-terminal-oci-born-dispose.test.c"
#undef main

static ssize_t wr_read(int fd,void *bytes,size_t size);
static ssize_t wr_write(int fd,const void *bytes,size_t size);
static int wr_poll(struct pollfd *p,nfds_t count,int timeout);
int retirement_native_main_never_run(int argc,char **argv);
#define main retirement_native_main_never_run
#define tns_oci_dispose_born od_dispose
#define poll wr_poll
#define read wr_read
#define write wr_write
#define clock_gettime raw_clock_gettime
#include "../../scripts/native/docker-container-terminal-oci-stdio.c"
#undef main
#undef tns_oci_dispose_born
#undef poll
#undef read
#undef write
#undef clock_gettime

struct wr_io {
 unsigned char input[4096],output[8192];size_t input_size,input_at,output_size;
 int write_error,read_error;unsigned int writes,reads;
};
static struct wr_io w;
static void wr_reset(void) {memset(&w,0,sizeof(w));interrupted=0;}
static ssize_t wr_write(int fd,const void *bytes,size_t size) {
 CHECK(fd==1);w.writes++;
 if(w.write_error){errno=EPIPE;return -1;}
 CHECK(size<=sizeof(w.output)-w.output_size);memcpy(w.output+w.output_size,bytes,size);w.output_size+=size;return (ssize_t)size;
}
static ssize_t wr_read(int fd,void *bytes,size_t size) {
 CHECK(fd==0);w.reads++;
 if(w.read_error){errno=EIO;return -1;}
 if(size>w.input_size-w.input_at)size=w.input_size-w.input_at;
 memcpy(bytes,w.input+w.input_at,size);w.input_at+=size;return (ssize_t)size;
}
static int wr_poll(struct pollfd *p,nfds_t count,int timeout) {
 CHECK(count==1 && timeout>=-1 && (p->fd==0 || p->fd==1));p->revents=p->fd?POLLOUT:POLLIN;return 1;
}
static void wr_expect(const char *kind) {
 uint32_t n;CHECK(w.output_size>=4 && tns_ocip_frame(w.output,&n)==0 && n==w.output_size-4);
 char expected[256];int count=snprintf(expected,sizeof(expected),"{\"kind\":\"%s\",\"barrier\":\"unproven\"}",kind);
 CHECK(count>0 && (size_t)count==n && !memcmp(expected,w.output+4,n));wr_reset();
}
static const char *const wr_requests[]={"begin-tracked-join","read-tracked-join","delete-born","join-born-delete","dispose-born","continue-born-disposal"};
static const char *const wr_replies[]={"tracked-join-handoff","tracked-owner-destruction","born-delete-observation","born-delete-join-observation","local-disposal","local-disposal-continuation"};
static int wr_decode(const char *text,enum tns_ocip_kind *kind) {
 size_t n=strlen(text);unsigned char *bytes=malloc(n+1);struct tns_ocip_request *r=malloc(sizeof(*r));CHECK(bytes && r);memcpy(bytes,text,n+1);
 int result=tns_ocip_decode(bytes,n,r);if(!result)*kind=r->kind;free(bytes);free(r);return result;
}
static void wr_codec(void) {
 enum tns_ocip_kind kind;char text[256],reply[128];
 for(unsigned int i=0;i<6;i++) {
  CHECK(snprintf(text,sizeof(text),"{\"kind\":\"linux-oci-%s@1\"}",wr_requests[i])>0);
  CHECK(wr_decode(text,&kind)==0 && kind==(enum tns_ocip_kind)(11+i));
  CHECK(ocip_retirement_stage(kind));wr_reset();CHECK(ocip_retirement_reply(kind)==0);
  CHECK(snprintf(reply,sizeof(reply),"linux-oci-%s@1",wr_replies[i])>0);wr_expect(reply);
  CHECK(snprintf(text,sizeof(text),"{\"kind\":\"linux-oci-%s@1\",\"uid\":0}",wr_requests[i])>0);CHECK(wr_decode(text,&kind)<0);
  CHECK(snprintf(text,sizeof(text),"{\"kind\":\"linux-oci-%s@1\",\"kind\":\"linux-oci-cancel@1\"}",wr_requests[i])>0);CHECK(wr_decode(text,&kind)<0);
 }
 const char *bad[]={"{}","{\"kind\":\"linux-oci-read-tracked-join@2\"}","{\"kind\":\"linux-oci-read-tracked-join@1\",\"target\":\"a\"}","{\"kind\":\"linux-oci-dispose-born@1\"}x","{\"kind\":\"linux-oci-dispose-born@1\""};
 for(size_t i=0;i<sizeof(bad)/sizeof(bad[0]);i++)CHECK(wr_decode(bad[i],&kind)<0);
 for(int k=1;k<=10;k++)CHECK(!ocip_retirement_stage((enum tns_ocip_kind)k));
 unsigned int permanent=0;CHECK(tns_oci_once(&permanent)==0);for(int i=0;i<10;i++)CHECK(tns_oci_once(&permanent)<0 && permanent==1);
}
static void wr_mark_fds(struct tns_oci_owner *o) {
 int *slots[]={&o->delete_pidfd,&o->delete_state_fd,&o->command_pidfd,&o->stopped_exe,&o->init_pidfd,&o->init_proc,&o->init_pidns,&o->parent_pidns,&o->state,&o->bundle,&o->runtime,&o->receipt,&o->rootfs,&o->root};
 for(size_t i=0;i<sizeof(slots)/sizeof(slots[0]);i++)if(*slots[i]>=O_ROOT){CHECK(*slots[i]<OD_LIMIT);x.own_live[*slots[i]]=1;}
}
static struct tns_oci_owner *wr_prepare(struct ocip_namespace_state *ns) {
 memset(&x,0,sizeof(x));x.close_error=x.reused=x.ns_error=x.wrong_after=-1;x.config_present=1;
 struct fixture f;setup(&f);struct tns_oci_owner *o=calloc(1,sizeof(*o));CHECK(o);*o=f.o;f.o.birth=f.birth=NULL;
 /* Move prepared raw custody once before original release/BEGIN/DELETE. */
 x.owner=o;x.birth=o->birth;m.slot=&o->birth;b.owner=o;
 o->command_pidfd=OD_COMMAND;o->stopped_exe=OD_STOPPED;o->egress_file=o->egress_binary=-1;
 for(size_t i=0;i<3;i++)o->egress_pidfd[i]=o->egress_in[i]=o->egress_out[i]=-1;
 *ns=(struct ocip_namespace_state){0};wr_reset();
 CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE,o,ns)==0 && ns->release_requested);
 wr_reset();wr_mark_fds(o);return o;
}
static void wr_teardown(struct tns_oci_owner **o) {
 if(m.tracked_allocation)raw_final_object_free();
 od_teardown(o);wr_reset();
}
static void wr_ready(struct tns_oci_owner **o,struct ocip_namespace_state *ns,struct ocip_retirement_state *r) {
 *r=(struct ocip_retirement_state){0};*o=wr_prepare(ns);
 CHECK(ocip_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,o,ns,r)==0);wr_expect("linux-oci-tracked-join-handoff@1");
 CHECK(ocip_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,o,ns,r)<0 && errno==EAGAIN && !r->read_known && !w.output_size);
 raw_final_object_free();CHECK(ocip_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,o,ns,r)==0 && r->read_known);wr_expect("linux-oci-tracked-owner-destruction@1");
}
static void wr_positive(void) {
 struct tns_oci_owner *o;struct ocip_namespace_state ns;struct ocip_retirement_state r;wr_ready(&o,&ns,&r);
 CHECK(ocip_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&r)<0 && errno==EALREADY && m.begin_calls==1);
 CHECK(ocip_retirement_command(TNS_OCIP_DELETE_BORN,&o,&ns,&r)==0 && b.spawns==1 && r.delete_known);wr_expect("linux-oci-born-delete-observation@1");
 CHECK(ocip_retirement_command(TNS_OCIP_JOIN_BORN_DELETE,&o,&ns,&r)==0 && b.spawns==1 && b.waits==1);wr_expect("linux-oci-born-delete-join-observation@1");
 wr_mark_fds(o);tns_oci_note_cancel();CHECK(ocip_retirement_command(TNS_OCIP_DISPOSE_BORN,&o,&ns,&r)==1 && !o && r.disposed && x.own_frees==1);wr_expect("linux-oci-local-disposal@1");
 CHECK(ocip_cleanup_routed(&o,&r)==0 && !o);CHECK(ocip_retirement_command(TNS_OCIP_CONTINUE_BORN_DISPOSAL,&o,&ns,&r)==-3 && !o);
 CHECK(!m.after_begin_old_reads && b.spawns==1 && x.ns_frees==1);
}
static void wr_order(void) {
 for(int kind=TNS_OCIP_READ_TRACKED_JOIN;kind<=TNS_OCIP_CONTINUE_BORN_DISPOSAL;kind++) {
  struct ocip_namespace_state ns;struct ocip_retirement_state r={0};struct tns_oci_owner *o=wr_prepare(&ns);
  CHECK(ocip_retirement_command((enum tns_ocip_kind)kind,&o,&ns,&r)==-3 && r.entered && r.unusable && !m.begin_calls && !b.spawns);
  CHECK(ocip_cleanup_routed(&o,&r)==0 && !m.read_calls && !m.begin_calls && !b.spawns);wr_teardown(&o);
 }
 struct ocip_namespace_state ns;struct ocip_retirement_state r={0};struct tns_oci_owner *o=wr_prepare(&ns);ns.release_requested=0;
 CHECK(ocip_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&r)==-3 && !m.begin_calls);wr_teardown(&o);
 r=(struct ocip_retirement_state){0};wr_ready(&o,&ns,&r);CHECK(ocip_cleanup_routed(&o,&r)==0 && !b.spawns && !x.unlinks);wr_teardown(&o);
}
static void wr_begin_unknown(void) {
 const enum fault faults[]={BEGIN_LOST_NO_EFFECT,BEGIN_LOST_EFFECT,BEGIN_LATE_DEVICE};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct ocip_namespace_state ns;struct ocip_retirement_state r={0};struct tns_oci_owner *o=wr_prepare(&ns);m.fault=faults[i];
  CHECK(ocip_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&r)<0 && r.begin_requested && !w.output_size && m.begin_calls==1);
  m.fault=NONE;m.late_bad_device=0;CHECK(ocip_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&r)<0 && errno==EALREADY && m.begin_calls==1);
  unsigned int reads=m.read_calls;CHECK(ocip_cleanup_routed(&o,&r)!=0 && m.read_calls==reads+1 && !b.spawns);
  raw_final_object_free();int result=ocip_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,&o,&ns,&r);
  if(faults[i]==BEGIN_LOST_NO_EFFECT)CHECK(result<0 && errno==ENODATA && !r.read_known);
  else {CHECK(result==0 && r.read_known);wr_expect("linux-oci-tracked-owner-destruction@1");}
  CHECK(m.begin_calls==1 && !m.after_begin_old_reads);wr_teardown(&o);
 }
}
static void wr_delete_unknown(void) {
 const enum bd_fault faults[]={D_TIMEOUT,D_WAIT_ERROR,D_NONZERO};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct tns_oci_owner *o;struct ocip_namespace_state ns;struct ocip_retirement_state r;wr_ready(&o,&ns,&r);b.fault=faults[i];
  CHECK(ocip_retirement_command(TNS_OCIP_DELETE_BORN,&o,&ns,&r)<0 && r.delete_requested && b.spawns==1 && !r.delete_known && !w.output_size);
  CHECK(ocip_retirement_command(TNS_OCIP_DELETE_BORN,&o,&ns,&r)<0 && errno==EALREADY && b.spawns==1);
  b.fault=D_NONE;unsigned int waits=b.waits;int result=ocip_retirement_command(TNS_OCIP_JOIN_BORN_DELETE,&o,&ns,&r);
  if(faults[i]==D_TIMEOUT){CHECK(result==0 && r.delete_known && b.waits==waits+1);wr_expect("linux-oci-born-delete-join-observation@1");}
  else CHECK(result<0 && errno==EUCLEAN && b.waits==waits && !r.delete_known);
  CHECK(b.spawns==1 && !m.after_begin_old_reads);wr_teardown(&o);
 }
}
static void wr_disposal(void) {
 for(unsigned int fault=0;fault<4;fault++) {
  struct tns_oci_owner *o;struct ocip_namespace_state ns;struct ocip_retirement_state r;wr_ready(&o,&ns,&r);
  CHECK(ocip_retirement_command(TNS_OCIP_DELETE_BORN,&o,&ns,&r)==0);wr_reset();wr_mark_fds(o);
  if(fault==0)x.wrong_after=OD_CONFIG;
  if(fault==1){x.ns_error=DEVICE;x.ns_no_effect=1;}
  if(fault==2){x.close_error=OD_CONFIG;x.no_effect=0;}
  if(fault==3){x.unlink_error=1;x.unlink_effect=1;}
  CHECK(ocip_retirement_command(TNS_OCIP_DISPOSE_BORN,&o,&ns,&r)<0 && o && r.dispose_requested && !r.disposed && !w.output_size);
  unsigned int reads=m.read_calls,seq=m.seq,unlinks=x.unlinks,spawns=b.spawns;unsigned int count=x.own_closes[OD_CONFIG];
  j.fault=O_NONE;x.wrong_after=-1;
  if(fault==0) {CHECK(ocip_retirement_command(TNS_OCIP_CONTINUE_BORN_DISPOSAL,&o,&ns,&r)==1 && !o && r.disposed);wr_expect("linux-oci-local-disposal-continuation@1");}
  else {CHECK(ocip_cleanup_routed(&o,&r)!=0 && o && !r.disposed && !x.own_frees);CHECK(x.own_closes[OD_CONFIG]==count);wr_teardown(&o);}
  CHECK(m.read_calls==reads && m.seq==seq && x.unlinks==unlinks && b.spawns==spawns);
 }
}
static void wr_loss_and_cleanup(void) {
 for(unsigned int stage=0;stage<4;stage++) {
  struct tns_oci_owner *o;struct ocip_namespace_state ns;struct ocip_retirement_state r={0};o=wr_prepare(&ns);w.write_error=1;
  if(stage==0) {
   CHECK(ocip_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&r)==-2 && r.unusable && m.begin_calls==1);
   CHECK(ocip_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,&o,&ns,&r)==-3);wr_reset();CHECK(ocip_cleanup_routed(&o,&r)==EAGAIN && m.begin_calls==1);raw_final_object_free();
   CHECK(ocip_cleanup_routed(&o,&r)==0 && r.read_known && !b.spawns && !x.unlinks);wr_teardown(&o);continue;
  }
  wr_reset();CHECK(ocip_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&r)==0);wr_reset();raw_final_object_free();CHECK(ocip_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,&o,&ns,&r)==0);wr_reset();
  if(stage==1) {
   b.fault=D_TIMEOUT;CHECK(ocip_retirement_command(TNS_OCIP_DELETE_BORN,&o,&ns,&r)<0);b.fault=D_NONE;
   r.unusable=1;CHECK(ocip_cleanup_routed(&o,&r)==0 && r.delete_known && b.spawns==1 && b.waits==1 && !x.unlinks);wr_teardown(&o);continue;
  }
  CHECK(ocip_retirement_command(TNS_OCIP_DELETE_BORN,&o,&ns,&r)==0);wr_reset();wr_mark_fds(o);
  if(stage==2) {
   x.wrong_after=OD_CONFIG;CHECK(ocip_retirement_command(TNS_OCIP_DISPOSE_BORN,&o,&ns,&r)<0);j.fault=O_NONE;x.wrong_after=-1;r.unusable=1;
   CHECK(ocip_cleanup_routed(&o,&r)==0 && !o && r.disposed && x.own_frees==1);
  } else {
   w.write_error=1;CHECK(ocip_retirement_command(TNS_OCIP_DISPOSE_BORN,&o,&ns,&r)==-2 && !o && r.disposed && r.unusable && x.own_frees==1);
   CHECK(ocip_cleanup_routed(&o,&r)==0 && !o && x.own_frees==1);
  }
  CHECK(b.spawns==1 && !m.after_begin_old_reads);wr_reset();
 }
 struct ocip_namespace_state ns;struct ocip_retirement_state r={0};struct tns_oci_owner *o=wr_prepare(&ns);r.entered=1;r.unusable=1;
 CHECK(ocip_cleanup_routed(&o,&r)==0 && !m.begin_calls && !b.spawns && !x.unlinks);wr_teardown(&o);
}
static void wr_frames(void) {
 wr_reset();unsigned char *body=NULL;uint32_t n=0;CHECK(ocip_read(&body,&n)==1 && !body);
 const unsigned char bad[][5]={{0,0,0,0,0},{0,16,0,1,0},{0,0,0,3,'{'}};
 for(size_t i=0;i<sizeof(bad)/sizeof(bad[0]);i++) {wr_reset();memcpy(w.input,bad[i],5);w.input_size=i==2?5:4;CHECK(ocip_read(&body,&n)<0);free(body);body=NULL;}
 wr_reset();const char *s="{\"kind\":\"linux-oci-read-tracked-join@1\"}";n=(uint32_t)strlen(s);w.input[3]=(unsigned char)n;memcpy(w.input+4,s,n);w.input_size=n+4;
 CHECK(ocip_read(&body,&n)==0 && n==strlen(s));struct tns_ocip_request *q=malloc(sizeof(*q));CHECK(q && tns_ocip_decode(body,n,q)==0 && q->kind==TNS_OCIP_READ_TRACKED_JOIN);free(q);free(body);
 wr_reset();interrupted=1;body=NULL;CHECK(ocip_read(&body,&n)<0 && errno==ECANCELED && !w.reads);wr_reset();
}
int main(void) {
 wr_codec();wr_positive();wr_order();wr_begin_unknown();wr_delete_unknown();wr_disposal();wr_loss_and_cleanup();wr_frames();
 printf("PASS %u actual retirement codec/dispatch/cleanup raw checks; native effects0\n",checks);return 0;
}
