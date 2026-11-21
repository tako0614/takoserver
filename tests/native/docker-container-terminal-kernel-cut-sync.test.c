/* SPDX-License-Identifier: GPL-2.0-only */
/* Pure RCU-boundary model, not kernel RCU or packet execution. Compile exact
 * extracted owner/block/CUT/synchronize_net and netfilter entry bodies using
 * TAKO_CUT_DRIVER_FILE / TAKO_CUT_NF_FILE / TAKO_CUT_OFF_FILE. The packet
 * generator verifies byte identity and strict in-memory patch context. A
 * before-NF + after-CUT build demonstrates why adding a grace period alone
 * misses the gate-to-reader gap. Existing state/accounting is read-only.
 *
 * POSIX threads/condition variables model preexisting-reader membership with
 * finite waits. No namespace, device, socket, packet, signal, process creation,
 * native helper, actual RCU or kernel operation is performed. Prepared owner
 * objects are raw test memory, never a successful kernel birth producer. */
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <time.h>
#include "../../scripts/native/docker-container-terminal-kernel-state.h"
#include "../../scripts/native/docker-container-terminal-kernel-lifetime.h"
#ifndef TAKO_CUT_DRIVER_FILE
#error "Extract exact source bodies into the bounded packet first"
#endif
#ifndef TAKO_CUT_NF_FILE
#error "Select the exact before or after netfilter body include"
#endif
#ifndef TAKO_CUT_OFF_FILE
#error "Extract the unchanged CONFIG_TAKO_TERMINAL-off block function"
#endif

typedef uint8_t u8;
typedef uint8_t u_int8_t;
typedef uint64_t u64;
typedef unsigned int refcount_t;
typedef pthread_mutex_t spinlock_t;
struct tako_terminal_owner;
struct sock { unsigned int unused; };
struct net_device { unsigned int unused; };
struct nf_hook_entries { unsigned int unused; };
struct nf_hook_state { unsigned int unused; };
struct net {
 struct tako_terminal_owner *tako_terminal;
 struct {
  struct nf_hook_entries *hooks_ipv4[5],*hooks_ipv6[5];
 } nf;
};
struct sk_buff;
struct list_head { struct sk_buff *first; };
struct sk_buff {
 struct { struct sk_buff *next; } list;
 struct list_head *head;
 unsigned int drops;
};
#define NFPROTO_IPV4 2
#define NFPROTO_ARP 3
#define NFPROTO_BRIDGE 7
#define NFPROTO_IPV6 10
#define SKB_DROP_REASON_NETFILTER_DROP 1
#define unlikely(x) (x)
#define rcu_dereference(x) (x)
#define WARN_ON_ONCE(x) assert(!(x))
#define list_for_each_entry_safe(skb,next,head,member) \
 for((skb)=(head)->first;(skb) && (((next)=(skb)->member.next),1);(skb)=(next))
/* Closed raw static-key predicate model, including the otherwise optimized
 * constant-input branch. It changes no extracted production source bytes. */
