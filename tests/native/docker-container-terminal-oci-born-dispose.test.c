/* Repository-only reproduction, from the product root; use existing scratch.
 * Extract exactly these five current bodies (no private packet is needed).
 * These fixed bodies have no brace characters in string/comment text.
 * The selected public function gets static linkage only, as in this raw test.

python3 - /tmp/tako-oci-dispose-bodies.inc <<'PYRAW'
from pathlib import Path
import re, sys
out = []
for file, names in [
    ("scripts/native/docker-container-terminal-oci.c", ["oci_owned"]),
    ("scripts/native/docker-container-terminal-oci-egress.h", ["oci_egress_close_fd", "oci_egress_close"]),
    ("scripts/native/docker-container-terminal-oci.c", ["oci_dispose_born_profile", "tns_oci_dispose_born"]),
]:
    source = Path(file).read_text()
    for name in names:
        match = re.search(r"(?m)^(?:static )?int " + name + r"\(", source)
        start = match.start()
        end = source.index("{", match.end()) + 1
        depth = 1
        while depth:
            depth += (source[end] == "{") - (source[end] == "}")
            end += 1
        body = source[start:end]
        if name == "tns_oci_dispose_born":
            body = "static " + body
        out.append(body + "\n")
Path(sys.argv[1]).write_text("".join(out))
PYRAW
cc -std=gnu11 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
  -Wall -Wextra -Werror -Wshadow -Wformat=2 -Wstrict-prototypes \
  -Wmissing-prototypes -Wno-unused-parameter \
  -DOCI_DISPOSE_RAW_BODY='"/tmp/tako-oci-dispose-bodies.inc"' \
  tests/native/docker-container-terminal-oci-born-dispose.test.c \
  -o /tmp/tako-oci-dispose-raw
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 \
  /tmp/tako-oci-dispose-raw

 * This runs only the CLOSED raw model, never the native main or real objects.
 */
#ifndef OCI_DISPOSE_RAW_SEAM
#define OCI_DISPOSE_RAW_SEAM 1
/* Reuse immutable C25/C21 boundary models; neither previous main is called.
 * Reentry at their two include seams wraps actual namespace allocation/close
 * and renames only the prior main. No fixture file or producer is copied. */
static int od_namespace_close(int fd);
static void od_free(void *allocation);
int born_delete_previous_cohort_never_run(void);
#define NAMESPACE_SOURCE "docker-container-terminal-oci-born-dispose.test.c"
#define OCI_BORN_DELETE_OLD_COMMAND "docker-container-terminal-oci-born-dispose.test.c"
#include "docker-container-terminal-oci-born-delete.test.c"
#undef main
#undef NAMESPACE_SOURCE

static int od_openat(int fd,const char *name,int flags,...);
static int od_fstat(int fd,struct stat *out);
static int od_fstatat(int fd,const char *name,struct stat *out,int flags);
static int od_unlinkat(int fd,const char *name,int flags);
static int od_close(int fd);
static int od_dispose(struct tns_oci_owner **slot);
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
#define oci_dispose_born_profile od_dispose_profile
#define tns_oci_dispose_born od_dispose
#ifndef OCI_DISPOSE_RAW_BODY
#error "Compile using the exact actual-body extraction recorded by this unit"
#endif
#include OCI_DISPOSE_RAW_BODY
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
#undef tns_oci_dispose_born

