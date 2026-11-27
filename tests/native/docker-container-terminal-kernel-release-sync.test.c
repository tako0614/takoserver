/* SPDX-License-Identifier: GPL-2.0-only */
/* New direct namespace-release regression. Actual original release, admission
 * gate and synchronize_net bodies are extracted from formal17 plus this unit.
 * Prepared owner/file and stack net fields model the internal helper boundary;
 * they are not a real kernel CREATE/ioctl/namespace/net_free. Pthread epochs
 * model only the existing matched RCU interval, not actual Linux RCU. No old
 * NF/queue/cohort case, main/helper/kernel/device/socket operation is executed. */
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <pthread.h>
#include <time.h>
#include "../../scripts/native/docker-container-terminal-kernel-state.h"
#include "../../scripts/native/docker-container-terminal-kernel-lifetime.h"
#ifndef RELEASE_BODY
#error "Use the pinned new packet's exact source bodies"
#endif
#define TAKO_TERMINAL_DEVICE_ORIGINS 1
typedef uint8_t u8;
typedef uint64_t u64;
typedef unsigned int refcount_t;
typedef pthread_mutex_t spinlock_t;
struct mutex { pthread_mutex_t raw; };
struct pid;
struct tako_terminal_owner;
struct net { struct tako_terminal_owner *tako_terminal;unsigned int refs; };
#include RELEASE_STRUCTURES
#define NFPROTO_IPV4 2
#define NFPROTO_IPV6 10
static _Thread_local unsigned int spin_depth,rcu_depth,slot;
static pthread_mutex_t model_lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed=PTHREAD_COND_INITIALIZER;
static struct {
 bool active[3],targets[3],reader_reached,allow_reader,young_reached,allow_young;
 bool grace_entered,release_done,rtnl,pause_before_gate;
 unsigned long epoch,entered[3];
 unsigned int normal,expedited,puts;
 int reader_blocked,young_blocked,release_result;
 struct tako_terminal_owner owner;
 struct tako_terminal_file ctx;
 struct net net;
} m;
static unsigned long checks;
#define CHECK(x) do { assert(x);checks++; } while (0)
static void lock_model(void) { assert(!pthread_mutex_lock(&model_lock)); }
static void unlock_model(void) { assert(!pthread_mutex_unlock(&model_lock)); }
static void notify(void) { assert(!pthread_cond_broadcast(&changed)); }
static void wait_change(void) {
 struct timespec until;assert(!clock_gettime(CLOCK_REALTIME,&until));until.tv_sec+=5;
 assert(!pthread_cond_timedwait(&changed,&model_lock,&until));
}
static void raw_spin_lock(spinlock_t *lock) { assert(!pthread_mutex_lock(lock));spin_depth++; }
static void raw_spin_unlock(spinlock_t *lock) { assert(spin_depth);spin_depth--;assert(!pthread_mutex_unlock(lock)); }
#define spin_lock_irqsave(lock,flags) do {(flags)=0;raw_spin_lock(lock);} while (0)
#define spin_unlock_irqrestore(lock,flags) do {(void)(flags);raw_spin_unlock(lock);} while (0)
bool tako_terminal_block(const struct net *net,u8 pf);
#include RELEASE_GATE
static void raw_read_lock(void) {
 lock_model();assert(!rcu_depth);rcu_depth=1;m.active[slot]=true;m.entered[slot]=++m.epoch;
 notify();unlock_model();
}
static void raw_read_unlock(void) {
 lock_model();assert(rcu_depth==1);rcu_depth=0;m.active[slot]=false;notify();unlock_model();
}
static void raw_grace(bool expedited) {
 assert(!spin_depth && !rcu_depth);
 lock_model();assert(!m.grace_entered);m.grace_entered=true;
 for(unsigned int i=0;i<3;i++)m.targets[i]=m.active[i];
 if(expedited)m.expedited++;else m.normal++;
 notify();
 for(;;){bool pending=false;
  for(unsigned int i=0;i<3;i++)if(m.targets[i] && m.active[i])pending=true;
  if(!pending)break;
  wait_change();
 }
 unlock_model();
}
static void synchronize_rcu(void) { raw_grace(false); }
static void synchronize_rcu_expedited(void) { raw_grace(true); }
static bool rtnl_is_locked(void) { return m.rtnl; }
static void might_sleep(void) { assert(!spin_depth && !rcu_depth); }
void synchronize_net(void);
#include RELEASE_SYNCHRONIZE
static void put_net(struct net *net) {
 lock_model();
 assert(net==&m.net && m.ctx.net==NULL && !spin_depth && !rcu_depth);
 /* The original reference must not be put while the older matched reader
  * is still inside its interval. This assertion is the old-body RED. */
 assert(!m.active[1]);
 assert(net->refs==2);net->refs--;m.puts++;notify();unlock_model();
}
#include RELEASE_BODY
static void *reader(void *unused) {
 (void)unused;slot=1;raw_read_lock();
 if(!m.pause_before_gate)m.reader_blocked=tako_terminal_block(&m.net,NFPROTO_IPV4);
 lock_model();m.reader_reached=true;notify();while(!m.allow_reader)wait_change();unlock_model();
 if(m.pause_before_gate)m.reader_blocked=tako_terminal_block(&m.net,NFPROTO_IPV4);
 raw_read_unlock();return NULL;
}
static void *young_reader(void *unused) {
 (void)unused;slot=2;raw_read_lock();m.young_blocked=tako_terminal_block(&m.net,NFPROTO_IPV6);
 lock_model();m.young_reached=true;notify();while(!m.allow_young)wait_change();unlock_model();
 raw_read_unlock();return NULL;
}
static void *release_original(void *unused) {
 (void)unused;slot=0;
 assert(!pthread_mutex_lock(&m.ctx.lock.raw));
 int ret=tako_release_namespace(&m.ctx);
 assert(!pthread_mutex_unlock(&m.ctx.lock.raw));
 lock_model();m.release_result=ret;m.release_done=true;notify();unlock_model();return NULL;
}
static void prepare(bool expedited,bool before_gate) {
 memset(&m,0,sizeof(m));m.rtnl=expedited;m.pause_before_gate=before_gate;
 assert(!pthread_mutex_init(&m.owner.lock,NULL));assert(!pthread_mutex_init(&m.ctx.lock.raw,NULL));
 m.owner.refs=2;tako_terminal_state_init(&m.owner.state);
 tako_terminal_state_init(&m.owner.requests);tako_terminal_state_init(&m.owner.timewait);
 tako_terminal_state_init(&m.owner.packet_groups);tako_terminal_state_init(&m.owner.device_associations);
 tako_terminal_admission_init(&m.owner.admission);tako_terminal_lifetime_born(&m.owner.lifetime);
 CHECK(tako_terminal_admission_open(&m.owner.admission,&m.owner.state));
 m.net=(struct net){.tako_terminal=&m.owner,.refs=2};m.ctx.owner=&m.owner;m.ctx.net=&m.net;
}
static void finish(void) {
 CHECK(!m.owner.lifetime.net_gone); /* External reference keeps stack net live. */
 CHECK(!spin_depth && !rcu_depth);
 assert(!pthread_mutex_destroy(&m.owner.lock));assert(!pthread_mutex_destroy(&m.ctx.lock.raw));
}
static void interval_case(bool expedited,bool before_gate) {
 pthread_t old,release,young;prepare(expedited,before_gate);
 assert(!pthread_create(&old,NULL,reader,NULL));lock_model();while(!m.reader_reached)wait_change();unlock_model();
 assert(!pthread_create(&release,NULL,release_original,NULL));lock_model();while(!m.grace_entered)wait_change();
 CHECK(!m.puts && !m.release_done && m.ctx.net==&m.net && m.net.refs==2);
 CHECK(m.active[1] && m.targets[1]);unlock_model();
 unsigned long flags;spin_lock_irqsave(&m.owner.lock,flags);
 CHECK(m.owner.admission.cut && !m.owner.admission.opened);
 CHECK(m.owner.state.sealed && m.owner.device_associations.sealed);
 CHECK(m.owner.lifetime.release_attempted && !m.owner.lifetime.reference_released);
 spin_unlock_irqrestore(&m.owner.lock,flags);
 assert(!pthread_create(&young,NULL,young_reader,NULL));lock_model();while(!m.young_reached)wait_change();
 CHECK(m.young_blocked && m.active[2] && !m.targets[2]);
 m.allow_reader=true;notify();while(!m.release_done)wait_change();
 CHECK(m.puts==1 && m.net.refs==1 && m.ctx.net==NULL && m.release_result==0);
 CHECK(m.active[2]); /* This was not an all-reader/all-packet barrier. */
 m.allow_young=true;notify();unlock_model();
 assert(!pthread_join(old,NULL));assert(!pthread_join(young,NULL));assert(!pthread_join(release,NULL));
 CHECK(m.reader_blocked==(int)before_gate);
 CHECK(m.normal==!expedited && m.expedited==expedited);
 CHECK(m.owner.lifetime.reference_released && !m.owner.lifetime.poisoned);
 CHECK(tako_release_namespace(&m.ctx)==-EALREADY && m.puts==1);
 CHECK(m.normal+m.expedited==1);finish();
}
static void refusal_cases(void) {
 prepare(false,false);m.ctx.net=NULL;CHECK(tako_release_namespace(&m.ctx)==-EALREADY);
 CHECK(!m.puts && !m.normal && !m.expedited && !m.owner.admission.cut);finish();
 prepare(false,false);m.owner.lifetime.release_attempted=1;
 CHECK(tako_release_namespace(&m.ctx)==-EALREADY);
 CHECK(m.ctx.net==&m.net && m.net.refs==2 && !m.puts && !m.normal && !m.expedited);
 CHECK(m.owner.admission.cut && !m.owner.lifetime.reference_released);finish();
 prepare(false,false);m.owner.lifetime.born=0;
 CHECK(tako_release_namespace(&m.ctx)==-EALREADY);
 CHECK(m.owner.lifetime.poisoned && m.ctx.net==&m.net && !m.puts && !m.normal && !m.expedited);finish();
}
int main(int argc,char **argv) {
 bool selected=argc==2 && !strcmp(argv[1],"interval-only");
 interval_case(false,false);
 if(!selected){interval_case(true,false);interval_case(false,true);interval_case(true,true);refusal_cases();}
 printf("PASS %lu checks; actual direct-release body and raw matched-reader boundary only\n",checks);
 return 0;
}
