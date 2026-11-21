/* Original selected Host path observation, pure raw IO only. No old main/case
 * or constructor/native operation runs. Include the unchanged prepared-owner
 * admission syscall model; exact five definitions are redirected only to add
 * independent RTM_NEWLINK input bytes. The new decoder/host_links definitions
 * are the actual header bodies included through that original TU.
 *
 * Repo-only extraction, at product root (OUT is existing private scratch):
 * python3 - "$OUT/path-body.inc" <<'PY'
 * import pathlib,re,sys
 * s=pathlib.Path('scripts/native/docker-container-terminal-oci-uplink.h').read_text()
 * names=['dump_side','preflight','new_pair','config_readback','install']
 * bodies=[]
 * for n in names:
 *   m=re.search(r'^static [^\n]*\boci_uplink_'+n+r'\([^\n]*\) \{\n.*?^\}',s,re.M|re.S)
 *   assert m,n
 *   bodies.append(m.group())
 * pathlib.Path(sys.argv[1]).write_text('\n\n'.join(bodies)+'\n')
 * PY
 * cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wpedantic \
 *   -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie \
 *   -DPATH_BODY='"'"$OUT/path-body.inc"'"' \
 *   tests/native/docker-container-terminal-oci-uplink-link-path.test.c \
 *   -o "$OUT/path-test"
 * "$OUT/path-test"
 */
