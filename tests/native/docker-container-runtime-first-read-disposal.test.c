/* New composition model only; every included old main/case is NEVER called.
 * OCI CREATE/artifact/profile are prepared data. Existing setup executes the
 * actual namespace constructor and original consuming init wait; release,
 * selected runtime DELETE/JOIN, BEGIN/READ, config unlink and all final closes
 * execute their original source bodies over CLOSED syscall models.
 *
 * Repository-only recipe: extract oci_owned, oci_egress_close_fd/close,
 * oci_dispose_born_profile, tns_oci_dispose_born (only the last linkage becomes
 * static) to OCI_DISPOSE_RAW_BODY. Extract ocip_namespace_state and
 * ocip_retirement_state plus ocip_retirement_stage/reply,
 * ocip_runtime_retirement_command and ocip_cleanup_routed to RFR_ROUTE_BODY.
 * Preserve definition bytes; include aliases below supply the raw boundary.
 * cc -std=gnu11 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer
 * -Wall -Wextra -Werror -Wshadow -Wformat=2 -Wstrict-prototypes
 * -Wmissing-prototypes -Wno-unused-parameter
 * -DOCI_DISPOSE_RAW_BODY='"/x/dispose.inc"' -DRFR_ROUTE_BODY='"/x/route.inc"'
 * tests/native/docker-container-runtime-first-read-disposal.test.c
 * -Wl,--wrap=main -o /x/raw
 */
#include "docker-container-terminal-oci-born-dispose.test.c"
#include "../../scripts/native/docker-container-terminal-oci-stdio.h"
static volatile sig_atomic_t interrupted;
static unsigned int rfr_replies;
static int ocip_reply(const char *bytes) {
 CHECK(bytes && strstr(bytes,"\"barrier\":\"unproven\""));
 rfr_replies++;return 0;
}
static int ocip_cleanup(struct tns_oci_owner **slot) { (void)slot;abort(); }
#ifndef RFR_ROUTE_BODY
#error "Use exact original-body recipe above"
#endif
#define tns_oci_dispose_born od_dispose
#include RFR_ROUTE_BODY
#undef tns_oci_dispose_born