#define __builtin_constant_p(x) 1
#define CONFIG_JUMP_LABEL 1
static int nf_hooks_needed[12][5];
static bool static_key_false(const int *key) { return *key != 0; }
static _Thread_local unsigned int thread_slot,rcu_depth,spin_depth;
static pthread_mutex_t model_lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed=PTHREAD_COND_INITIALIZER;
static struct {
 bool active[3],gate_pause,gate_reached,permit,ok_pause,ok_reached;
 bool grace_entered,grace_targets[3],cut_done,rtnl;
 unsigned long epoch,entered[3];
 unsigned int normal,expedited,slow,list_slow,ok_calls,rcu_locks;
 int kind,result;
 u8 family;
 struct net *net;
 struct tako_terminal_owner *owner;
 struct sk_buff skb,second;
 struct list_head head;
} m;
static unsigned long checks;
#define CHECK(x) do { assert(x);checks++; } while(0)
static void lock_model(void) { assert(!pthread_mutex_lock(&model_lock)); }
static void unlock_model(void) { assert(!pthread_mutex_unlock(&model_lock)); }
static void wait_changed(void) {
 struct timespec until;
 assert(!clock_gettime(CLOCK_REALTIME,&until));until.tv_sec+=5;
 assert(!pthread_cond_timedwait(&changed,&model_lock,&until));
}
static void notify_changed(void) { assert(!pthread_cond_broadcast(&changed)); }
static void raw_spin_lock(spinlock_t *lock) {
 assert(!pthread_mutex_lock(lock));spin_depth++;
}
static void raw_spin_unlock(spinlock_t *lock) {
 assert(spin_depth);spin_depth--;assert(!pthread_mutex_unlock(lock));
 if(thread_slot==1){
  lock_model();
  if(m.gate_pause && !m.gate_reached){
   m.gate_reached=true;notify_changed();while(!m.permit)wait_changed();
  }
  unlock_model();
 }
}
#define spin_lock_irqsave(lock,flags) do {(flags)=0;raw_spin_lock(lock);} while(0)
#define spin_unlock_irqrestore(lock,flags) do {(void)(flags);raw_spin_unlock(lock);} while(0)
static void rcu_read_lock(void) {
 lock_model();if(!rcu_depth++){m.active[thread_slot]=true;m.entered[thread_slot]=++m.epoch;}
 m.rcu_locks++;unlock_model();
}
static void rcu_read_unlock(void) {
 lock_model();assert(rcu_depth);if(!--rcu_depth)m.active[thread_slot]=false;
 notify_changed();unlock_model();
}
static void raw_grace(bool expedited) {
 assert(!spin_depth && !rcu_depth);
 lock_model();m.grace_entered=true;unsigned long before=m.epoch;
 for(unsigned int i=0;i<3;i++)m.grace_targets[i]=m.active[i] && m.entered[i]<=before;
 if(expedited)m.expedited++;else m.normal++;
 notify_changed();
 for(;;){bool pending=false;
  for(unsigned int i=0;i<3;i++)if(m.grace_targets[i] && m.active[i] && m.entered[i]<=before)pending=true;
  if(!pending)break;
  wait_changed();
 }
 unlock_model();
}
static void synchronize_rcu(void) { raw_grace(false); }
static void synchronize_rcu_expedited(void) { raw_grace(true); }
static bool rtnl_is_locked(void) { return m.rtnl; }
static void might_sleep(void) { assert(!spin_depth && !rcu_depth); }
void synchronize_net(void);
bool tako_terminal_block(const struct net *net,u8 family);
#include TAKO_CUT_DRIVER_FILE

static void kfree_skb_reason(struct sk_buff *skb,int reason) {
 assert(reason==SKB_DROP_REASON_NETFILTER_DROP);skb->drops++;
}
static void skb_list_del_init(struct sk_buff *skb) {
 struct sk_buff **at=&skb->head->first;
 while(*at!=skb){assert(*at);at=&(*at)->list.next;}
 *at=skb->list.next;skb->list.next=NULL;
}
static void nf_hook_state_init(struct nf_hook_state *state,unsigned int hook,u8 pf,
 struct net_device *in,struct net_device *out,struct sock *sk,struct net *net,
 int (*okfn)(struct net *,struct sock *,struct sk_buff *)) {
 (void)state;(void)hook;(void)pf;(void)in;(void)out;(void)sk;(void)net;(void)okfn;
}
static int nf_hook_slow(struct sk_buff *skb,struct nf_hook_state *state,
 const struct nf_hook_entries *entries,unsigned int start) {
 (void)skb;(void)state;(void)entries;(void)start;
 assert(rcu_depth==1);m.slow++;return 1;
}
static void nf_hook_slow_list(struct list_head *head,struct nf_hook_state *state,
 const struct nf_hook_entries *entries) {
 (void)head;(void)state;(void)entries;assert(rcu_depth==1);m.list_slow++;
}
#define CONFIG_TAKO_TERMINAL 1
#include TAKO_CUT_NF_FILE
#undef CONFIG_TAKO_TERMINAL
#define tako_terminal_block raw_configoff_block
#include TAKO_CUT_OFF_FILE
#define nf_hook raw_off_hook
#define NF_HOOK_COND raw_off_cond
#define NF_HOOK raw_off_normal
#define NF_HOOK_LIST raw_off_list
#include TAKO_CUT_NF_FILE
#undef NF_HOOK_LIST
#undef NF_HOOK
#undef NF_HOOK_COND
#undef nf_hook
#undef tako_terminal_block
#undef __builtin_constant_p

