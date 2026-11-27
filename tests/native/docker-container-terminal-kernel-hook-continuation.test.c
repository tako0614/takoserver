/* SPDX-License-Identifier: GPL-2.0-only */
/* Pure synchronous-wrapper custody model. Reuses the previous immutable raw
 * lock/RCU fixture scaffolding, never its old119 case bodies or main. Compile
 * unchanged extracted actual owner/refcount/packet-ledger helpers, CUT/block,
 * synchronize_net and NF entry bodies using the packet includes. Successful
 * raw prepared structs are not a real kernel namespace birth producer.
 * Actual callback malloc/free and held-owner final free exercise the source
 * boundary even when skb is gone before callback return. No kernel RCU,
 * namespace/socket/device/packet/helper/native process or signal is executed. */
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdatomic.h>
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
 bool heap;
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
 int kind,result,slow_result;
 u8 family;
 struct net *net;
 struct tako_terminal_owner *owner;
 struct sk_buff skb,second;
 struct list_head head;
} m;
static _Atomic unsigned long checks;
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
static unsigned int ledger_frees,packet_frees,callback_calls;
static bool callback_active;
static int callback_mode,callback_result;
static struct tako_terminal_owner *allocated_owner;
static void refcount_inc(unsigned int *value) { assert(*value && *value<UINT32_MAX);(*value)++; }
static bool refcount_dec_and_test(unsigned int *value) { assert(*value);return --*value==0; }
static void kfree(void *memory);
struct tako_terminal_owner *tako_terminal_packet_reserve(struct net *net);
void tako_terminal_packet_put(struct tako_terminal_owner *held);
void synchronize_net(void);
bool tako_terminal_block(const struct net *net,u8 family);
#include TAKO_CUT_DRIVER_FILE
static void kfree(void *memory) {
 assert(memory==allocated_owner && !callback_active);
 CHECK(!allocated_owner->refs);
 CHECK(!pthread_mutex_destroy(&allocated_owner->lock));
 ledger_frees++;free(memory);allocated_owner=NULL;
}

static void kfree_skb_reason(struct sk_buff *skb,int reason) {
 assert(reason==SKB_DROP_REASON_NETFILTER_DROP);skb->drops++;
 if(skb->heap){packet_frees++;free(skb);}
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
 assert(rcu_depth==1);m.slow++;return m.slow_result;
}
static void nf_hook_slow_list(struct list_head *head,struct nf_hook_state *state,
 const struct nf_hook_entries *entries) {
 (void)head;(void)state;(void)entries;assert(rcu_depth==1);m.list_slow++;
}
#define CONFIG_TAKO_TERMINAL 1
#include TAKO_CUT_NF_FILE
#undef CONFIG_TAKO_TERMINAL
#define tako_terminal_block raw_configoff_block
#define tako_terminal_packet_reserve raw_configoff_reserve
#define tako_terminal_packet_put raw_configoff_put
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
#undef tako_terminal_packet_put
#undef tako_terminal_packet_reserve
#undef __builtin_constant_p