#define main prior_admission_main_never_called
#include "docker-container-terminal-oci-admission.test.c"
#undef main
#ifndef PATH_BODY
#error "Extract the exact five original definitions using the recipe above"
#endif
static struct {
  unsigned int fields, link, captures;
  int32_t nsid;
  int malformed, cancel_read, opaque;
  char kind[1100];
} path_model;
enum { INFO=1, KIND=2, LINK=4, NSID=8 };
static ssize_t path_recvmsg(int fd, struct msghdr *message, int flags);
#define oci_uplink_dump_side measured_dump_side
#define oci_uplink_preflight measured_preflight
#define oci_uplink_new_pair measured_new_pair
#define oci_uplink_config_readback measured_config_readback
#define oci_uplink_install measured_install
#define recvmsg path_recvmsg
#define sendmsg up_sendmsg
#define poll raw_poll
#include PATH_BODY
#undef poll
#undef sendmsg
#undef recvmsg
#undef oci_uplink_install
#undef oci_uplink_config_readback
#undef oci_uplink_new_pair
#undef oci_uplink_preflight
#undef oci_uplink_dump_side
static void add_path(struct oci_uplink_request *r) {
  unsigned int fields=path_model.fields; int fault=path_model.malformed;
  if(fields&INFO) {
    size_t nest=NLMSG_ALIGN((size_t)r->h.nlmsg_len);
    CHECK(oci_uplink_attr(r,IFLA_LINKINFO | (fault==5 ? NLA_F_NESTED : 0),"",0)==0);
    if(fields&KIND) {
      size_t n=strlen(path_model.kind)+1;
      if(fault==7)n--;
      CHECK(oci_uplink_attr(r,IFLA_INFO_KIND | (fault==6 ? NLA_F_NESTED : 0),path_model.kind,n)==0);
      if(fault==8)r->body[r->h.nlmsg_len-NLMSG_HDRLEN-RTA_ALIGN(RTA_LENGTH(n))+sizeof(struct rtattr)+1]=0;
      if(fault==9)CHECK(oci_uplink_attr(r,IFLA_INFO_KIND,path_model.kind,n)==0);
    }
    if(path_model.opaque) {
      unsigned char bytes[3]={9,8,(unsigned char)path_model.opaque};
      CHECK(oci_uplink_attr(r,IFLA_INFO_DATA,bytes,sizeof(bytes))==0);
    }
    if(fault==13) {
      struct rtattr invalid={.rta_len=3,.rta_type=IFLA_INFO_DATA};
      CHECK((size_t)r->h.nlmsg_len+sizeof(invalid)<=sizeof(*r));
      memcpy((unsigned char *)r+r->h.nlmsg_len,&invalid,sizeof(invalid));r->h.nlmsg_len+=sizeof(invalid);
    }
    CHECK(oci_uplink_end(r,nest)==0);
    if(fault==12)CHECK(oci_uplink_attr(r,IFLA_LINKINFO,"",0)==0);
  }
  if(fields&LINK) {
    CHECK(oci_uplink_attr(r,IFLA_LINK | (fault==3 ? NLA_F_NESTED : 0),&path_model.link,fault==1 ? 3 : sizeof(path_model.link))==0);
    if(fault==10)CHECK(oci_uplink_attr(r,IFLA_LINK,&path_model.link,sizeof(path_model.link))==0);
  }
  if(fields&NSID) {
    CHECK(oci_uplink_attr(r,IFLA_LINK_NETNSID | (fault==4 ? NLA_F_NESTED : 0),&path_model.nsid,fault==2 ? 3 : sizeof(path_model.nsid))==0);
    if(fault==11)CHECK(oci_uplink_attr(r,IFLA_LINK_NETNSID,&path_model.nsid,sizeof(path_model.nsid))==0);
  }
}
static ssize_t path_recvmsg(int fd,struct msghdr *m,int flags) {
  ssize_t n=up_recvmsg(fd,m,flags);
  if(n<=0 || fd!=407 || up.request.nlmsg_type!=RTM_GETLINK)return n;
  unsigned char *bytes=m->msg_iov[0].iov_base;struct nlmsghdr before;memcpy(&before,bytes,sizeof(before));
  CHECK(before.nlmsg_type==RTM_NEWLINK && before.nlmsg_len<=(size_t)n);
  struct oci_uplink_request selected;
  raw_link(&selected,"eth0",2,IFF_UP,subject->expected.mac,0);
  ((struct ifinfomsg *)(void *)selected.body)->ifi_type=ARPHRD_ETHER;
  add_path(&selected);
  size_t old=NLMSG_ALIGN((size_t)before.nlmsg_len),now=NLMSG_ALIGN((size_t)selected.h.nlmsg_len);
  CHECK(now>=old && (size_t)n+now-old<=m->msg_iov[0].iov_len);
  memmove(bytes+now,bytes+old,(size_t)n-old);CHECK(raw_append(bytes,0,&selected,901)==now);
  path_model.captures++;
  if(path_model.cancel_read)tns_oci_note_cancel();
  return n+(ssize_t)(now-old);
}
static void path_prepare(struct tns_oci_owner *o,struct tns_owner *b) {
  memset(&path_model,0,sizeof(path_model));prepare(o,b);
  CHECK(oci_uplink_guest_channel(o,subject)==0 && oci_uplink_host_channel(subject)==0);
}
static void path_cleanup(struct tns_oci_owner *o) {
  CHECK(oci_uplink_cleanup(&o->uplink)==0 && !o->uplink);subject=NULL;
}
static void observation_forms(void) {
  struct tns_oci_owner o;struct tns_owner b;
  unsigned int forms[]={0,INFO,INFO|KIND,LINK,INFO|KIND|LINK|NSID};
  for(size_t i=0;i<sizeof(forms)/sizeof(forms[0]);++i) {
    path_prepare(&o,&b);path_model.fields=forms[i];path_model.link=0;path_model.nsid=-1;
    strcpy(path_model.kind,"unrecognized-kind-is-only-data");
    CHECK(measured_preflight(subject)==0 && subject->driver_captured && subject->link_path_captured && !up.mutations);
    const struct oci_uplink_link_path *p=&subject->link_path;
    CHECK(p->info_present==!!(forms[i]&INFO) && p->kind_present==!!(forms[i]&KIND));
    CHECK(p->link_present==!!(forms[i]&LINK) && p->netns_present==!!(forms[i]&NSID));
    if(p->kind_present)CHECK(p->kind_size==strlen(path_model.kind)+1 && !memcmp(p->kind,path_model.kind,p->kind_size));
    if(p->link_present)CHECK(p->link==0);
    if(p->netns_present)CHECK(p->netns==-1);
    CHECK(measured_preflight(subject)==0);path_cleanup(&o);
  }
  path_prepare(&o,&b);path_model.fields=INFO|KIND|LINK|NSID;path_model.link=UINT32_MAX;path_model.nsid=INT32_MIN;
  memset(path_model.kind,'q',1024);path_model.kind[1024]=0;
  CHECK(measured_preflight(subject)==0 && subject->link_path.kind_size==1025 && subject->link_path.netns==INT32_MIN && subject->link_path.link==UINT32_MAX);
  path_cleanup(&o);
  path_prepare(&o,&b);path_model.fields=INFO|KIND;
  CHECK(measured_preflight(subject)==0 && subject->link_path.kind_size==1 && subject->link_path.kind_present);
  path_cleanup(&o);
}
static void malformed_forms(void) {
  struct tns_oci_owner o;struct tns_owner b;
  for(int f=1;f<=13;++f) {
    path_prepare(&o,&b);path_model.fields=INFO|KIND|LINK|NSID;path_model.link=3;path_model.nsid=-1;
    strcpy(path_model.kind,"new-kind");path_model.malformed=f;
    CHECK(measured_preflight(subject)<0 && !subject->link_path_captured && !subject->driver_captured && !subject->broken && !up.mutations);
    path_cleanup(&o);
  }
}
static void changing_forms(void) {
  struct tns_oci_owner o;struct tns_owner b;
  for(int f=1;f<=8;++f) {
    path_prepare(&o,&b);path_model.fields=INFO|KIND|LINK|NSID;path_model.link=3;path_model.nsid=7;strcpy(path_model.kind,"veth");
    CHECK(measured_preflight(subject)==0);struct oci_uplink_link_path saved=subject->link_path;
    if(f==1)strcpy(path_model.kind,"other");
    if(f==2)path_model.link++;
    if(f==3)path_model.nsid++;
    if(f==4)path_model.fields&=~KIND;
    if(f==5)path_model.fields&=~LINK;
    if(f==6)path_model.fields&=~NSID;
    if(f==7)path_model.fields=0;
    if(f==8){path_model.fields=INFO;path_model.link=0;path_model.nsid=0;}
    CHECK(measured_preflight(subject)<0 && !memcmp(&saved,&subject->link_path,sizeof(saved)) && !subject->broken && !up.mutations);
    path_cleanup(&o);
  }
  path_prepare(&o,&b);CHECK(measured_preflight(subject)==0);path_model.fields=INFO;
  CHECK(measured_preflight(subject)<0 && !subject->link_path.info_present);path_cleanup(&o);
  /* INFO_DATA is deliberately opaque: equal selected descriptor does not
   * establish that lower parameters or the entire Host path stayed equal. */
  path_prepare(&o,&b);path_model.fields=INFO|KIND;strcpy(path_model.kind,"future");path_model.opaque=1;
  CHECK(measured_preflight(subject)==0);path_model.opaque=2;CHECK(measured_preflight(subject)==0);path_cleanup(&o);
}
static void currentness_and_cleanup(void) {
  struct tns_oci_owner o;struct tns_owner b;
  path_prepare(&o,&b);path_model.fields=INFO|KIND;strcpy(path_model.kind,"future");
  /* Later failure cannot promote the path observation into driver capture. */
  up.conflict=1;CHECK(measured_preflight(subject)<0 && subject->link_path_captured && !subject->driver_captured);
  up.conflict=0;strcpy(path_model.kind,"replacement");CHECK(measured_preflight(subject)<0 && !strcmp((char *)subject->link_path.kind,"future") && !subject->driver_captured);path_cleanup(&o);
  path_prepare(&o,&b);model.fault=WRONG_CONTROLLER;
  CHECK(measured_preflight(subject)<0 && !subject->link_path_captured);model.fault=NONE;path_cleanup(&o);
  path_prepare(&o,&b);up.wrong_host=1;
  CHECK(measured_preflight(subject)<0 && !subject->link_path_captured);up.wrong_host=0;path_cleanup(&o);
  path_prepare(&o,&b);model.fault=BAD_COOKIE;
  CHECK(measured_preflight(subject)<0 && !subject->link_path_captured);model.fault=NONE;path_cleanup(&o);
  path_prepare(&o,&b);up.read_fault=1;
  CHECK(measured_preflight(subject)<0 && !subject->link_path_captured && !subject->driver_captured);up.read_fault=0;path_cleanup(&o);
  path_prepare(&o,&b);path_model.cancel_read=1;
  CHECK(measured_preflight(subject)<0 && !subject->link_path_captured);path_cleanup(&o);
  path_prepare(&o,&b);subject->driver_captured=1;
  CHECK(measured_preflight(subject)<0 && !subject->link_path_captured);subject->driver_captured=0;path_cleanup(&o);
  memset(&path_model,0,sizeof(path_model));prepare(&o,&b);path_model.fields=INFO|KIND|LINK|NSID;strcpy(path_model.kind,"future");path_model.link=77;path_model.nsid=-1;
  CHECK(measured_install(&o,subject)==0 && subject->configured && subject->link_path_captured && up.creates==1);
  CHECK(measured_config_readback(subject)==0);path_model.link++;
  CHECK(measured_config_readback(subject)<0 && !subject->broken);
  unsigned int reads=path_model.captures;tns_oci_note_cancel();path_cleanup(&o);
  CHECK(up.deletes==1 && path_model.captures==reads);
}
static void netns_link_case(void) {
  struct tns_oci_owner o;struct tns_owner b;path_prepare(&o,&b);
  unsigned int partial[]={INFO|KIND|NSID,INFO|LINK|NSID,LINK|NSID};
  for(size_t i=0;i<sizeof(partial)/sizeof(partial[0]);++i) {
    if(i)path_prepare(&o,&b);
    path_model.fields=partial[i];path_model.nsid=-1;strcpy(path_model.kind,"unknown-original-kind");
    CHECK(measured_preflight(subject)<0 && !subject->link_path_captured && !subject->driver_captured && !up.mutations);
    path_cleanup(&o);
  }
  for(unsigned int link=0;link<2;++link)for(int ns=0;ns<2;++ns) {
    path_prepare(&o,&b);path_model.fields=INFO|KIND|LINK|NSID;strcpy(path_model.kind,"unknown-original-kind");
    path_model.link=link ? UINT32_MAX : 0;path_model.nsid=ns ? -1 : 0;
    CHECK(measured_preflight(subject)==0 && subject->link_path_captured && subject->driver_captured && !up.mutations);
    CHECK(subject->link_path.link_present && subject->link_path.netns_present &&
          subject->link_path.link==path_model.link && subject->link_path.netns==path_model.nsid);
    CHECK(measured_preflight(subject)==0);path_cleanup(&o);
  }
}
int main(int argc,char **argv) {
  if(argc==2 && !strcmp(argv[1],"--netns-link")) {
    netns_link_case();printf("new exact netns/link dependency: %lu checks\n",checks);return 0;
  }
  CHECK(argc==1);
  observation_forms();malformed_forms();changing_forms();currentness_and_cleanup();netns_link_case();
  printf("new actual original Host link-path raw boundary: %lu checks\n",checks);return 0;
}
