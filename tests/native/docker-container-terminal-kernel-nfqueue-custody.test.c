/* SPDX-License-Identifier: GPL-2.0-only */
/* Exact selected Linux queue/GSO/reinject and original ledger helper bodies
 * over closed raw allocation/ref/device/route/CT models. No kernel packet,
 * netns/socket/device/RCU/process/helper/network effect or old cohort executes.
 * Prepared net/owner memory is not a real namespace birth producer. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include "../../scripts/native/docker-container-terminal-kernel-state.h"
#include "../../scripts/native/docker-container-terminal-kernel-lifetime.h"
#ifndef TAKO_QUEUE_DRIVER_FILE
#error "Extract the exact driver/entry/queue/nfnetlink source units first"
#endif
typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef uint64_t u64;
typedef unsigned int refcount_t;
typedef unsigned int spinlock_t;
struct tako_terminal_owner;
struct nf_queue_entry;
struct list_head {struct list_head *next,*prev;};
struct sock { unsigned int sk_refcnt; };
struct net_device { unsigned int refs; };
struct nf_hook_entry { unsigned int unused; };
struct nf_hook_entries { unsigned int num_hook_entries;struct nf_hook_entry hooks[3]; };
struct net {
 struct tako_terminal_owner *tako_terminal;
 struct {struct nf_hook_entries *hooks_ipv4[5],*hooks_ipv6[5];} nf;
};
struct address6 { unsigned char bytes[16]; };
struct iphdr { unsigned char tos;u32 daddr,saddr; };
struct ipv6hdr { struct address6 daddr,saddr; };
struct sk_buff {
 struct sk_buff *next;struct sock *sk;void (*destructor)(struct sk_buff *);
 struct iphdr ip;struct ipv6hdr ip6;
 u32 mark;u16 protocol;bool gso;
};
struct nf_hook_state {
 u8 hook,pf;struct net_device *in,*out;struct sock *sk;struct net *net;
 int (*okfn)(struct net *,struct sock *,struct sk_buff *);
};
#define CONFIG_TAKO_TERMINAL 1
#define CONFIG_INET 1
#define IS_ENABLED(x) 0
#define NFPROTO_IPV4 2
#define NFPROTO_IPV6 10
#define AF_INET NFPROTO_IPV4
#define AF_INET6 NFPROTO_IPV6
#define NF_INET_LOCAL_OUT 3
#define NF_DROP 0U
#define NF_ACCEPT 1U
#define NF_STOLEN 2U
#define NF_QUEUE 3U
#define NF_REPEAT 4U
#define NF_STOP 5U
#define NF_VERDICT_MASK 255U
#define NF_VERDICT_QBITS 16
#define NF_VERDICT_FLAG_QUEUE_BYPASS 0x8000U
#define SKB_DROP_REASON_NETFILTER_DROP 1
#define GFP_ATOMIC 0U
#define RTN_UNSPEC 0
#define ETH_P_IP 0x800U
#define ETH_P_IPV6 0x86ddU
#define NFQNL_COPY_NONE 0U
#define NFQA_CFG_F_GSO 1U
#define unlikely(x) (x)
#define rcu_dereference(x) (x)
#define WARN_ON_ONCE(x) assert(!(x))
#define skb_list_walk_safe(head,pos,nextvar) \
 for((pos)=(head);(pos) && (((nextvar)=(pos)->next),1);(pos)=(nextvar))
#define nf_bridge_adjust_segmented_data(skb) ((void)(skb))
#define nf_bridge_adjust_skb_data(skb) ((void)(skb))
#define IS_ERR_OR_NULL(p) (!(p))
#define nf_queue_entry_reroute(entry) ((void *)((unsigned char *)(entry)+sizeof(struct nf_queue_entry)))
#define ip_hdr(skb) (&(skb)->ip)
#define ipv6_hdr(skb) (&(skb)->ip6)
static unsigned int spin_depth,rcu_depth;
static unsigned long checks;
#define CHECK(x) do {assert(x);checks++;} while(0)
static void raw_lock(spinlock_t *lock) { assert(!*lock);*lock=1;spin_depth++; }
static void raw_unlock(spinlock_t *lock) { assert(*lock && spin_depth);*lock=0;spin_depth--; }
#define spin_lock_irqsave(lock,flags) do {(flags)=0;raw_lock(lock);} while(0)
#define spin_unlock_irqrestore(lock,flags) do {(void)(flags);raw_unlock(lock);} while(0)
static void refcount_inc(unsigned int *n) { assert(*n && *n<UINT32_MAX);(*n)++; }
static bool refcount_dec_and_test(unsigned int *n) { assert(*n);return --*n==0; }
static bool refcount_inc_not_zero(unsigned int *n) {if(!*n)return false;(*n)++;return true;}
static void kfree(void *p);
static void might_sleep(void) {assert(!spin_depth && !rcu_depth);}
static bool rtnl_is_locked(void) {return false;}
static void synchronize_rcu(void) {assert(!spin_depth && !rcu_depth);}
static void synchronize_rcu_expedited(void) {abort();}
static void rcu_read_lock(void) {rcu_depth++;}
static void rcu_read_unlock(void) {assert(rcu_depth);rcu_depth--;}
void synchronize_net(void);
bool tako_terminal_block(const struct net *net,u8 pf);
struct tako_terminal_owner *tako_terminal_packet_reserve(struct net *net);
struct tako_terminal_owner *tako_terminal_packet_clone(struct tako_terminal_owner *held);
void tako_terminal_packet_put(struct tako_terminal_owner *held);
#include TAKO_QUEUE_DRIVER_FILE
#include TAKO_QUEUE_ENTRY_FILE
struct ip_rt_info {unsigned char tos;u32 daddr,saddr,mark;};
struct ip6_rt_info {struct address6 daddr,saddr;u32 mark;};
struct nf_queue_handler {int (*outfn)(struct nf_queue_entry *,unsigned int);};
struct nf_ct_hook {unsigned int (*update)(struct net *,struct sk_buff *);};
struct nf_ipv6_ops {int (*reroute)(struct sk_buff *,struct nf_queue_entry *);};
struct nfqnl_instance {unsigned int copy_mode,flags;};
struct nfnl_queue_net {unsigned int unused;};
static struct {
 struct tako_terminal_owner *owner;struct net net;struct nf_hook_entries hooks;
 struct nf_queue_entry *queued[32];unsigned int queued_n,handoffs,handoff_fail_at;
 void *alloc[128];bool freed[128];unsigned int alloc_n,alloc_calls,alloc_fail_at,storage_frees,owner_frees;
 struct sk_buff *packets[128];bool packet_freed[128];unsigned int packets_n,packet_frees;
 struct nf_queue_handler handler;struct nfqnl_instance instance;struct nfnl_queue_net qnet;
 struct nf_ct_hook ct;struct nf_ipv6_ops v6;
 unsigned int ct_verdict,ct_calls,hook_calls,ok_calls,segments;
 bool ct_consumes,has_dst,dst_fail,segment_fail,queue_missing;
} m;
static const struct nf_queue_handler *nf_queue_handler;
static const struct nf_ct_hook *nf_ct_hook;
static const struct nf_ipv6_ops *nf_ipv6_ops;
static void *raw_alloc(size_t size) {
 m.alloc_calls++;if(m.alloc_fail_at==m.alloc_calls)return NULL;
 void *p=malloc(size);CHECK(p && m.alloc_n<128);m.alloc[m.alloc_n]=p;m.freed[m.alloc_n++]=false;return p;
}
static void *kmalloc(size_t size,unsigned int flags) {assert(flags==GFP_ATOMIC);return raw_alloc(size);}
static void *kmemdup(const void *p,size_t size,unsigned int flags) {
 void *copy=kmalloc(size,flags);if(copy)memcpy(copy,p,size);return copy;
}
static void kfree(void *p) {
 if(p==m.owner){CHECK(!m.owner->refs);m.owner_frees++;free(p);m.owner=NULL;return;}
 for(unsigned int i=0;i<m.alloc_n;i++)if(m.alloc[i]==p && !m.freed[i]){
  m.freed[i]=true;m.storage_frees++;free(p);return;
 }
 assert(!"unknown/double entry free");
}
static struct sk_buff *packet(void) {
 struct sk_buff *skb=calloc(1,sizeof(*skb));CHECK(skb && m.packets_n<128);
 m.packets[m.packets_n]=skb;m.packet_freed[m.packets_n++]=false;return skb;
}
static void kfree_skb(struct sk_buff *skb) {
 for(unsigned int i=0;i<m.packets_n;i++)if(m.packets[i]==skb && !m.packet_freed[i]){m.packet_freed[i]=true;m.packet_frees++;free(skb);return;}
 assert(!"unknown/double raw packet free");
}
static void kfree_skb_reason(struct sk_buff *skb,int reason) {assert(reason==SKB_DROP_REASON_NETFILTER_DROP);kfree_skb(skb);}
static void dev_hold(struct net_device *dev) {if(dev)dev->refs++;}
static void dev_put(struct net_device *dev) {if(dev){assert(dev->refs);dev->refs--;}}
static void sock_gen_put(struct sock *sk) {assert(sk->sk_refcnt);sk->sk_refcnt--;}
static bool skb_sk_is_prefetched(const struct sk_buff *skb) {(void)skb;return false;}
static bool sk_is_refcounted(const struct sock *sk) {(void)sk;return true;}
static void sock_edemux(struct sk_buff *skb) {(void)skb;abort();}
static void *skb_dst(const struct sk_buff *skb) {(void)skb;return m.has_dst?&m:NULL;}
static bool skb_dst_force(struct sk_buff *skb) {(void)skb;return !m.dst_fail;}
static int ip_route_me_harder(struct net *net,struct sock *sk,struct sk_buff *skb,int why) {(void)net;(void)sk;(void)skb;assert(why==RTN_UNSPEC);return 0;}
static void local_bh_disable(void) {assert(rcu_depth);}
static void local_bh_enable(void) {assert(rcu_depth);}
static unsigned int nf_hook_entry_hookfn(const struct nf_hook_entry *hook,struct sk_buff *skb,struct nf_hook_state *state) {
 (void)hook;(void)skb;(void)state;m.hook_calls++;CHECK(!state->net->tako_terminal || m.owner->packet_groups.sockets>0);return NF_ACCEPT;
}
static struct nfnl_queue_net *nfnl_queue_pernet(struct net *net) {assert(net==&m.net);return &m.qnet;}
static struct nfqnl_instance *instance_lookup(struct nfnl_queue_net *net,unsigned int queue) {assert(net==&m.qnet && queue==0);return m.queue_missing?NULL:&m.instance;}
static bool skb_is_gso(const struct sk_buff *skb) {return skb->gso;}
static bool skb_is_gso_sctp(const struct sk_buff *skb) {(void)skb;return false;}
static u16 htons(unsigned int value) {return (u16)value;}
static void skb_mark_not_on_list(struct sk_buff *skb) {skb->next=NULL;}
static struct sk_buff *skb_gso_segment(struct sk_buff *skb,unsigned int features) {
 (void)skb;assert(!features);if(m.segment_fail)return NULL;
 struct sk_buff *first=NULL,**tail=&first;
 for(unsigned int i=0;i<m.segments;i++){*tail=packet();tail=&(*tail)->next;}return first;
}
static int capture(struct nf_queue_entry *entry,unsigned int queue) {
 assert(!queue);m.handoffs++;
 CHECK(!m.net.tako_terminal || (entry->tako_terminal==m.owner && m.owner->packet_groups.sockets>0));
 if(m.handoff_fail_at==m.handoffs)return -ENOBUFS;
 CHECK(m.queued_n<32);m.queued[m.queued_n++]=entry;return 0;
}
static int __nfqnl_enqueue_packet(struct net *net,struct nfqnl_instance *queue,struct nf_queue_entry *entry) {assert(net==&m.net && queue==&m.instance);return capture(entry,0);}
bool nf_queue_entry_get_refs(struct nf_queue_entry *entry);
void nf_queue_entry_free(struct nf_queue_entry *entry);
int nf_queue(struct sk_buff *skb,struct nf_hook_state *state,unsigned int index,unsigned int verdict);
#include TAKO_QUEUE_BODY_FILE
#include TAKO_QUEUE_NFNETLINK_FILE

static int okfn(struct net *net,struct sock *sk,struct sk_buff *skb) {
 (void)sk;assert(net==&m.net);m.ok_calls++;
 CHECK(!m.net.tako_terminal || m.owner->packet_groups.sockets>0);kfree_skb(skb);return 0;
}
static unsigned int ct_update(struct net *net,struct sk_buff *skb) {
 assert(net==&m.net);m.ct_calls++;
 CHECK(!m.net.tako_terminal || m.owner->packet_groups.sockets>0);
 if(m.ct_consumes){kfree_skb(skb);}
 return m.ct_verdict;
}
static int v6reroute(struct sk_buff *skb,struct nf_queue_entry *entry) {(void)skb;(void)entry;return 0;}
static void prepare(bool owned) {
 memset(&m,0,sizeof(m));m.owner=calloc(1,sizeof(*m.owner));CHECK(m.owner);m.owner->refs=1;
 tako_terminal_state_init(&m.owner->state);tako_terminal_state_init(&m.owner->packet_groups);tako_terminal_admission_init(&m.owner->admission);
 CHECK(tako_terminal_admission_open(&m.owner->admission,&m.owner->state));m.net.tako_terminal=owned?m.owner:NULL;
 m.hooks.num_hook_entries=2;for(unsigned int i=0;i<5;i++)m.net.nf.hooks_ipv4[i]=m.net.nf.hooks_ipv6[i]=&m.hooks;
 m.handler.outfn=capture;nf_queue_handler=&m.handler;m.ct.update=ct_update;nf_ct_hook=&m.ct;m.ct_verdict=NF_ACCEPT;
 m.v6.reroute=v6reroute;nf_ipv6_ops=&m.v6;m.instance.copy_mode=1;
}
static struct nf_hook_state state(u8 family) {struct nf_hook_state s={.pf=family,.net=&m.net,.okfn=okfn};return s;}
static void balanced(void) {
 CHECK(m.owner && m.owner->refs==1 && !m.owner->packet_groups.sockets);
 CHECK(m.owner->packet_groups.allocations==m.owner->packet_groups.releases);
 for(unsigned int i=0;i<m.alloc_n;i++)CHECK(m.freed[i]);
 for(unsigned int i=0;i<m.packets_n;i++)CHECK(m.packet_freed[i]);
 tako_owner_put(m.owner);CHECK(m.owner_frees==1);
}
static void reinject(struct nf_queue_entry *entry,unsigned int verdict) {rcu_read_lock();nfqnl_reinject(entry,verdict);rcu_read_unlock();}
static void first_case(void) {
 prepare(true);struct nf_hook_state s=state(AF_INET);CHECK(__nf_queue(packet(),&s,0,0)==0);
 CHECK(m.queued_n==1 && m.owner->refs==2 && m.owner->packet_groups.sockets==1);
 reinject(m.queued[0],NF_ACCEPT);CHECK(m.ct_calls==1 && m.ok_calls==1);balanced();
}
static void verdict_cases(void) {
 const unsigned int verdicts[]={NF_ACCEPT,NF_REPEAT,NF_STOP,NF_DROP,NF_STOLEN};
 for(unsigned int i=0;i<5;i++)for(unsigned int fam=0;fam<2;fam++){
  prepare(true);struct nf_hook_state s=state(fam?AF_INET6:AF_INET);struct sk_buff *skb=packet();CHECK(__nf_queue(skb,&s,0,0)==0);
  reinject(m.queued[0],verdicts[i]);if(verdicts[i]==NF_STOLEN)kfree_skb(skb);balanced();
 }
 prepare(true);m.ct_verdict=NF_STOLEN;m.ct_consumes=true;struct nf_hook_state s=state(AF_INET);CHECK(__nf_queue(packet(),&s,0,0)==0);reinject(m.queued[0],NF_ACCEPT);CHECK(m.ct_calls==1 && !m.ok_calls);balanced();
 prepare(true);s=state(AF_INET6);CHECK(__nf_queue(packet(),&s,0,0)==0);tako_cut_admission(m.owner);reinject(m.queued[0],NF_ACCEPT);CHECK(!m.ct_calls && !m.ok_calls);balanced();
 prepare(true);s=state(AF_INET);CHECK(__nf_queue(packet(),&s,0,0)==0);reinject(m.queued[0],NF_QUEUE);CHECK(m.queued_n==2 && m.owner->packet_groups.sockets==1 && m.owner->packet_groups.allocations==2 && m.owner->packet_groups.releases==1);reinject(m.queued[1],NF_ACCEPT);balanced();
}
static void failure_and_dup_cases(void) {
 for(unsigned int stage=0;stage<4;stage++){
  prepare(true);struct nf_hook_state s=state(AF_INET);struct sock zero={0};struct sk_buff *skb=packet();
  if(stage==0){m.alloc_fail_at=1;}
  if(stage==1){m.has_dst=m.dst_fail=true;}
  if(stage==2){s.sk=&zero;}
  if(stage==3){m.handoff_fail_at=1;}
  CHECK(__nf_queue(skb,&s,0,0)<0);kfree_skb(skb);balanced();
 }
 prepare(true);struct nf_hook_state s=state(AF_INET);CHECK(__nf_queue(packet(),&s,0,0)==0);struct nf_queue_entry *original=m.queued[0];
 m.alloc_fail_at=m.alloc_calls+1;CHECK(!nf_queue_entry_dup(original) && m.owner->packet_groups.sockets==1);m.alloc_fail_at=0;
 /* Negative get_refs refusal boundary: the borrowed shallow pointer must
  * not become owned or be put. This prepared zero sock is not a claim that
  * a valid original held sock can normally reach refcount zero. */
 struct sock zero={0};original->state.sk=&zero;CHECK(!nf_queue_entry_dup(original) && m.owner->packet_groups.sockets==1);original->state.sk=NULL;
 struct nf_queue_entry *copy=nf_queue_entry_dup(original);CHECK(copy && copy!=original && copy->tako_terminal==original->tako_terminal && m.owner->packet_groups.sockets==2);
 nf_queue_entry_free(copy);CHECK(m.owner->packet_groups.sockets==1);reinject(original,NF_DROP);balanced();
}
static void gso_cases(void) {
 for(unsigned int fail=0;fail<=3;fail++){
  prepare(true);m.handler.outfn=nfqnl_enqueue_packet;m.segments=3;m.handoff_fail_at=fail;
  struct nf_hook_state s=state(AF_INET6);struct sk_buff *skb=packet();skb->gso=true;int result=__nf_queue(skb,&s,0,0);
  if(fail==1){CHECK(result<0 && !m.queued_n);kfree_skb(skb);}else CHECK(result==0 && m.queued_n==(fail?fail-1:3));
  CHECK(m.owner->packet_groups.sockets==m.queued_n);
  for(unsigned int i=0;i<m.queued_n;i++){reinject(m.queued[i],NF_DROP);}
  balanced();
 }
 prepare(true);m.handler.outfn=nfqnl_enqueue_packet;m.segment_fail=true;struct nf_hook_state s=state(AF_INET);struct sk_buff *skb=packet();skb->gso=true;CHECK(__nf_queue(skb,&s,0,0)<0);kfree_skb(skb);balanced();
}
static void ordinary(void) {
 prepare(false);struct nf_hook_state s=state(AF_INET);CHECK(__nf_queue(packet(),&s,0,0)==0 && !m.owner->packet_groups.allocations);reinject(m.queued[0],NF_ACCEPT);balanced();
 prepare(true);s=state(AF_INET);nf_queue_handler=NULL;struct sk_buff *skb=packet();CHECK(nf_queue(skb,&s,0,NF_QUEUE|NF_VERDICT_FLAG_QUEUE_BYPASS)==1 && !m.alloc_n);kfree_skb(skb);balanced();
}
int main(int argc,char **argv) {
 if(argc==2 && !strcmp(argv[1],"--first-hold"))first_case();
 else if(argc==2 && !strcmp(argv[1],"--all")){first_case();verdict_cases();failure_and_dup_cases();gso_cases();ordinary();}
 else return 2;
 printf("original NFQUEUE entry custody raw model: %lu checks\n",checks);return 0;
}
