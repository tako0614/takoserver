/* Actual new source bodies over the existing CLOSED syscall model. Old main
 * and cases compile but never run (link with -Wl,--wrap=main). No OS helper,
 * socket, clone, pidfd or wait is executed. NONSECRET fixed bootstrap bytes.
 * cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wpedantic -Wshadow -Wformat=2
 * -Wstrict-prototypes -Wmissing-prototypes -fsanitize=address,undefined
 * -fno-omit-frame-pointer -fno-pie -no-pie
 * tests/native/docker-container-application-owner-origin.test.c
 * -Wl,--wrap=main -o "$OUT/application-owner-raw"
 */
int prior_admission_main_never_called(int argc,char **argv);
int prior_codec_main_never_called(void);
int parent_mode_main_never_called(int argc,char **argv);
#include "docker-container-terminal-oci-parent.test.c"

enum { ORIGIN_NONE,ORIGIN_UNSUPPORTED,ORIGIN_SHORT,ORIGIN_REPARENT,
       ORIGIN_FOREIGN,ORIGIN_COOKIE,ORIGIN_ALREADY_DEAD,ORIGIN_PIDFS,ORIGIN_BOOT };
static int origin_prepare(struct ocipp_owner *o,int fault) {
  memset(&pm,0,sizeof(pm));ocipp_interrupted=0;
  pm.sent=calloc(1,TNS_OCI_MAX_JSON+4);pm.frontend_sent=calloc(1,TNS_OCI_MAX_JSON+1024);
  CHECK(pm.sent && pm.frontend_sent);pm.instance_cookie=UINT64_C(0xfedcba9876543210);
  pm.self_inode=pm.peer_inode=UINT64_C(0x1000000000000123);
  pm.application_profile=1;pm.application_inode=UINT64_C(0x1000000000000456);
  pm.application_unsupported=fault==ORIGIN_UNSUPPORTED;pm.application_short=fault==ORIGIN_SHORT;
  pm.application_parent_changed=fault==ORIGIN_REPARENT;pm.application_foreign_peer=fault==ORIGIN_FOREIGN;
  pm.application_cookie_changed=fault==ORIGIN_COOKIE;pm.application_dead=fault==ORIGIN_ALREADY_DEAD;
  pm.old_pidfs=fault==ORIGIN_PIDFS;pm.boot_short=fault==ORIGIN_BOOT;
  memset(o,0,sizeof(*o));unsigned char body[112];memcpy(body,"TKOBIND5",8);memcpy(body+8,CLAIM,64);
  ocipp_put64(body+72,1);memset(body+80,0xa5,32);
  return ocipp_application_peer_bootstrap(o,body,sizeof(body));
}
static void origin_success(void) {
  struct ocipp_owner o;CHECK(origin_prepare(&o,ORIGIN_NONE)==0);
  CHECK(o.application_pidfd==93 && o.application_parent==6000 && pm.application_gets==1);
  CHECK(ocipp_application_peer_bootstrap_reply(&o)==0 && pm.delivered_size==160);
  CHECK(!memcmp(pm.delivered+4,"TKOINFO5",8) && ocipp_u64(pm.delivered+144)==42 &&
        ocipp_u64(pm.delivered+152)==pm.application_inode);
  CHECK(!pm.clones && !pm.waits && !pm.sent_size && ocipp_application_state(&o)==0);
  ocipp_host_lost(&o);authenticate_frontend(&o,0);
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-read-application-owner@1\"}")==0);
  CHECK(memmem(pm.frontend_sent,pm.frontend_sent_size,"application-owner-refused",25));
  CHECK(!pm.clones && !pm.waits && !pm.sent_size);
  pm.frontend_sent_size=0;pm.application_dead=pm.application_hup=1;
  CHECK(ocipp_application_state(&o)==1 && !o.joined && !o.eof[0] && !o.eof[1]);
  memcpy(pm.connector_reply,o.management_output,o.management_size);
  /* Replace the consumed alive-refusal with the ORIGINAL authentication ACK. */
  static const char ack[]="{\"kind\":\"linux-oci-parent-authenticated@1\",\"barrier\":\"unproven\"}";
  pm.connector_size=frame_bytes(pm.connector_reply,ack);auth_bytes(&o,pm.expected_auth);
  CHECK(frontend_command(&o,"{\"kind\":\"linux-oci-parent-read-application-owner@1\"}")==0);
  CHECK(memmem(pm.frontend_sent,pm.frontend_sent_size,"application-owner-exited",24));
  memcpy(pm.connector_reply+pm.connector_size,pm.frontend_sent,pm.frontend_sent_size);
  pm.connector_size+=pm.frontend_sent_size;
  unsigned char request[172],reply[512];size_t reply_size=0;peer_request(&o,request);
  pm.connector=1;struct ocipp_connector c;memset(&c,0,sizeof(c));c.parent_socket=c.peer_pidfd=c.custody.executable=-1;
  CHECK(ocipp_application_connector_read(&c,request,sizeof(request),reply,&reply_size)==0);
  CHECK(memmem(reply,reply_size,"application-owner-exited",24));
  CHECK(pm.peer_gets==1 && pm.cap_writes && pm.readonly_writes && !pm.sent_size && !pm.clones && !pm.waits);
  CHECK(ocipp_application_connector_read(&c,request,sizeof(request),reply,&reply_size)<0 && pm.peer_gets==1);
  CHECK(ocipp_connector_close(&c)==0);ocipp_connector_free(&c);dispose_fixture(&o);
}
static void origin_refusals(void) {
  for(int fault=ORIGIN_UNSUPPORTED;fault<=ORIGIN_BOOT;fault++) {
    struct ocipp_owner o;CHECK(origin_prepare(&o,fault)<0);
    CHECK(!pm.clones && !pm.waits && !pm.sent_size && !pm.cap_writes);
    unsigned int gets=pm.application_gets;
    unsigned char body[112];memcpy(body,"TKOBIND5",8);memcpy(body+8,CLAIM,64);
    ocipp_put64(body+72,1);memset(body+80,0xa5,32);
    CHECK(ocipp_application_peer_bootstrap(&o,body,sizeof(body))<0 && pm.application_gets==gets);
    dispose_fixture(&o);
  }
  for(unsigned int fault=0;fault<4;fault++) {
    struct ocipp_owner o;CHECK(origin_prepare(&o,ORIGIN_NONE)==0);
    if(fault==0)pm.application_stat_changed=1;
    if(fault==1)pm.application_poll_error=1;
    if(fault==2)pm.boot_other=1;
    if(fault==3){pm.close_fault=93;CHECK(ocipp_close(&o,&o.application_pidfd)<0 && o.application_pidfd<0);}
    CHECK(ocipp_application_state(&o)<0 && o.application_unknown);
    pm.application_stat_changed=pm.application_poll_error=pm.boot_other=0;pm.close_fault=-1;
    CHECK(ocipp_application_state(&o)<0 && pm.application_gets==1 && !pm.clones && !pm.waits);
    dispose_fixture(&o);
  }
  struct ocipp_owner o;CHECK(origin_prepare(&o,ORIGIN_NONE)==0);pm.application_dead=1;
  CHECK(ocipp_queue(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))<0 && !pm.clones && o.create_attempt);
  pm.application_dead=0;
  CHECK(ocipp_queue(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))<0 && !pm.clones);
  dispose_fixture(&o);
  prepare_peer_parent(&o);o.frontend=91;
  CHECK(ocipp_management(&o,(const unsigned char*)"{\"kind\":\"linux-oci-parent-read-application-owner@1\"}",strlen("{\"kind\":\"linux-oci-parent-read-application-owner@1\"}"))==0);
  CHECK(!o.application_attempt && !pm.application_gets && !pm.waits && !pm.clones);
  dispose_fixture(&o);
}
int __wrap_main(void);
int __wrap_main(void) {
  origin_success();origin_refusals();
  printf("PASS %lu original application-owner capture/read-only model checks; real effects0\n",checks);
  return 0;
}
