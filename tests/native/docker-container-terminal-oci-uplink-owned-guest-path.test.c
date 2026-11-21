/* Original owned guest link inventory, closed pure syscall/byte models only.
 * Reuses the admission model without running its old main/cases. The real
 * namespace/OCI/uplink bodies run over a prepared original owner; no whole
 * constructor, actual kernel/runc/device/socket/netns/process executes.
 *
 * Repo-only extraction at product root (OUT is existing private scratch):
 * python3 - "$OUT/guest-body.inc" <<'PY'
 * import pathlib,re,sys
 * s=pathlib.Path('scripts/native/docker-container-terminal-oci-uplink.h').read_text()
 * names=['dump_side','preflight','fresh_guest','pair','new_pair',
 *        'config_readback','install','absent','cleanup']
 * bodies=[]
 * for n in names:
 *   m=re.search(r'^static [^\n]*\boci_uplink_'+n+r'\([^\n]*\) \{\n.*?^\}',s,re.M|re.S)
 *   assert m,n
 *   bodies.append(m.group())
 * pathlib.Path(sys.argv[1]).write_text('\n\n'.join(bodies)+'\n')
 * PY
 * cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wpedantic \
 *   -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie \
 *   -DGUEST_BODY='"'"$OUT/guest-body.inc"'"' \
 *   tests/native/docker-container-terminal-oci-uplink-owned-guest-path.test.c \
 *   -o "$OUT/guest-test"
 * "$OUT/guest-test" --extra   # Original source: acceptance counterexample RED.
 * "$OUT/guest-test" --all     # Revised source: new focused inventory cases.
 */
