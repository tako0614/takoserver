/* Pure original Host driver/feature GET boundary; no native main or kernel IO.
 * Reuses the admission raw syscall model, never its old main/cases.
 * The new selected bodies are exact definitions, with symbol names redirected
 * only so the new ioctl/socket model can be used without editing old fixtures.
 * Prepared original owner structures are data, not a constructor qualification.
 *
 * Repo-only extraction recipe (run at product root; OUT is private scratch):
 * python3 - "$OUT/driver-body.inc" <<'PY'
 * import pathlib,re,sys
 * s=pathlib.Path('scripts/native/docker-container-terminal-oci-uplink.h').read_text()
 * names=['socket_identity','driver_link','driver_string','driver_current',
 *        'preflight','new_pair','config_readback','install']
 * bodies=[]
 * for n in names:
 *   m=re.search(r'^static [^\n]*\boci_uplink_'+n+r'\([^\n]*\) \{\n.*?^\}',s,re.M|re.S)
 *   assert m,n
 *   bodies.append(m.group())
 * pathlib.Path(sys.argv[1]).write_text('\n\n'.join(bodies)+'\n')
 * PY
 * cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wpedantic \
 *   -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie \
 *   -DDRIVER_BODY='"'"$OUT/driver-body.inc"'"' \
 *   tests/native/docker-container-terminal-oci-uplink-driver-features.test.c \
 *   -o "$OUT/driver-test"
 * "$OUT/driver-test"
 */
