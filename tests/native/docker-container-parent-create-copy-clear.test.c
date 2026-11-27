/* CLOSED actual P producer model; all included old main/cases NEVER run.
 * NONSECRET values only. No real clone/exec/FD/socket/signal/helper/kernel.
 * Extract exact ocipp_flush_input from oci-parent.h to COPY_FLUSH_BODY.
 * The alias below adds only EINTR/EIO raw-write fault inputs; the canonical
 * path runs actual ocipp_step and its original flush body directly.
 * cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wpedantic
 * -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie
 * -DCOPY_FLUSH_BODY='"/x/flush.inc"'
 * tests/native/docker-container-parent-create-copy-clear.test.c
 * -Wl,--wrap=main -o /x/raw
 */
#include "docker-container-terminal-oci-parent.test.c"
static int copy_write_error;
static unsigned int copy_writes;
static ssize_t copy_write(int fd,const void *bytes,size_t size) {
 CHECK(fd==71);copy_writes++;
 if(copy_write_error){errno=copy_write_error;return -1;}
 return parent_write(fd,bytes,size);
}
#ifndef COPY_FLUSH_BODY
#error "Use the unchanged actual flush definition"
#endif
#define write copy_write
#define ocipp_flush_input measured_copy_flush
#include COPY_FLUSH_BODY
#undef ocipp_flush_input
#undef write

static unsigned char *copy_prepare(struct ocipp_owner *o) {
 prepare_bootstrap(o);copy_write_error=0;copy_writes=0;
 const char *environment=strstr(valid,"\"X=猫😀\"");CHECK(environment);
 static const char fixture[]="\"NONSECRET_COPIED=fixture\"";
 size_t prefix=(size_t)(environment-valid),suffix=strlen(environment+strlen("\"X=猫😀\""));
 size_t size=prefix+sizeof(fixture)-1+suffix;
 unsigned char *body=malloc(size);CHECK(body);
 memcpy(body,valid,prefix);memcpy(body+prefix,fixture,sizeof(fixture)-1);
 memcpy(body+prefix+sizeof(fixture)-1,environment+strlen("\"X=猫😀\""),suffix);
 CHECK(ocipp_first_create(o,body,(uint32_t)size)==0);free(body);
 unsigned char *original=malloc(o->create_size);CHECK(original);
 memcpy(original,o->create,o->create_size);return original;
}
static int copy_is_zero(const unsigned char *bytes,size_t size) {
 unsigned char value=0;for(size_t i=0;i<size;i++)value|=bytes[i];return !value;
}
static void canonical_delivery(void) {
 struct ocipp_owner o;unsigned char *original=copy_prepare(&o),*allocation=o.create;
 size_t size=o.create_size;CHECK(ocipp_spawn(&o)==0 && pm.clones==1);
 pm.chunk=29;pm.writes_again=1;
 while(o.pending){CHECK(ocipp_step(&o)<0);if(o.pending)CHECK(!memcmp(o.create,original,size));}
 CHECK(copy_is_zero(o.create,size));
 CHECK(o.create==allocation && o.create_size==size && o.create_attempt && o.attempted);
 CHECK(pm.sent_size==size && !memcmp(pm.sent,original,size));
 CHECK(copy_is_zero(o.incoming,size) && !o.incoming_size && !o.incoming_sent && o.awaiting);
 CHECK(o.request_kind==TNS_OCIP_CREATE && o.request_size==size && o.issued_size==size);
 CHECK(o.effects==(1u<<TNS_OCIP_CREATE) && !strcmp(o.claim,CLAIM) && o.generation==1);
 for(size_t i=0;i<sizeof(o.capability);i++)CHECK(o.capability[i]==0xa5);
 CHECK(!o.joined && !o.eof[0] && !o.eof[1] && ocipp_fact(&o)<0); /* not an H/I/O fact */
 CHECK(ocipp_first_create(&o,(const unsigned char*)valid,(uint32_t)strlen(valid))<0 && pm.clones==1);
 free(original);dispose_fixture(&o);
}
static void unsent_and_partial_keep_custody(void) {
 struct ocipp_owner o;unsigned char *original=copy_prepare(&o);size_t size=o.create_size;
 CHECK(ocipp_spawn(&o)==0);ocipp_host_lost(&o);
 CHECK(measured_copy_flush(&o)==0 && !copy_writes && !pm.sent_size && o.input_paused);
 CHECK(!memcmp(o.create,original,size) && !memcmp(o.incoming,original,size));
 free(original);dispose_fixture(&o);
 original=copy_prepare(&o);size=o.create_size;CHECK(ocipp_spawn(&o)==0);
 copy_write_error=EINTR;CHECK(measured_copy_flush(&o)==0 && !o.incoming_sent);
 copy_write_error=EAGAIN;CHECK(measured_copy_flush(&o)==0 && !o.incoming_sent);
 CHECK(!memcmp(o.create,original,size));
 copy_write_error=0;pm.chunk=13;CHECK(measured_copy_flush(&o)==0 && o.incoming_sent==13);
 size_t issued=o.issued_size;copy_write_error=EINTR;
 CHECK(measured_copy_flush(&o)==0 && o.issued_size==issued && !memcmp(o.create,original,size));
 copy_write_error=EIO;CHECK(measured_copy_flush(&o)<0 && o.reply_unknown && o.host_lost);
 CHECK(o.issued_size==issued && !memcmp(o.create,original,size) && o.pending);
 unsigned int writes=copy_writes;copy_write_error=0;
 CHECK(measured_copy_flush(&o)<0 && copy_writes==writes && pm.clones==1 && !pm.closes[71]);
 free(original);dispose_fixture(&o);
}
static void original_partial_continuation(void) {
 struct ocipp_owner o;unsigned char *original=copy_prepare(&o),*allocation=o.create;
 size_t size=o.create_size;CHECK(ocipp_spawn(&o)==0);pm.chunk=31;
 CHECK(ocipp_flush_input(&o)==0 && o.incoming_sent==31);ocipp_host_lost(&o);
 CHECK(!o.input_paused && !memcmp(o.create,original,size));
 while(o.pending)CHECK(ocipp_flush_input(&o)==0);
 CHECK(copy_is_zero(o.create,size) && o.create==allocation && o.create_size==size);
 CHECK(pm.sent_size==size && !memcmp(pm.sent,original,size) && o.delivery_unknown && pm.clones==1);
 CHECK(!pm.closes[71] && !o.joined);free(original);dispose_fixture(&o);
}
int __wrap_main(int argc,char **argv);
int __wrap_main(int argc,char **argv) {
 canonical_delivery();
 if(argc==1 || strcmp(argv[1],"canonical")){
  unsent_and_partial_keep_custody();original_partial_continuation();
 }
 printf("PASS %lu CREATE-copy lifecycle checks; actual effects0\n",checks);return 0;
}
