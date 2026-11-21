/* New selectors only. Old raw model mains/cases compile but NEVER run.
 * Existing constructor/cleanup models are included, never copied. OCI CREATE
 * state/profile is prepared data; namespace CREATE/init join/release/runtime
 * DELETE/BEGIN and actual local disposal run through original source bodies.
 * Repo-only recipe: extract oci_owned + egress close_fd/close + actual shared
 * oci_dispose_born_profile + old tns_oci_dispose_born wrapper, in that order,
 * to OCI_DISPOSE_RAW_BODY (five definitions, as the old model header records);
 * extract current oci_dispose_born_profile to SFC_DISPOSE_BODY unchanged;
 * extract the two ocip_*_state structs + retirement_stage/reply + runtime
 * retirement_command + cleanup_routed to SFC_ROUTE_BODY unchanged. Use balanced
 * C definitions from scripts/native/docker-container-terminal-oci{,.h,-stdio.c}
 * and -egress.h, preserving all bytes. Only linkage/name aliases below differ.
 * cc -std=gnu11 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer
 * -Wall -Wextra -Werror -Wshadow -Wformat=2 -Wstrict-prototypes
 * -Wmissing-prototypes -Wno-unused-parameter -DOCI_DISPOSE_RAW_BODY='"/x/legacy.inc"'
 * -DSFC_DISPOSE_BODY='"/x/dispose.inc"' -DSFC_ROUTE_BODY='"/x/route.inc"'
 * tests/native/docker-container-selected-final-cleanup.test.c -Wl,--wrap=main -o /x/raw
 */