#define main previous_uplink_main_never_called
#include "docker-container-terminal-oci-admission.test.c"
#undef main
#ifndef DRIVER_BODY
#error "Extract the exact eight original definitions using the recipe above"
#endif
static struct {
  int fault, query_fault, post_index, post_mac, post_name, post_family;
  int socket_fault, socket_after, cancel_at;
  unsigned int gets, driver_gets, feature_gets, identity_gets, cookie_gets;
  unsigned int variation;
} driver_model;
enum {
  DRIVER_UNSUPPORTED = 1, DRIVER_POSITIVE, DRIVER_TRUNCATED, DRIVER_CMD,
  DRIVER_EMPTY, DRIVER_NO_NUL, DRIVER_RESERVED, DRIVER_NAME, DRIVER_POINTER,
  FEATURE_UNSUPPORTED, FEATURE_POSITIVE, FEATURE_TRUNCATED, FEATURE_CMD,
  FEATURE_ZERO, FEATURE_TOO_LARGE, FEATURE_TAIL, FEATURE_NAME, FEATURE_POINTER
};
static int driver_ioctl(int fd, unsigned long request, ...);
static int driver_getsockopt(int fd, int level, int option, void *value, socklen_t *size);
#define oci_uplink_socket_identity measured_socket_identity
#define oci_uplink_driver_link measured_driver_link
#define oci_uplink_driver_string measured_driver_string
#define oci_uplink_driver_current measured_driver_current
#define oci_uplink_preflight measured_preflight
#define oci_uplink_new_pair measured_new_pair
#define oci_uplink_config_readback measured_config_readback
#define oci_uplink_install measured_install
#define ioctl driver_ioctl
#define getsockopt driver_getsockopt
#define getsockname up_getsockname
#define fcntl eg_fcntl
#define getpid raw_getpid
#include DRIVER_BODY
#undef getpid
#undef fcntl
#undef getsockname
#undef getsockopt
#undef ioctl
#undef oci_uplink_install
#undef oci_uplink_config_readback
#undef oci_uplink_new_pair
#undef oci_uplink_preflight
#undef oci_uplink_driver_current
#undef oci_uplink_driver_string
#undef oci_uplink_driver_link
#undef oci_uplink_socket_identity
static int driver_getsockopt(int fd, int level, int option, void *value, socklen_t *size) {
  int result = up_getsockopt(fd, level, option, value, size);
  if (option == SO_NETNS_COOKIE && fd == 407) {
    driver_model.cookie_gets++;
    if (driver_model.socket_fault && (!driver_model.socket_after || driver_model.feature_gets)) {
      if (driver_model.socket_fault == 1) *(uint64_t *)value += 1;
      if (driver_model.socket_fault == 2) *size -= 1;
    }
  }
  return result;
}
static int driver_ioctl(int fd, unsigned long request, ...) {
  CHECK(subject && fd == subject->host && fd == 407);
  va_list ap; va_start(ap, request); struct ifreq *in = va_arg(ap, struct ifreq *); va_end(ap);
  CHECK(!memcmp(in->ifr_name, subject->expected.name, sizeof(in->ifr_name)));
  driver_model.gets++;
  if (request == SIOCGIFINDEX || request == SIOCGIFHWADDR) {
    driver_model.identity_gets++;
    int post = driver_model.feature_gets != 0;
    if (request == SIOCGIFINDEX) in->ifr_ifindex = (int)subject->expected.index + (post && driver_model.post_index);
    else {
      in->ifr_hwaddr.sa_family = (sa_family_t)(post && driver_model.post_family ? ARPHRD_LOOPBACK : ARPHRD_ETHER);
      memcpy(in->ifr_hwaddr.sa_data, subject->expected.mac, 6);
      if (post && driver_model.post_mac) in->ifr_hwaddr.sa_data[0] ^= 1;
    }
    if (post && driver_model.post_name) in->ifr_name[0] ^= 1;
    return 0;
  }
  /* Every other command is a model failure; SET and foreign ioctl cannot pass. */
  CHECK(request == SIOCETHTOOL && in->ifr_data);
  uint32_t cmd; memcpy(&cmd, in->ifr_data, sizeof(cmd));
  if (cmd == ETHTOOL_GDRVINFO) {
    driver_model.driver_gets++;
    struct ethtool_drvinfo *out = (void *)in->ifr_data;
    memset(out, 0, sizeof(*out)); out->cmd = ETHTOOL_GDRVINFO;
    strcpy(out->driver, "raw-original-driver"); strcpy(out->version, "6.12");
    strcpy(out->bus_info, "original-bus"); out->n_stats = 9;
    int f = driver_model.fault;
    if (f == DRIVER_UNSUPPORTED) { errno = EOPNOTSUPP; return -1; }
    if (f == DRIVER_POSITIVE) return 1;
    if (f == DRIVER_TRUNCATED) { errno = EFAULT; return -1; }
    if (f == DRIVER_CMD) out->cmd = ETHTOOL_GFEATURES;
    if (f == DRIVER_EMPTY) out->driver[0] = 0;
    if (f == DRIVER_NO_NUL) {
      char *fields[] = {out->driver,out->version,out->fw_version,out->bus_info,out->erom_version};
      size_t sizes[] = {sizeof(out->driver),sizeof(out->version),sizeof(out->fw_version),sizeof(out->bus_info),sizeof(out->erom_version)};
      CHECK(driver_model.variation < 5); memset(fields[driver_model.variation], 'x', sizes[driver_model.variation]);
    }
    if (f == DRIVER_RESERVED) out->reserved2[driver_model.variation % sizeof(out->reserved2)] = 1;
    if (f == DRIVER_NAME) in->ifr_name[0] ^= 1;
    if (f == DRIVER_POINTER) in->ifr_data = NULL;
    if (driver_model.query_fault == 1) out->driver[0] ^= 1;
  } else {
    CHECK(cmd == ETHTOOL_GFEATURES); driver_model.feature_gets++;
    struct oci_uplink_features *out = (void *)in->ifr_data;
    CHECK(out->size == OCI_UPLINK_FEATURE_WORDS);
    out->size = 2;
    for (size_t i = 0; i < out->size; ++i) {
      out->blocks[i].available = 0x1234u + (uint32_t)i;
      out->blocks[i].requested = 0x2345u + (uint32_t)i;
      out->blocks[i].active = 0x3456u + (uint32_t)i;
      out->blocks[i].never_changed = 0x4567u + (uint32_t)i;
    }
    int f = driver_model.fault;
    if (f == FEATURE_UNSUPPORTED) { errno = EOPNOTSUPP; return -1; }
    if (f == FEATURE_POSITIVE) return 1;
    if (f == FEATURE_TRUNCATED) { errno = EFAULT; return -1; }
    if (f == FEATURE_CMD) out->cmd = ETHTOOL_SFEATURES;
    if (f == FEATURE_ZERO) out->size = 0;
    if (f == FEATURE_TOO_LARGE) out->size = OCI_UPLINK_FEATURE_WORDS + 1;
    if (f == FEATURE_TAIL) out->blocks[2].active = 1;
    if (f == FEATURE_NAME) in->ifr_name[0] ^= 1;
    if (f == FEATURE_POINTER) in->ifr_data = NULL;
    if (driver_model.query_fault == 2) out->blocks[1].active ^= 1;
    if (driver_model.cancel_at) tns_oci_note_cancel();
  }
  return 0;
}
static void driver_prepare(struct tns_oci_owner *o, struct tns_owner *b, int channels) {
  memset(&driver_model, 0, sizeof(driver_model)); prepare(o, b);
  if (channels) {
    CHECK(oci_uplink_guest_channel(o, subject) == 0);
    CHECK(oci_uplink_host_channel(subject) == 0);
  }
}
static void driver_cleanup(struct tns_oci_owner *o) {
  CHECK(oci_uplink_cleanup(&o->uplink) == 0 && !o->uplink);
  subject = NULL;
}
static void positive_and_integration(void) {
  struct tns_oci_owner o; struct tns_owner b;
  driver_prepare(&o,&b,0);
  CHECK(measured_install(&o,subject)==0 && subject->configured && subject->driver_attempted==1 && subject->driver_captured==1);
  CHECK(driver_model.driver_gets==2 && driver_model.feature_gets==2 && driver_model.identity_gets==8 && up.creates==1);
  CHECK(!strcmp(subject->driver_facts.driver.driver,"raw-original-driver"));
  CHECK(subject->driver_facts.features.size==2 && subject->driver_facts.features.blocks[1].active==0x3457u);
  CHECK(measured_config_readback(subject)==0 && driver_model.feature_gets==3);
  struct oci_uplink_driver_facts retained=subject->driver_facts;
  driver_model.query_fault=2;
  CHECK(measured_preflight(subject)<0 && !subject->broken && !memcmp(&retained,&subject->driver_facts,sizeof(retained)));
  /* A profile mismatch fences normal use, while original known-pair cleanup
   * still uses its cancel-independent original controller/namespace authority. */
  unsigned int gets=driver_model.gets; tns_oci_note_cancel();
  driver_cleanup(&o); CHECK(up.deletes==1 && driver_model.gets==gets);
  driver_prepare(&o,&b,1);
  CHECK(measured_preflight(subject)==0 && !up.creates);
  CHECK(measured_preflight(subject)==0 && driver_model.feature_gets==2);
  driver_cleanup(&o);
}
static void malformed_replies(void) {
  struct tns_oci_owner o; struct tns_owner b;
  for(int fault=DRIVER_UNSUPPORTED;fault<=FEATURE_POINTER;++fault) {
    unsigned int count=fault==DRIVER_NO_NUL ? 5u : fault==DRIVER_RESERVED ? 12u : 1u;
    for(unsigned int v=0;v<count;++v) {
      driver_prepare(&o,&b,1); driver_model.fault=fault;driver_model.variation=v;
      CHECK(measured_preflight(subject)<0 && subject->driver_attempted==1 && !subject->driver_captured && !subject->broken && !up.mutations);
      unsigned int gets=driver_model.gets; driver_model.fault=0;
      CHECK(measured_preflight(subject)<0 && driver_model.gets==gets && !up.mutations);
      driver_cleanup(&o);
    }
  }
}
static void identity_and_currentness(void) {
  struct tns_oci_owner o; struct tns_owner b;
  for(int f=1;f<=4;++f) {
    driver_prepare(&o,&b,1);
    if(f==1)driver_model.post_index=1;
    if(f==2)driver_model.post_mac=1;
    if(f==3)driver_model.post_family=1;
    if(f==4)driver_model.post_name=1;
    CHECK(measured_driver_current(subject)<0 && !subject->driver_captured && !up.mutations);
    driver_cleanup(&o);
  }
  for(int f=1;f<=2;++f)for(int post=0;post<=1;++post) {
    driver_prepare(&o,&b,1);driver_model.socket_fault=f;driver_model.socket_after=post;
    CHECK(measured_driver_current(subject)<0 && !subject->driver_captured && !up.mutations);
    if(!post)CHECK(!driver_model.gets);
    driver_cleanup(&o);
  }
  driver_prepare(&o,&b,1);subject->host_port++;
  CHECK(measured_driver_current(subject)<0 && !driver_model.gets);subject->host_port--;driver_cleanup(&o);
  driver_prepare(&o,&b,1);subject->host=405;
  CHECK(measured_driver_current(subject)<0 && !driver_model.gets);subject->host=407;driver_cleanup(&o);
  driver_prepare(&o,&b,1);model.fault=WRONG_CONTROLLER;
  CHECK(measured_driver_current(subject)<0 && !driver_model.gets);model.fault=NONE;driver_cleanup(&o);
  driver_prepare(&o,&b,1);up.wrong_host=1;
  CHECK(measured_driver_current(subject)<0 && !driver_model.gets);up.wrong_host=0;driver_cleanup(&o);
  driver_prepare(&o,&b,1);model.fault=BAD_COOKIE;
  CHECK(measured_driver_current(subject)<0 && !driver_model.gets);model.fault=NONE;driver_cleanup(&o);
  driver_prepare(&o,&b,1);driver_model.cancel_at=1;
  CHECK(measured_driver_current(subject)<0 && !subject->driver_captured && !subject->broken);driver_cleanup(&o);
  driver_prepare(&o,&b,1);subject->create_sent=1;
  CHECK(measured_driver_current(subject)<0 && !driver_model.gets);subject->create_sent=0;driver_cleanup(&o);
}
int main(void) {
  positive_and_integration();malformed_replies();identity_and_currentness();
  printf("new actual original Host driver/features raw boundary: %lu checks\n",checks);
  return 0;
}