#define main prior_admission_main_never_called
#include "docker-container-terminal-oci-admission.test.c"
#undef main
#ifndef GUEST_BODY
#error "Extract the exact nine original definitions using the recipe above"
#endif
static struct {
  int extra_guest, extra_host, missing_lo, duplicate_lo, duplicate_peer;
  int rename_lo, index_lo, type_lo, missing_loopback_flag, lo_up, lo_dynamic;
  int malformed_lo, malformed_extra, collide_lo_peer, precreate_extra, cancel_read;
  unsigned int guest_reads;
} guest_model;
static ssize_t guest_recvmsg(int fd,struct msghdr *m,int flags);
#define oci_uplink_dump_side measured_dump_side
#define oci_uplink_preflight measured_preflight
#define oci_uplink_fresh_guest measured_fresh_guest
#define oci_uplink_pair measured_pair
#define oci_uplink_new_pair measured_new_pair
#define oci_uplink_config_readback measured_config_readback
#define oci_uplink_install measured_install
#define oci_uplink_absent measured_absent
#define oci_uplink_cleanup measured_cleanup
#define recvmsg guest_recvmsg
#define sendmsg up_sendmsg
#define poll raw_poll
#define getpid raw_getpid
#define syscall raw_syscall
#include GUEST_BODY
#undef syscall
#undef getpid
#undef poll
#undef sendmsg
#undef recvmsg
#undef oci_uplink_cleanup
#undef oci_uplink_absent
#undef oci_uplink_install
#undef oci_uplink_config_readback
#undef oci_uplink_new_pair
#undef oci_uplink_pair
#undef oci_uplink_fresh_guest
#undef oci_uplink_preflight
#undef oci_uplink_dump_side
static void extra_link(struct oci_uplink_request *r,const char *name,int index) {
  const unsigned char mac[6]={2,7,8,9,10,11};raw_link(r,name,index,IFF_UP,mac,0);
  ((struct ifinfomsg *)(void *)r->body)->ifi_type=ARPHRD_ETHER;
  size_t nest=NLMSG_ALIGN((size_t)r->h.nlmsg_len);
  CHECK(oci_uplink_attr(r,IFLA_LINKINFO,"",0)==0);
  CHECK(oci_uplink_attr(r,IFLA_INFO_KIND,"dummy",6)==0 && oci_uplink_end(r,nest)==0);
  if(guest_model.malformed_extra)CHECK(oci_uplink_attr(r,IFLA_IFNAME,name,strlen(name)+1)==0);
}
static ssize_t guest_recvmsg(int fd,struct msghdr *m,int flags) {
  ssize_t n=up_recvmsg(fd,m,flags);
  if(n<=0 || (fd!=405 && fd!=407) || up.request.nlmsg_type!=RTM_GETLINK)return n;
  struct {struct nlmsghdr h;int result;} done;
  CHECK((size_t)n>=sizeof(done));unsigned char *bytes=m->msg_iov[0].iov_base;
  memcpy(&done,bytes+(size_t)n-sizeof(done),sizeof(done));CHECK(done.h.nlmsg_type==NLMSG_DONE);
  if(fd==407) {
    if(!guest_model.extra_host)return n;
    struct oci_uplink_request r;extra_link(&r,"other-host0",99);
    size_t at=(size_t)n-sizeof(done);at=raw_append(bytes,at,&r,901);
    CHECK(at+sizeof(done)<=m->msg_iov[0].iov_len);memcpy(bytes+at,&done,sizeof(done));return (ssize_t)(at+sizeof(done));
  }
  guest_model.guest_reads++;size_t at=0;struct oci_uplink_request r;
  if(!guest_model.missing_lo) {
    unsigned int lo_flags=guest_model.missing_loopback_flag ? 0u : IFF_LOOPBACK;
    if(guest_model.lo_up)lo_flags|=IFF_UP;
    if(guest_model.lo_dynamic)lo_flags|=IFF_RUNNING|IFF_LOWER_UP;
    raw_link(&r,guest_model.rename_lo ? "xo" : "lo",guest_model.index_lo ? 7 : 1,lo_flags,NULL,0);
    if(guest_model.type_lo)((struct ifinfomsg *)(void *)r.body)->ifi_type=ARPHRD_ETHER;
    if(guest_model.malformed_lo)CHECK(oci_uplink_attr(&r,IFLA_IFNAME,"lo",3)==0);
    at=raw_append(bytes,at,&r,900);
    if(guest_model.duplicate_lo)at=raw_append(bytes,at,&r,900);
  }
  if(up.created && !up.removed) {
    raw_link(&r,subject->guest_name,guest_model.collide_lo_peer ? 1 : 51,up.up[1] ? IFF_UP : 0,subject->guest_mac,50);
    at=raw_append(bytes,at,&r,900);
    if(guest_model.duplicate_peer)at=raw_append(bytes,at,&r,900);
  }
  if(guest_model.extra_guest && (up.created || guest_model.precreate_extra)) {
    extra_link(&r,"foreign0",99);at=raw_append(bytes,at,&r,900);
  }
  CHECK(at+sizeof(done)<=m->msg_iov[0].iov_len);memcpy(bytes+at,&done,sizeof(done));
  if(guest_model.cancel_read)tns_oci_note_cancel();
  return (ssize_t)(at+sizeof(done));
}
static void guest_prepare(struct tns_oci_owner *o,struct tns_owner *b,int installed) {
  memset(&guest_model,0,sizeof(guest_model));prepare(o,b);
  if(installed)CHECK(measured_install(o,subject)==0 && up.creates==1 && subject->configured);
  else CHECK(oci_uplink_guest_channel(o,subject)==0 && oci_uplink_host_channel(subject)==0);
}
static void guest_cleanup(struct tns_oci_owner *o) {
  CHECK(measured_cleanup(&o->uplink)==0 && !o->uplink);subject=NULL;
}
static void extra_counterexample(void) {
  struct tns_oci_owner o;struct tns_owner b;guest_prepare(&o,&b,1);guest_model.extra_guest=1;
  int result=measured_pair(subject);printf("actual original pair with foreign guest interface: %d (must refuse)\n",result);fflush(stdout);
  CHECK(result<0 && !subject->broken && !up.deletes);
  struct oci_uplink_owner *retained=subject;
  CHECK(measured_cleanup(&o.uplink)<0 && o.uplink==retained && !subject->delete_sent && !up.deletes);
  guest_model.extra_guest=0;tns_oci_note_cancel();guest_cleanup(&o);CHECK(up.deletes==1);
}
static void normal_and_runtime_flags(void) {
  struct tns_oci_owner o;struct tns_owner b;guest_prepare(&o,&b,1);
  CHECK(measured_pair(subject)==0 && measured_config_readback(subject)==0);
  /* runc may legitimately bring this SAME original loopback UP. Confinement
   * checks immutable identity/LOOPBACK, not its ordinary dynamic liveness. */
  guest_model.lo_up=guest_model.lo_dynamic=1;
  CHECK(measured_pair(subject)==0 && measured_config_readback(subject)==0);
  guest_model.extra_host=1;CHECK(measured_pair(subject)==0 && measured_config_readback(subject)==0);
  unsigned int creates=up.creates;CHECK(measured_install(&o,subject)<0 && up.creates==creates);
  guest_cleanup(&o);CHECK(up.deletes==1);
}
static void guest_inventory_refusals(void) {
  struct tns_oci_owner o;struct tns_owner b;
  for(int fault=1;fault<=9;++fault) {
    guest_prepare(&o,&b,1);
    if(fault==1)guest_model.missing_lo=1;
    if(fault==2)guest_model.duplicate_lo=1;
    if(fault==3)guest_model.rename_lo=1;
    if(fault==4)guest_model.index_lo=1;
    if(fault==5)guest_model.type_lo=1;
    if(fault==6)guest_model.missing_loopback_flag=1;
    if(fault==7)guest_model.malformed_lo=1;
    if(fault==8)guest_model.duplicate_peer=1;
    if(fault==9)guest_model.collide_lo_peer=1;
    uint32_t host=subject->host_index,guest=subject->guest_index;unsigned int mutations=up.mutations;
    CHECK(measured_pair(subject)<0 && !subject->broken && !subject->delete_sent && up.mutations==mutations);
    CHECK(subject->host_index==host && subject->guest_index==guest);
    guest_model.missing_lo=guest_model.duplicate_lo=guest_model.rename_lo=guest_model.index_lo=0;
    guest_model.type_lo=guest_model.missing_loopback_flag=guest_model.malformed_lo=0;
    guest_model.duplicate_peer=guest_model.collide_lo_peer=0;guest_cleanup(&o);
  }
  guest_prepare(&o,&b,1);guest_model.extra_guest=guest_model.malformed_extra=1;
  CHECK(measured_pair(subject)<0 && !up.deletes);guest_model.extra_guest=guest_model.malformed_extra=0;guest_cleanup(&o);
}
static void fresh_and_currentness(void) {
  struct tns_oci_owner o;struct tns_owner b;
  guest_prepare(&o,&b,0);guest_model.lo_up=1;
  CHECK(measured_fresh_guest(subject)<0 && !up.creates && !up.mutations);guest_model.lo_up=0;guest_cleanup(&o);
  guest_prepare(&o,&b,0);guest_model.extra_guest=guest_model.precreate_extra=1;
  CHECK(measured_fresh_guest(subject)<0 && !up.creates);guest_model.extra_guest=0;guest_cleanup(&o);
  guest_prepare(&o,&b,0);CHECK(measured_fresh_guest(subject)==0);guest_model.index_lo=1;
  CHECK(measured_fresh_guest(subject)<0 && !up.creates);guest_model.index_lo=0;guest_cleanup(&o);
  guest_prepare(&o,&b,1);model.fault=WRONG_CONTROLLER;unsigned int reads=guest_model.guest_reads;
  CHECK(measured_pair(subject)<0 && guest_model.guest_reads==reads);model.fault=NONE;guest_cleanup(&o);
  guest_prepare(&o,&b,1);model.fault=BAD_COOKIE;
  CHECK(measured_pair(subject)<0 && !up.deletes);model.fault=NONE;guest_cleanup(&o);
  guest_prepare(&o,&b,1);up.read_fault=1;
  CHECK(measured_pair(subject)<0 && subject->broken && !up.deletes);up.read_fault=0;
  CHECK(measured_cleanup(&o.uplink)<0 && o.uplink==subject && !subject->delete_sent && !up.deletes);
  discard(&o); /* Raw-only memory after retained UNKNOWN, never product cleanup. */
  guest_prepare(&o,&b,1);guest_model.cancel_read=1;
  CHECK(measured_pair(subject)<0 && subject->broken && !up.deletes);guest_model.cancel_read=0;
  CHECK(measured_cleanup(&o.uplink)<0 && o.uplink==subject && !subject->delete_sent && !up.deletes);
  discard(&o); /* No actual FD exists in this raw model. */
}
int main(int argc,char **argv) {
  CHECK(argc==2);
  if(!strcmp(argv[1],"--extra"))extra_counterexample();
  else {CHECK(!strcmp(argv[1],"--all"));extra_counterexample();normal_and_runtime_flags();guest_inventory_refusals();fresh_and_currentness();}
  printf("new original owned guest path raw boundary: %lu checks\n",checks);return 0;
}