#include "docker-container-terminal-oci-born-dispose.test.c"
#ifndef SFC_DISPOSE_BODY
#error "Use repository-only actual-body extraction recipe above"
#endif
#define openat od_openat
#define fstat od_fstat
#define fstatat od_fstatat
#define unlinkat od_unlinkat
#define close od_close
#define free od_free
#define getpid oj_getpid
#define oci_owned od_owned
#define oci_egress_close_fd od_egress_close_fd
#define oci_egress_close od_egress_close
#define oci_dispose_born_profile measured_dispose_profile
#include SFC_DISPOSE_BODY
#undef openat
#undef fstat
#undef fstatat
#undef unlinkat
#undef close
#undef free
#undef getpid
#undef oci_owned
#undef oci_egress_close_fd
#undef oci_egress_close
#undef oci_dispose_born_profile
static int measured_selected(struct tns_oci_owner **slot) { return measured_dispose_profile(slot,1); }
#include "../../scripts/native/docker-container-terminal-oci-stdio.h"
static volatile sig_atomic_t interrupted;
static int ocip_reply(const char *s) { CHECK(s && strstr(s,"\"barrier\":\"unproven\""));return 0; }
static int ocip_cleanup(struct tns_oci_owner **slot) { (void)slot;abort(); }
#define tns_oci_dispose_selected_runtime measured_selected
#include SFC_ROUTE_BODY
#undef tns_oci_dispose_selected_runtime
static struct tns_oci_owner *local_prepare(int begin) {
 memset(&x,0,sizeof(x));x.close_error=x.reused=x.ns_error=x.wrong_after=-1;x.config_present=1;
 struct fixture f;setup(&f);
 struct tns_oci_owner *o=calloc(1,sizeof(*o));CHECK(o);*o=f.o;f.o.birth=f.birth=NULL;
 x.owner=o;x.birth=o->birth;m.slot=&o->birth;b.owner=o;
 o->retirement_profile=OCI_RETIREMENT_RUNTIME_LOCAL;
 o->command_pidfd=OD_COMMAND;o->stopped_exe=OD_STOPPED;
 o->egress_file=o->egress_binary=-1;
 for(size_t i=0;i<3;i++)o->egress_pidfd[i]=o->egress_in[i]=o->egress_out[i]=-1;
 struct tns_oci_namespace_lifetime life;
 CHECK(tns_oci_release_namespace(o,&life)==0 && o->runtime_first_namespace_known);
 CHECK(tns_oci_delete_selected_runtime(o)==0 && b.spawns==1 && b.waits==1);
 if(begin)CHECK(tns_oci_begin_tracked_join(o)==0 && o->runtime_first_handoff_known);
 int *slots[]={&o->delete_pidfd,&o->delete_state_fd,&o->command_pidfd,&o->stopped_exe,&o->init_pidfd,&o->init_proc,&o->init_pidns,&o->parent_pidns,&o->state,&o->bundle,&o->runtime,&o->receipt,&o->rootfs,&o->root};
 for(size_t i=0;i<sizeof(slots)/sizeof(slots[0]);i++)if(*slots[i]>=O_ROOT){CHECK(*slots[i]<OD_LIMIT && !x.own_live[*slots[i]]);x.own_live[*slots[i]]=1;}
 return o;
}
static void discard(struct tns_oci_owner **slot) {
 /* Raw heap disposal only AFTER original retained/UNKNOWN/success assertions.
  * Inert tracking allocation is NOT a successful kernel completion event. */
 od_teardown(slot);free(m.tracked_allocation);m.tracked_allocation=NULL;
}
static void local_success(void) {
 struct tns_oci_owner *o=local_prepare(1);
 CHECK(m.tracked_allocation && !m.freed_events && !m.read_calls);
 CHECK(measured_dispose_profile(&o,0)<0 && o && !x.unlinks); /* legacy still waits READ */
 unsigned int reads=m.read_calls;CHECK(reads==1);
 struct ocip_namespace_state ns={.entered=1,.release_requested=1};
 struct ocip_retirement_state state={.runtime_first=2,.entered=1,.delete_requested=1,.delete_known=1,.begin_requested=1,.begin_known=1};
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_DISPOSE_BORN,&o,&ns,&state)==1 && !o && state.disposed);
 CHECK(x.unlinks==1 && x.ns_frees==1 && x.own_frees==1 && x.ns_total==4);
 CHECK(m.read_calls==reads && !m.freed_events && m.tracked_allocation && b.spawns==1 && b.waits==1);
 discard(&o);
}
static void local_unknown(void) {
 for(unsigned int target=0;target<4;target++)for(unsigned int effect=0;effect<2;effect++) {
  struct tns_oci_owner *o=local_prepare(1);x.ns_error=od_ns_fds[target];x.ns_no_effect=!effect;
  CHECK(measured_selected(&o)<0 && o && o->birth && !x.ns_frees && x.unlinks==1);
  unsigned int seq=m.seq;CHECK(o->birth->tracked_dispose_started==2);
  CHECK(tns_owner_close(&o->birth)<0 && o->birth && !x.ns_frees);
  CHECK(tns_owner_dispose_tracked(&o->birth)<0 && o->birth && !x.ns_frees);
  CHECK(measured_dispose_profile(&o,0)<0 && o && !x.own_frees);
  struct ocip_retirement_state state={.runtime_first=2,.entered=1,.dispose_requested=1};
  CHECK(ocip_cleanup_routed(&o,&state)!=0 && !state.disposed && errno==EUCLEAN && x.ns_total==4 && !x.own_total && !x.own_frees);
  CHECK(m.seq==seq && !m.read_calls && x.unlinks==1);discard(&o);
 }
 const int fds[]={OD_CONFIG,O_ROOT};
 for(size_t i=0;i<2;i++)for(unsigned int effect=0;effect<2;effect++) {
  struct tns_oci_owner *o=local_prepare(1);x.close_error=fds[i];x.no_effect=!effect;
  CHECK(measured_selected(&o)<0 && o && !o->birth && x.ns_frees==1 && !x.own_frees);
  unsigned int seq=m.seq;CHECK(measured_dispose_profile(&o,0)<0 && !x.own_frees);
  CHECK(measured_selected(&o)<0 && errno==EUCLEAN && !x.own_frees && x.own_closes[fds[i]]==1);
  CHECK(m.seq==seq && !m.read_calls && x.unlinks==1);discard(&o);
 }
 for(unsigned int effect=0;effect<2;effect++) {
  struct tns_oci_owner *o=local_prepare(1);x.unlink_error=1;x.unlink_effect=(int)effect;
  CHECK(measured_selected(&o)<0 && o && o->born_dispose_unknown && x.unlinks==1 && !x.ns_total);
  CHECK(measured_selected(&o)<0 && errno==EUCLEAN && x.unlinks==1 && !x.ns_frees);discard(&o);
 }
}
static void actual_source_refusals(void) {
 struct tns_oci_owner *o=local_prepare(0);
 CHECK(measured_selected(&o)<0 && !x.unlinks && !x.ns_total);m.fault=BEGIN_LOST_EFFECT;
 CHECK(tns_oci_begin_tracked_join(o)<0 && o->birth->tracked_join_attempted && !o->runtime_first_handoff_known);
 CHECK(measured_selected(&o)<0 && !x.unlinks && !x.ns_total);discard(&o);m.fault=NONE;
 for(unsigned int fault=0;fault<4;fault++) {
  o=local_prepare(1);
  if(fault==0)o->retirement_profile=OCI_RETIREMENT_RUNTIME_FIRST;
  if(fault==1)o->delete_ok=0;
  if(fault==2)j.fault=O_FOREIGN;
  if(fault==3)x.bad_named=1;
  CHECK(measured_selected(&o)<0 && !x.unlinks && !x.ns_total && !x.own_frees);discard(&o);
 }
}
int __wrap_main(void);
int __wrap_main(void) {
 local_success();local_unknown();actual_source_refusals();
 printf("PASS %u selected local cleanup model assertions; real effects0\n",checks);return 0;
}