static int okfn(struct net *net,struct sock *sk,struct sk_buff *skb) {
 (void)net;(void)sk;(void)skb;
 assert(!rcu_depth);
 if(thread_slot==1){lock_model();if(m.ok_pause){m.ok_reached=true;notify_changed();while(!m.permit)wait_changed();}unlock_model();}
 m.ok_calls++;return 7;
}
static void prepare(struct net *net) {
 memset(&m,0,sizeof(m));memset(net,0,sizeof(*net));
 ledger_frees=packet_frees=callback_calls=0;callback_active=false;callback_mode=0;callback_result=7;
 allocated_owner=calloc(1,sizeof(*allocated_owner));CHECK(allocated_owner);
 CHECK(!pthread_mutex_init(&allocated_owner->lock,NULL));allocated_owner->refs=1;
 tako_terminal_state_init(&allocated_owner->state);tako_terminal_state_init(&allocated_owner->packet_groups);
 tako_terminal_admission_init(&allocated_owner->admission);
 CHECK(tako_terminal_admission_open(&allocated_owner->admission,&allocated_owner->state)==1);
 m.owner=allocated_owner;m.net=net;net->tako_terminal=allocated_owner;m.slow_result=1;
 static struct nf_hook_entries entries;
 for(unsigned int i=0;i<5;i++){net->nf.hooks_ipv4[i]=&entries;net->nf.hooks_ipv6[i]=&entries;}
 memset(nf_hooks_needed,1,sizeof(nf_hooks_needed));
}
static struct sk_buff *new_packet(void) {
 struct sk_buff *skb=calloc(1,sizeof(*skb));CHECK(skb);skb->heap=true;return skb;
}
static void dispose(void) {
 CHECK(allocated_owner && allocated_owner->refs==1 && !callback_active);
 tako_owner_put(allocated_owner);CHECK(ledger_frees==1);
}
static int continuation(struct net *net,struct sock *sk,struct sk_buff *skb) {
 (void)sk;struct tako_terminal_owner *owner=net->tako_terminal;
 callback_active=true;callback_calls++;
 CHECK(!rcu_depth && owner==allocated_owner && owner->refs==2);
 CHECK(owner->packet_groups.sockets==1 && !owner->packet_groups.poisoned);
 kfree_skb_reason(skb,SKB_DROP_REASON_NETFILTER_DROP);
 CHECK(packet_frees==1 && !ledger_frees);
 if(callback_mode==1){
  /* Original net's raw allocation reference goes away while the real
   * synchronous wrapper still owns its independent held ledger. */
  tako_cut_admission(owner);net->tako_terminal=NULL;tako_owner_put(owner);
  CHECK(owner->refs==1 && owner->packet_groups.sockets==1 && !ledger_frees);
 }else if(callback_mode==2){
  lock_model();m.ok_reached=true;notify_changed();while(!m.permit)wait_changed();unlock_model();
  CHECK(owner->refs==2 && owner->packet_groups.sockets==1 && !ledger_frees);
 }
 callback_active=false;return callback_result;
}
static int invoke(int kind,u8 family,struct net *net,struct sk_buff *skb) {
 if(kind==0)return NF_HOOK_COND(family,0,net,NULL,skb,NULL,NULL,continuation,false);
 if(kind==1)return NF_HOOK_COND(family,0,net,NULL,skb,NULL,NULL,continuation,true);
 return NF_HOOK(family,0,net,NULL,skb,NULL,NULL,continuation);
}
static void final_free_case(int kind,u8 family,int result) {
 struct net net;prepare(&net);callback_mode=1;callback_result=result;
 CHECK(invoke(kind,family,&net,new_packet())==result);
 CHECK(callback_calls==1 && packet_frees==1 && ledger_frees==1 && !allocated_owner);
 CHECK(!net.tako_terminal && m.normal==1 && !rcu_depth && !spin_depth);
}
static void *interval_reader(void *unused) {
 (void)unused;thread_slot=1;
 m.result=invoke(m.kind,m.family,m.net,new_packet());return NULL;
}
static void *interval_cutter(void *unused) {
 (void)unused;thread_slot=2;tako_cut_admission(m.owner);
 lock_model();m.cut_done=true;notify_changed();unlock_model();return NULL;
}
static void cut_interval_case(int kind) {
 struct net net;prepare(&net);callback_mode=2;m.kind=kind;m.family=NFPROTO_IPV6;
 pthread_t reading,cutting;CHECK(!pthread_create(&reading,NULL,interval_reader,NULL));
 lock_model();while(!m.ok_reached)wait_changed();unlock_model();
 CHECK(!pthread_create(&cutting,NULL,interval_cutter,NULL));
 lock_model();while(!m.cut_done)wait_changed();
 /* CUT may return outside the old RCU section, but this original callback
  * is still represented by a concrete ledger reservation after skb free. */
 CHECK(m.grace_entered && !m.grace_targets[1] && packet_frees==1);
 CHECK(allocated_owner->refs==2 && allocated_owner->packet_groups.sockets==1 && !ledger_frees);
 m.permit=true;notify_changed();unlock_model();
 CHECK(!pthread_join(reading,NULL));CHECK(!pthread_join(cutting,NULL));
 CHECK(m.result==7 && callback_calls==1 && allocated_owner->refs==1);
 CHECK(allocated_owner->packet_groups.sockets==0 && allocated_owner->packet_groups.allocations==1 && allocated_owner->packet_groups.releases==1);
 CHECK(!tako_terminal_admission_open(&allocated_owner->admission,&allocated_owner->state));dispose();
}
static void return_cases(void) {
 for(int kind=0;kind<3;kind++){
  struct net net;prepare(&net);tako_terminal_admission_cut(&allocated_owner->admission);
  CHECK(invoke(kind,NFPROTO_IPV4,&net,new_packet())==-EPERM);
  CHECK(!callback_calls && packet_frees==1 && allocated_owner->refs==1);
  CHECK(!allocated_owner->packet_groups.sockets && allocated_owner->packet_groups.allocations==1 && allocated_owner->packet_groups.releases==1);dispose();
 }
 for(int kind=1;kind<3;kind++){
  struct net net;prepare(&net);m.slow_result=0;struct sk_buff *skb=new_packet();
  CHECK(invoke(kind,NFPROTO_IPV4,&net,skb)==0 && !callback_calls && !packet_frees);
  CHECK(allocated_owner->refs==1 && !allocated_owner->packet_groups.sockets);
  /* Model-recipient disposal, outside the synchronous call interval. This
   * zero must not stand in for retaining the queued/stolen continuation. */
  free(skb);dispose();
 }
 struct net net;prepare(&net);allocated_owner->packet_groups.sockets=TAKO_TERMINAL_U64_MAX;
 allocated_owner->packet_groups.allocations=TAKO_TERMINAL_U64_MAX;
 CHECK(invoke(0,NFPROTO_IPV6,&net,new_packet())==-EPERM && !callback_calls && packet_frees==1);
 CHECK(allocated_owner->packet_groups.poisoned && allocated_owner->packet_groups.sockets==TAKO_TERMINAL_U64_MAX && allocated_owner->refs==1);dispose();
}
static void defaults(void) {
 struct net net;prepare(&net);struct sk_buff skb={0};
 /* The real CONFIG-off helpers are NULL/no-op, preserving old behavior. */
 CHECK(raw_off_cond(NFPROTO_IPV4,0,&net,NULL,&skb,NULL,NULL,okfn,false)==7);
 CHECK(raw_off_normal(NFPROTO_IPV6,0,&net,NULL,&skb,NULL,NULL,okfn)==7);
 CHECK(allocated_owner->refs==1 && !allocated_owner->packet_groups.allocations);
 nf_hooks_needed[NFPROTO_IPV4][0]=0;
 CHECK(raw_off_hook(NFPROTO_IPV4,0,&net,NULL,&skb,NULL,NULL,okfn)==1);
 struct list_head head={0};raw_off_list(NFPROTO_IPV4,0,&net,NULL,&head,NULL,NULL,okfn);
 /* Unowned enabled calls reserve no target and keep their original return. */
 net.tako_terminal=NULL;CHECK(NF_HOOK_COND(NFPROTO_IPV4,0,&net,NULL,&skb,NULL,NULL,okfn,false)==7);
 CHECK(NF_HOOK(NFPROTO_IPV6,0,&net,NULL,&skb,NULL,NULL,okfn)==7);
 CHECK(allocated_owner->refs==1 && !allocated_owner->packet_groups.allocations);
 CHECK(!tako_terminal_packet_reserve(&net));tako_terminal_packet_put(NULL);dispose();
}
int main(int argc,char **argv) {
 if(argc==2 && !strcmp(argv[1],"--first-hold"))final_free_case(0,NFPROTO_IPV4,7);
 else if(argc==2 && !strcmp(argv[1],"--all")){
  for(int kind=0;kind<3;kind++){final_free_case(kind,NFPROTO_IPV4,7);final_free_case(kind,NFPROTO_IPV6,-EIO);cut_interval_case(kind);}
  return_cases();defaults();
 }else return 2;
 printf("original synchronous-hook ledger raw model: %lu checks\n",checks);return 0;
}