static struct tns_oci_owner *rfr_prepare(void) {
 memset(&x,0,sizeof(x));x.close_error=x.reused=x.ns_error=x.wrong_after=-1;x.config_present=1;
 struct fixture f;setup(&f);
 struct tns_oci_owner *o=calloc(1,sizeof(*o));CHECK(o);*o=f.o;f.o.birth=f.birth=NULL;
 x.owner=o;x.birth=o->birth;m.slot=&o->birth;b.owner=o;rfr_replies=0;
 /* Prepared constructor selection only; the real constructor fixes this
  * value before its effects. No current owner is upgraded by product code. */
 o->retirement_profile=OCI_RETIREMENT_RUNTIME_FIRST;
 o->command_pidfd=OD_COMMAND;o->stopped_exe=OD_STOPPED;
 o->egress_file=o->egress_binary=-1;
 for(size_t i=0;i<3;i++)o->egress_pidfd[i]=o->egress_in[i]=o->egress_out[i]=-1;
 CHECK(j.init_reaps==1 && o->init_joined && !m.read_calls && !b.spawns);
 struct tns_oci_namespace_lifetime life;
 CHECK(tns_oci_release_namespace(o,&life)==0 && o->runtime_first_namespace_known);
 CHECK(m.releases==1 && m.reaps==1 && o->network<0);
 return o;
}
static void rfr_track_fds(struct tns_oci_owner *o) {
 int *slots[]={&o->delete_pidfd,&o->delete_state_fd,&o->command_pidfd,&o->stopped_exe,&o->init_pidfd,&o->init_proc,&o->init_pidns,&o->parent_pidns,&o->state,&o->bundle,&o->runtime,&o->receipt,&o->rootfs,&o->root};
 for(size_t i=0;i<sizeof(slots)/sizeof(slots[0]);i++)if(*slots[i]>=O_ROOT){CHECK(*slots[i]<OD_LIMIT && !x.own_live[*slots[i]]);x.own_live[*slots[i]]=1;}
}
static void rfr_discard(struct tns_oci_owner **o) {
 /* Model heap disposal after assertions only, never product cleanup success. */
 od_teardown(o);free(m.tracked_allocation);m.tracked_allocation=NULL;
}
static void rfr_delete(struct tns_oci_owner **o,struct ocip_namespace_state *ns,
                         struct ocip_retirement_state *state) {
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_DELETE_BORN,o,ns,state)==0);
 CHECK(state->delete_known && b.spawns==1 && b.waits==1 && !m.begin_calls && !m.read_calls);
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_JOIN_BORN_DELETE,o,ns,state)==0);
 CHECK(b.spawns==1 && b.waits==1);rfr_track_fds(*o);
}
static void runtime_read_dispose(void) {
 struct tns_oci_owner *o=rfr_prepare();
 struct ocip_namespace_state ns={.entered=1,.release_requested=1};
 struct ocip_retirement_state state={.runtime_first=1};
 CHECK(tns_oci_delete_born(o)<0 && !o->delete_attempt && !b.spawns);
 rfr_delete(&o,&ns,&state);
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&state)==0);
 CHECK(state.begin_known && m.begin_calls==1 && m.tracked_allocation && !m.freed_events);
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,&o,&ns,&state)<0 && errno==EAGAIN);
 CHECK(!state.read_known && o->birth==x.birth && m.fd_live[DEVICE]);
 CHECK(od_dispose(&o)<0 && errno==EAGAIN && !x.unlinks && !x.ns_total && !o->born_dispose_phase);
 raw_final_object_free(); /* Closed kernel destructor/completion model. */
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,&o,&ns,&state)==0 && state.read_known);
 unsigned int reads=m.read_calls;
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_DISPOSE_BORN,&o,&ns,&state)==1 && !o && state.disposed);
 CHECK(m.read_calls>reads && x.unlinks==1 && x.ns_total==4 && x.ns_frees==1 && x.own_frees==1);
 CHECK(j.init_reaps==1 && b.spawns==1 && b.waits==1 && m.begin_calls==1 && !m.after_begin_old_reads);
 CHECK(rfr_replies==5 && ocip_cleanup_routed(&o,&state)==0);rfr_discard(&o);
}
static void read_failure_keeps_same_owner(void) {
 const enum fault faults[]={READ_INTERRUPTED,READ_UNCLEAN,READ_POSITIVE};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct tns_oci_owner *o=rfr_prepare();
  struct ocip_namespace_state ns={.entered=1,.release_requested=1};
  struct ocip_retirement_state state={.runtime_first=1};rfr_delete(&o,&ns,&state);
  CHECK(ocip_runtime_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&state)==0);
  raw_final_object_free();m.fault=faults[i];
  CHECK(ocip_runtime_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,&o,&ns,&state)<0 && !state.read_known);
  CHECK(od_dispose(&o)<0 && o->birth==x.birth && m.fd_live[DEVICE] && !x.unlinks && !x.ns_total);
  CHECK(m.begin_calls==1 && b.spawns==1 && b.waits==1);rfr_discard(&o);
 }
}
static void unknown_begin_never_replays(void) {
 const enum fault faults[]={BEGIN_LOST_EFFECT,BEGIN_LOST_NO_EFFECT};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct tns_oci_owner *o=rfr_prepare();
  struct ocip_namespace_state ns={.entered=1,.release_requested=1};
  struct ocip_retirement_state state={.runtime_first=1};rfr_delete(&o,&ns,&state);
  m.fault=faults[i];CHECK(ocip_runtime_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&state)<0);
  CHECK(state.begin_requested && !state.begin_known && m.begin_calls==1);
  CHECK(ocip_runtime_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&state)<0 && m.begin_calls==1);
  m.fault=NONE;CHECK(ocip_cleanup_routed(&o,&state)!=0 && !state.read_known);
  CHECK(o->birth==x.birth && !x.unlinks && !state.dispose_requested && b.spawns==1);
  rfr_discard(&o);
 }
}
static void close_unknown_cannot_switch_family(void) {
 struct tns_oci_owner *o=rfr_prepare();
 struct ocip_namespace_state ns={.entered=1,.release_requested=1};
 struct ocip_retirement_state state={.runtime_first=1};rfr_delete(&o,&ns,&state);
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&o,&ns,&state)==0);
 raw_final_object_free();CHECK(ocip_runtime_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,&o,&ns,&state)==0);
 x.ns_error=DEVICE;
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_DISPOSE_BORN,&o,&ns,&state)<0 && o && o->birth);
 CHECK(o->birth->tracked_dispose_started==1 && o->birth->tracked_dispose_close_unknown);
 CHECK(tns_owner_dispose_released(&o->birth)<0 && tns_oci_dispose_selected_runtime(&o)<0);
 CHECK(ocip_cleanup_routed(&o,&state)!=0 && o->birth && x.unlinks==1 && x.ns_total==4 && !x.own_frees);
 unsigned int seq=m.seq;CHECK(ocip_cleanup_routed(&o,&state)!=0 && m.seq==seq && x.ns_total==4);
 CHECK(m.begin_calls==1 && b.spawns==1 && b.waits==1);rfr_discard(&o);
}
int __wrap_main(void);
int __wrap_main(void) {
 runtime_read_dispose();read_failure_keeps_same_owner();unknown_begin_never_replays();close_unknown_cannot_switch_family();
 printf("PASS %u runtime-first same-H READ-to-disposal checks; actual effects0\n",checks);return 0;
}
