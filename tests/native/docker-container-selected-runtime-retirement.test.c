/* Closed actual-source model; old cohort main/cases are NEVER invoked.
 * Repo-only recipe: extract from scripts/native/docker-container-terminal-oci-stdio.c
 * the two ocip_*_state structs and exact ocip_retirement_stage/reply,
 * ocip_runtime_retirement_command/ocip_cleanup_routed definitions (balanced C
 * bodies; no rewrites), in that order. Compile this TU with
 * cc -std=gnu11 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer
 * -Wall -Wextra -Werror -Wshadow -Wformat=2 -Wstrict-prototypes
 * -Wmissing-prototypes -Wno-unused-parameter -DSR_ROUTE_BODY='"/path/route.inc"'
 * tests/native/docker-container-selected-runtime-retirement.test.c -Wl,--wrap=main -o /path/raw
 * The included original model runs actual namespace CREATE/joins; OCI artifact
 * and CREATE state are prepared as in that model (whole runc CREATE unrun).
 * Only profile selection is fixture data; release-completion is produced by
 * actual release body and runtime result by actual consuming child wait/absence.
 */
/* GNU ld wraps the CRT's main reference to our new selector below. The included
 * original main and cases compile unchanged but are never invoked. */
#include "docker-container-terminal-oci-born-delete.test.c"
#include "../../scripts/native/docker-container-terminal-oci-stdio.h"
static volatile sig_atomic_t interrupted;
static unsigned int route_replies;
static int ocip_reply(const char *bytes) {
 CHECK(bytes && strlen(bytes)<160 && strstr(bytes,"\"barrier\":\"unproven\""));
 route_replies++;return 0; /* Closed stdout write model, not an input witness. */
}
static int ocip_cleanup(struct tns_oci_owner **slot) { (void)slot;abort(); }
#ifndef SR_ROUTE_BODY
#error "Use exact six-definition extraction recipe above"
#endif
#include SR_ROUTE_BODY

static void runtime_fixture(struct fixture *f) {
 setup(f);f->o.retirement_profile=OCI_RETIREMENT_RUNTIME_FIRST;
 release_original(f);CHECK(f->o.runtime_first_namespace_known);
}
static void early_runtime_then_original_cleanup(void) {
 struct fixture f;runtime_fixture(&f);struct tns_oci_owner *owner=&f.o;
 struct ocip_namespace_state ns={.entered=1,.release_requested=1};
 struct ocip_retirement_state state={.runtime_first=1};
 CHECK(tns_oci_delete_born(owner)<0 && !b.spawns && !owner->delete_attempt);
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_DELETE_BORN,&owner,&ns,&state)==0);
 CHECK(state.delete_known && b.spawns==1 && b.waits==1 && !owner->birth->tracked_join_attempted);
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_JOIN_BORN_DELETE,&owner,&ns,&state)==0);
 CHECK(b.spawns==1 && b.waits==1);
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_BEGIN_TRACKED_JOIN,&owner,&ns,&state)==0);
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,&owner,&ns,&state)<0 && !state.read_known);
 raw_final_object_free();
 CHECK(ocip_runtime_retirement_command(TNS_OCIP_READ_TRACKED_JOIN,&owner,&ns,&state)==0 && state.read_known);
 CHECK(b.spawns==1 && b.waits==1 && route_replies>=4);
 destroy_fixture(&f);
}
static void source_refusals(void) {
 struct fixture f;setup(&f);release_original(&f);
 CHECK(!f.o.runtime_first_namespace_known && tns_oci_delete_selected_runtime(&f.o)<0 && !b.spawns);
 destroy_fixture(&f);
 setup(&f);f.o.retirement_profile=OCI_RETIREMENT_RUNTIME_FIRST;
 CHECK(tns_oci_delete_selected_runtime(&f.o)<0 && !f.o.delete_attempt && !b.spawns);
 destroy_fixture(&f);
 runtime_fixture(&f);j.fault=O_FOREIGN;
 CHECK(tns_oci_delete_selected_runtime(&f.o)<0 && !b.spawns && !f.o.delete_attempt);
 j.fault=O_NONE;destroy_fixture(&f);
 runtime_fixture(&f);f.o.runtime_first_namespace_known=0;
 CHECK(tns_oci_delete_selected_runtime(&f.o)<0 && !b.spawns && !f.o.delete_attempt);
 destroy_fixture(&f);
}
static void requested_only_continuation(void) {
 const enum bd_fault faults[]={D_TIMEOUT,D_WAIT_ERROR,D_NONZERO};
 for(size_t i=0;i<sizeof(faults)/sizeof(faults[0]);i++) {
  struct fixture f;runtime_fixture(&f);struct tns_oci_owner *owner=&f.o;
  struct ocip_namespace_state ns={.entered=1,.release_requested=1};
  struct ocip_retirement_state state={.runtime_first=1};
  b.fault=faults[i];CHECK(ocip_runtime_retirement_command(TNS_OCIP_DELETE_BORN,&owner,&ns,&state)<0);
  CHECK(state.delete_requested && !state.delete_known && b.spawns==1);
  unsigned int waits=b.waits;b.fault=D_NONE;
  int result=ocip_cleanup_routed(&owner,&state); /* EOF/CANCEL same original JOIN only */
  if(faults[i]==D_TIMEOUT)CHECK(result==0 && state.delete_known && b.waits==1);
  else CHECK(result!=0 && !state.delete_known && b.waits==waits);
  CHECK(b.spawns==1 && !state.begin_requested && !state.dispose_requested);
  CHECK(ocip_runtime_retirement_command(TNS_OCIP_DELETE_BORN,&owner,&ns,&state)<0 && b.spawns==1);
  destroy_fixture(&f);
 }
}
int __wrap_main(void);
int __wrap_main(void) {
 early_runtime_then_original_cleanup();source_refusals();requested_only_continuation();
 printf("PASS %u selected original runtime->tracked cleanup checks; native effects0\n",checks);
 return 0;
}
