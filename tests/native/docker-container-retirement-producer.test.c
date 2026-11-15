/* Actual ocipp_runtime_peer_bootstrap_reply is extracted into producer.inc
 * from the current owning header. No actual process, FD, socket or kernel.
 * NONSECRET claim/cookie bytes only. Existing C suites are not included. */
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
struct ocipp_owner {
  int runtime_first, attempted;
  void *create;
  char claim[65], boot_id[37];
  uint64_t generation, listener_cookie, self_device, self_inode;
};
static unsigned char output[160];
static size_t used;
static int current_failure, io_failure;
static int ocipp_self_current(struct ocipp_owner *o) { assert(o); return current_failure ? -1 : 0; }
static int64_t ocip_now(void) { return 100; }
static void ocipp_put64(unsigned char *p, uint64_t n) {
  for (unsigned int i=0;i<8;i++) p[i]=(unsigned char)(n>>(56-8*i));
}
static int ocip_io(int fd, void *p, size_t size, int writing, int eof, int64_t deadline) {
  assert(fd==1 && writing==1 && eof==0 && deadline==4100 && size<=sizeof(output));
  memcpy(output,p,size);used=size;return io_failure ? -1 : 0;
}
#include "producer.inc"
int main(void) {
  struct ocipp_owner o={.runtime_first=1,.generation=7,.listener_cookie=9,.self_device=11,.self_inode=13};
  memset(o.claim,'a',64);memcpy(o.boot_id,"11111111-2222-4333-8444-555555555555",37);
  assert(ocipp_runtime_peer_bootstrap_reply(&o)==0 && used==152);
  assert(output[3]==148 && memcmp(output+4,"TKOINFO3",8)==0);
  assert(memcmp(output+144,"NCLOSE01",8)==0 && memcmp(output+12,o.claim,64)==0);
  assert(memcmp(output+108,o.boot_id,36)==0 && output[83]==7 && output[91]==9 && output[99]==11 && output[107]==13);
  o.runtime_first=2;used=0;
  assert(ocipp_runtime_peer_bootstrap_reply(&o)==0 && used==144 && output[3]==140 && memcmp(output+4,"TKOINFO4",8)==0);
  o.runtime_first=1;used=0;current_failure=1;
  assert(ocipp_runtime_peer_bootstrap_reply(&o)<0 && used==0);
  current_failure=0;o.attempted=1;
  assert(ocipp_runtime_peer_bootstrap_reply(&o)<0 && used==0);
  o.attempted=0;o.create=&o;
  assert(ocipp_runtime_peer_bootstrap_reply(&o)<0 && used==0);
  o.create=NULL;io_failure=1;
  assert(ocipp_runtime_peer_bootstrap_reply(&o)<0 && used==152);
  puts("producer bootstrap raw: canonical/local4/current/attempted/create/write-error");
  return 0;
}