enum { OD_COMMAND=300,OD_CONFIG,OD_STOPPED,OD_LIMIT=400 };
struct od_model {
 struct tns_oci_owner *owner;struct tns_owner *birth;
 unsigned int own_live[OD_LIMIT],own_closes[OD_LIMIT],ns_closes[4];
 unsigned int unlinks,config_opens,own_frees,ns_frees,own_total,ns_total;
 unsigned int reads_at_unlink,seq_at_unlink;
 int config_present,bad_named,unlink_error,unlink_effect,close_error,no_effect,reused,ns_error,ns_no_effect,ns_active,wrong_after;
};
static struct od_model x;
static const int od_ns_fds[]={DEVICE,CHILD_PROC,PROCROOT,PIDFD};
static int *od_slot(struct tns_oci_owner *o,int fd) {
 int *slots[]={&o->born_config_fd,&o->delete_pidfd,&o->delete_state_fd,&o->command_pidfd,&o->start_pidfd,&o->stopped_exe,&o->init_pidfd,&o->init_proc,&o->init_pidns,&o->parent_pidns,&o->network,&o->state,&o->bundle,&o->runtime,&o->receipt,&o->rootfs,&o->root};
 for(size_t i=0;i<sizeof(slots)/sizeof(slots[0]);i++)if(*slots[i]==fd)return slots[i];
 return NULL;
}
static int od_openat(int fd,const char *name,int flags,...) {
 CHECK(fd==O_BUNDLE && !strcmp(name,"config.json") && flags==(O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC));
 CHECK(x.config_present && !x.config_opens && !x.own_live[OD_CONFIG]);x.config_opens++;x.own_live[OD_CONFIG]=1;return OD_CONFIG;
}
static int od_fstat(int fd,struct stat *out) {CHECK(fd==OD_CONFIG && x.own_live[fd]);oj_stat_data(O_CONFIG,out);return 0;}
static int od_fstatat(int fd,const char *name,struct stat *out,int flags) {
 CHECK(fd==O_BUNDLE && !strcmp(name,"config.json") && flags==AT_SYMLINK_NOFOLLOW && x.config_present);
 oj_stat_data(O_CONFIG,out);if(x.bad_named)out->st_ino++;return 0;
}
static int od_unlinkat(int fd,const char *name,int flags) {
 CHECK(fd==O_BUNDLE && !strcmp(name,"config.json") && !flags && x.owner->born_config_unlink_attempted);
 CHECK(!x.unlinks && x.config_present);x.unlinks++;x.reads_at_unlink=m.read_calls;x.seq_at_unlink=m.seq;
 if(!x.unlink_error || x.unlink_effect){x.config_present=0;j.fault=O_BAD_CONFIG;}
 if(x.unlink_error){errno=EINTR;return -1;}
 x.ns_active=1;return 0;
}
static int od_namespace_close(int fd) {
 if(!x.ns_active)return raw_close(fd);
 unsigned int i=0;while(i<4 && od_ns_fds[i]!=fd)i++;CHECK(i<4 && !x.ns_closes[i]);
 CHECK(x.owner && *m.slot==x.owner->birth && x.owner->birth==x.birth && x.birth->tracked_dispose_started);
 int *slots[]={&x.birth->kernel_fd,&x.birth->procfd,&x.birth->procroot,&x.birth->pidfd};CHECK(*slots[i]==-1);
 x.ns_closes[i]++;x.ns_total++;
 if(fd==x.ns_error && x.ns_no_effect){fd_current(fd);m.closes[fd]++;errno=EINTR;return -1;}
 int result=raw_close(fd);if(fd==x.ns_error){errno=EINTR;return -1;}return result;
}
static int od_close(int fd) {
 CHECK(fd>=O_ROOT && fd<OD_LIMIT && x.own_live[fd] && !x.own_closes[fd]);
 CHECK(x.owner->born_dispose_phase>=3 && !x.owner->birth && x.ns_frees==1 && !od_slot(x.owner,fd));
 x.own_closes[fd]++;x.own_total++;
 if(fd==x.close_error && x.no_effect){errno=EINTR;return -1;}
 x.own_live[fd]=0;
 if(fd==x.wrong_after)j.fault=O_FOREIGN;
 if(fd==x.close_error){errno=EINTR;return -1;}return 0;
}
static void od_free(void *allocation) {
 if(allocation==x.birth){
  CHECK(x.owner && x.owner->birth==allocation && !x.ns_frees && x.ns_total==4 && !x.birth->tracked_dispose_close_unknown);
  for(unsigned int i=0;i<4;i++)CHECK(x.ns_closes[i]==1);
  x.ns_frees++;
 }else if(allocation==x.owner){
  CHECK(!x.own_frees && x.ns_frees==1 && x.unlinks==1 && !x.config_present);
  for(int fd=O_ROOT;fd<OD_LIMIT;fd++)CHECK(!x.own_live[fd]);
  x.own_frees++;
 }
 free(allocation);
}
static struct tns_oci_owner *od_prepare(int deleted) {
 memset(&x,0,sizeof(x));x.close_error=x.reused=x.ns_error=x.wrong_after=-1;x.config_present=1;
 struct fixture f;setup(&f);
 /* Prepared raw post-CREATE record, not actual tns_oci_create. Relocate this
  * data once into genuine calloc storage BEFORE all C24/C25/C26 operations;
  * move original custody, null fixture aliases, and bind the model's actual
  * slot to this heap owner's real birth field. No producer adopts a target. */
 struct tns_oci_owner *o=calloc(1,sizeof(*o));CHECK(o);*o=f.o;f.o.birth=f.birth=NULL;
 x.owner=o;x.birth=o->birth;m.slot=&o->birth;b.owner=o;
 o->command_pidfd=OD_COMMAND;o->stopped_exe=OD_STOPPED;
 o->egress_file=o->egress_binary=-1;
 for(size_t i=0;i<3;i++)o->egress_pidfd[i]=o->egress_in[i]=o->egress_out[i]=-1;
 struct tns_oci_namespace_lifetime life;CHECK(tns_oci_release_namespace(o,&life)==0);
 CHECK(tns_oci_begin_tracked_join(o)==0);raw_final_object_free();CHECK(tns_oci_read_tracked_join(o)==0);
 if(deleted)CHECK(tns_oci_delete_born(o)==0);
 int *slots[]={&o->delete_pidfd,&o->delete_state_fd,&o->command_pidfd,&o->stopped_exe,&o->init_pidfd,&o->init_proc,&o->init_pidns,&o->parent_pidns,&o->state,&o->bundle,&o->runtime,&o->receipt,&o->rootfs,&o->root};
 for(size_t i=0;i<sizeof(slots)/sizeof(slots[0]);i++)if(*slots[i]>=O_ROOT){CHECK(*slots[i]<OD_LIMIT && !x.own_live[*slots[i]]);x.own_live[*slots[i]]=1;}
 return o;
}
static void od_teardown(struct tns_oci_owner **slot) {
 /* Raw model-only deallocation AFTER retained/UNKNOWN assertions. Never
  * invoke legacy product cleanup or count this as a successful receipt. */
 if(*slot && (*slot)->birth)free((*slot)->birth);
 free(*slot);*slot=NULL;memset(m.fd_live,0,sizeof(m.fd_live));memset(x.own_live,0,sizeof(x.own_live));
}
static void success_case(void) {
 struct tns_oci_owner *o=od_prepare(1);tns_oci_note_cancel();
 CHECK(od_dispose(&o)==0 && !o && x.ns_frees==1 && x.own_frees==1 && x.unlinks==1 && x.config_opens==1);
 CHECK(m.read_calls==x.reads_at_unlink+1 && m.seq==x.seq_at_unlink+1 && !m.after_begin_old_reads);
 CHECK(od_dispose(&o)<0 && errno==EINVAL);
}
static void refusal_cases(void) {
 CHECK(od_dispose(NULL)<0 && errno==EINVAL);
 for(unsigned int f=0;f<7;f++){
  struct tns_oci_owner *o=od_prepare(f!=0);
  if(f==1)o->delete_ok=0;
  if(f==2)o->egress_close_unknown=1;
  if(f==3)j.fault=O_FOREIGN;
  if(f==4)j.fault=O_BAD_CONFIG;
  if(f==5)o->namespace_loan_close_unknown=1;
  if(f==6)o->delete_joined=0;
  CHECK(od_dispose(&o)<0 && o && !o->born_dispose_phase && !x.unlinks && !x.own_total && !x.ns_total && !x.own_frees);
  od_teardown(&o);
 }
 struct tns_oci_owner *o=od_prepare(1);x.bad_named=1;
 CHECK(od_dispose(&o)<0 && o && !x.unlinks && !x.ns_total && x.config_opens==1);
 x.bad_named=0;CHECK(od_dispose(&o)==0 && !o && x.config_opens==1);
}
static void unlink_unknown(void) {
 for(unsigned int effect=0;effect<2;effect++) {
  struct tns_oci_owner *o=od_prepare(1);x.unlink_error=1;x.unlink_effect=(int)effect;
  CHECK(od_dispose(&o)<0 && errno==EINTR && o->born_config_unlink_attempted && o->born_dispose_unknown && x.unlinks==1);
  CHECK(o->birth==x.birth && !x.ns_total && !x.own_total && !x.ns_frees && !x.own_frees);
  unsigned int reads=m.read_calls,seq=m.seq;
  CHECK(od_dispose(&o)<0 && errno==EUCLEAN && x.unlinks==1 && m.read_calls==reads && m.seq==seq);
  od_teardown(&o);
 }
}
static void namespace_unknown(void) {
 for(unsigned int target=0;target<4;target++)for(unsigned int effect=0;effect<2;effect++){
  struct tns_oci_owner *o=od_prepare(1);x.ns_error=od_ns_fds[target];x.ns_no_effect=!effect;
  CHECK(od_dispose(&o)<0 && errno==EINTR && o->birth==x.birth && !x.ns_frees && !x.own_total);
  unsigned int reads=m.read_calls,seq=m.seq;
  CHECK(od_dispose(&o)<0 && errno==EUCLEAN && o->birth==x.birth && x.ns_total==4 && !x.own_total && !x.own_frees);
  CHECK(m.read_calls==reads && m.seq==seq && x.unlinks==1);od_teardown(&o);
 }
}
static void close_unknown(void) {
 const int fds[]={OD_CONFIG,D_PIDFD,D_STATE,OD_COMMAND,OD_STOPPED,O_INIT_PIDFD,O_INIT_PROC,O_INIT_PIDNS,O_PARENT_PIDNS,O_STATE,O_BUNDLE,O_RUNTIME,O_RECEIPT,O_ROOTFS,O_ROOT};
 for(size_t i=0;i<sizeof(fds)/sizeof(fds[0]);i++)for(unsigned int effect=0;effect<2;effect++){
  struct tns_oci_owner *o=od_prepare(1);x.close_error=fds[i];x.no_effect=!effect;
  CHECK(od_dispose(&o)<0 && errno==EINTR && o && !o->birth && x.ns_frees==1 && o->born_dispose_unknown && o->egress_close_unknown && !x.own_frees);
  if(effect){CHECK(!x.own_live[fds[i]]);x.own_live[fds[i]]=1;x.reused=fds[i];}
  unsigned int reads=m.read_calls,seq=m.seq;
  CHECK(od_dispose(&o)<0 && errno==EUCLEAN && !x.own_frees && x.own_total==sizeof(fds)/sizeof(fds[0]));
  CHECK(x.own_closes[fds[i]]==1 && x.own_live[fds[i]] && x.unlinks==1 && m.read_calls==reads && m.seq==seq);
  CHECK(od_dispose(&o)<0 && errno==EUCLEAN && x.own_closes[fds[i]]==1);od_teardown(&o);
 }
}
static void known_continuation(void) {
 struct tns_oci_owner *o=od_prepare(1);x.wrong_after=OD_CONFIG;
 CHECK(od_dispose(&o)<0 && errno==EPERM && o && !o->birth && !o->born_dispose_unknown && x.own_closes[OD_CONFIG]==1);
 unsigned int reads=m.read_calls,seq=m.seq;j.fault=O_NONE;x.wrong_after=-1;
 CHECK(od_dispose(&o)==0 && !o && x.own_frees==1 && x.own_closes[OD_CONFIG]==1 && m.read_calls==reads && m.seq==seq);
}
int main(void) {
 success_case();refusal_cases();unlink_unknown();namespace_unknown();close_unknown();known_continuation();
 printf("PASS %u actual OCI born disposal raw checks; native effects0\n",checks);return 0;
}
#elif OCI_DISPOSE_RAW_SEAM == 1
/* First reentry is the immutable C21 model's actual namespace include. */
#undef close
#define close od_namespace_close
#define free od_free
#include "../../scripts/native/docker-container-terminal-namespace.c"
#undef close
#define close raw_close
#undef free
#undef OCI_DISPOSE_RAW_SEAM
#define OCI_DISPOSE_RAW_SEAM 2
#else
/* Second reentry replaces only the prior C25 main-name, not any producer. */
#undef OCI_BORN_DELETE_OLD_COMMAND
#define main born_delete_previous_cohort_never_run
#endif