static int okfn(struct net *net,struct sock *sk,struct sk_buff *skb) {
 (void)net;(void)sk;(void)skb;
 assert(!rcu_depth);
 if(thread_slot==1){lock_model();if(m.ok_pause){m.ok_reached=true;notify_changed();while(!m.permit)wait_changed();}unlock_model();}
 m.ok_calls++;return 7;
}
static void prepare(struct tako_terminal_owner *owner,struct net *net) {
 memset(&m,0,sizeof(m));memset(owner,0,sizeof(*owner));memset(net,0,sizeof(*net));
 CHECK(!pthread_mutex_init(&owner->lock,NULL));
 tako_terminal_state_init(&owner->state);tako_terminal_admission_init(&owner->admission);
 CHECK(tako_terminal_admission_open(&owner->admission,&owner->state)==1);
 net->tako_terminal=owner;m.owner=owner;m.net=net;
 static struct nf_hook_entries entries;
 for(unsigned int i=0;i<5;i++){net->nf.hooks_ipv4[i]=&entries;net->nf.hooks_ipv6[i]=&entries;}
 memset(nf_hooks_needed,1,sizeof(nf_hooks_needed));
 m.skb.head=m.second.head=&m.head;m.skb.list.next=&m.second;m.head.first=&m.skb;
}
static void dispose(struct tako_terminal_owner *owner) {
 CHECK(!rcu_depth && !spin_depth);CHECK(!pthread_mutex_destroy(&owner->lock));
}
static void *reader(void *unused) {
 (void)unused;thread_slot=1;
 if(m.kind==1) {NF_HOOK_LIST(m.family,0,m.net,NULL,&m.head,NULL,NULL,okfn);m.result=1;}
 else if(m.kind==3)m.result=NF_HOOK_COND(m.family,0,m.net,NULL,&m.skb,NULL,NULL,okfn,false);
 else if(m.kind==4)m.result=NF_HOOK(m.family,0,m.net,NULL,&m.skb,NULL,NULL,okfn);
 else m.result=nf_hook(m.family,0,m.net,NULL,&m.skb,NULL,NULL,okfn);
 assert(!rcu_depth && !spin_depth);return NULL;
}
static void *cutter(void *unused) {
 (void)unused;thread_slot=2;tako_cut_admission(m.owner);
 lock_model();m.cut_done=true;notify_changed();unlock_model();return NULL;
}
static void admission_reader_case(int kind,u8 family) {
 struct tako_terminal_owner owner;struct net net;prepare(&owner,&net);
 m.kind=kind;m.family=family;m.gate_pause=true;
 if(kind==2)nf_hooks_needed[family][0]=0;
 pthread_t receiving,cutting;CHECK(!pthread_create(&receiving,NULL,reader,NULL));
 lock_model();while(!m.gate_reached)wait_changed();unlock_model();
 CHECK(!pthread_create(&cutting,NULL,cutter,NULL));
 lock_model();while(!m.grace_entered)wait_changed();
 /* Actual gate unlock is paused. A grace period can wait it only if the
  * actual entry body began its reader before that admission decision. */
 CHECK(m.grace_targets[1] && m.active[1] && !m.cut_done);
 m.permit=true;notify_changed();unlock_model();
 CHECK(!pthread_join(receiving,NULL));CHECK(!pthread_join(cutting,NULL));
 CHECK(m.cut_done && m.normal==1 && !m.expedited && m.result==1 && !m.skb.drops);
 CHECK(kind==1?m.list_slow==1:kind==2?m.slow==0:m.slow==1);
 CHECK(tako_terminal_admission_blocked(&owner.admission,&owner.state));
 CHECK(!tako_terminal_admission_open(&owner.admission,&owner.state));dispose(&owner);
}
static void outside_case(int kind) {
 struct tako_terminal_owner owner;struct net net;prepare(&owner,&net);
 m.kind=kind;m.family=NFPROTO_IPV4;m.gate_pause=kind==3;m.ok_pause=kind==4;
 pthread_t receiving,cutting;CHECK(!pthread_create(&receiving,NULL,reader,NULL));
 lock_model();while(!(kind==3?m.gate_reached:m.ok_reached))wait_changed();unlock_model();
 CHECK(!pthread_create(&cutting,NULL,cutter,NULL));
 lock_model();while(!m.cut_done)wait_changed();
 CHECK(m.grace_entered && !m.grace_targets[1] && !m.active[1]);
 m.permit=true;notify_changed();unlock_model();
 CHECK(!pthread_join(receiving,NULL));CHECK(!pthread_join(cutting,NULL));
 CHECK(m.result==7 && m.ok_calls==1 && m.normal==1);
 /* This genuine modeled continuation after CUT demonstrates why this patch
  * is deliberately not an all-packet barrier or terminal predicate. */
 dispose(&owner);
}
static void ordinary_cases(void) {
 struct tako_terminal_owner owner;struct net net;prepare(&owner,&net);
 unsigned int before=m.rcu_locks;
 CHECK(nf_hook(NFPROTO_IPV4,0,&net,NULL,&m.skb,NULL,NULL,okfn)==1 && m.slow==1 && !rcu_depth);
 tako_cut_admission(&owner);CHECK(m.normal==1);
 CHECK(nf_hook(NFPROTO_IPV4,0,&net,NULL,&m.skb,NULL,NULL,okfn)==-EPERM && m.skb.drops==1 && !rcu_depth);
 NF_HOOK_LIST(NFPROTO_IPV6,0,&net,NULL,&m.head,NULL,NULL,okfn);
 CHECK(!m.head.first && m.skb.drops==2 && m.second.drops==1 && !rcu_depth);
 CHECK(NF_HOOK_COND(NFPROTO_IPV4,0,&net,NULL,&m.skb,NULL,NULL,okfn,false)==-EPERM && !rcu_depth);
 CHECK(m.rcu_locks>before);
 /* CONFIG-off still calls the unchanged false gate, with old fast path. */
 before=m.rcu_locks;nf_hooks_needed[NFPROTO_IPV4][0]=0;
 CHECK(raw_off_hook(NFPROTO_IPV4,0,&net,NULL,&m.skb,NULL,NULL,okfn)==1 && m.rcu_locks==before);
 raw_off_list(NFPROTO_IPV4,0,&net,NULL,&m.head,NULL,NULL,okfn);CHECK(m.rcu_locks==before);
 CHECK(raw_off_cond(NFPROTO_IPV4,0,&net,NULL,&m.skb,NULL,NULL,okfn,false)==7);
 CHECK(raw_off_normal(NFPROTO_IPV4,0,&net,NULL,&m.skb,NULL,NULL,okfn)==7);
 nf_hooks_needed[NFPROTO_IPV4][0]=1;CHECK(raw_off_hook(NFPROTO_IPV4,0,&net,NULL,&m.skb,NULL,NULL,okfn)==1 && !rcu_depth);
 /* An unowned net has unchanged verdict/continuation semantics. */
 net.tako_terminal=NULL;
 CHECK(nf_hook(NFPROTO_IPV4,0,&net,NULL,&m.skb,NULL,NULL,okfn)==1);
 CHECK(NF_HOOK_COND(NFPROTO_IPV4,0,&net,NULL,&m.skb,NULL,NULL,okfn,false)==7);
 nf_hooks_needed[NFPROTO_IPV6][0]=0;NF_HOOK_LIST(NFPROTO_IPV6,0,&net,NULL,&m.head,NULL,NULL,okfn);CHECK(!rcu_depth);
 CHECK(!tako_terminal_block(&net,NFPROTO_IPV6));net.tako_terminal=&owner;
 CHECK(!tako_terminal_block(&net,NFPROTO_ARP));
 m.rtnl=true;tako_cut_admission(&owner);CHECK(m.normal==1 && m.expedited==1 && !rcu_depth);
 dispose(&owner);
}
int main(int argc,char **argv) {
 if(argc==2 && !strcmp(argv[1],"--first-gap"))admission_reader_case(0,NFPROTO_IPV4);
 else if(argc==2 && !strcmp(argv[1],"--all")){
  for(int kind=0;kind<3;kind++){admission_reader_case(kind,NFPROTO_IPV4);admission_reader_case(kind,NFPROTO_IPV6);}
  outside_case(3);outside_case(4);ordinary_cases();
 }else return 2;
 printf("original CUT RCU-boundary raw model: %lu checks\n",checks);return 0;
}
