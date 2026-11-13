/* SPDX-License-Identifier: GPL-2.0-only */
/* Actual NF entry, owner-ledger, extension COW/copy/free bodies are extracted
 * from the immutable aggregate16 plus this unit's new patch. This dedicated
 * raw model supplies heap/refcount/lock/hook boundaries, not a kernel or live
 * namespace. Stack net objects remain alive throughout each reservation.
 * Extension ids/cache size are a bounded raw allocation model, not kernel ABI.
 * No native main, socket, device, namespace, syscall, or old test is run. */
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../scripts/native/docker-container-terminal-kernel-state.h"
#include "../../scripts/native/docker-container-terminal-kernel-lifetime.h"
#ifndef ORIGIN_INCLUDE
#error "Use the pinned packet's exact actual-source body includes"
#endif
#define CONFIG_TAKO_TERMINAL 1
#define TAKO_TERMINAL_DEVICE_ORIGINS 1
#define __aligned(n) __attribute__((aligned(n)))
#define unlikely(x) (x)
#define GFP_ATOMIC 0
#define NFPROTO_IPV4 2
#define NFPROTO_ARP 3
#define NFPROTO_BRIDGE 7
#define NFPROTO_IPV6 10
#define SKB_DROP_REASON_NETFILTER_DROP 1
#define rcu_dereference(x) (x)
#define WARN_ON_ONCE(x) assert(!(x))
typedef uint8_t u8;
typedef uint8_t u_int8_t;
typedef uint64_t u64;
typedef unsigned int refcount_t;
typedef unsigned int spinlock_t;
typedef unsigned int gfp_t;
static unsigned long checks;
#define CHECK(x) do { assert(x); checks++; } while (0)
struct tako_terminal_owner;
struct sock { unsigned int unused; };
struct net_device { unsigned int unused; };
struct nf_hook_entries { unsigned int unused; };
struct net {
 struct tako_terminal_owner *tako_terminal;
 struct { struct nf_hook_entries *hooks_ipv4[5], *hooks_ipv6[5]; } nf;
};
struct nf_hook_state { struct net *net; };
struct sk_buff;
struct list_head { struct sk_buff *first; };
enum skb_ext_id { SKB_EXT_TAKO_TERMINAL, SKB_EXT_MODEL_OTHER, SKB_EXT_NUM };
#include ORIGIN_EXT_STRUCT
struct sk_buff {
 refcount_t users;
 unsigned int active_extensions, slow_gro;
 struct skb_ext *extensions;
 struct { struct sk_buff *next; } list;
 struct list_head *head;
};
static unsigned int spin_depth, rcu_depth, packet_frees, blob_frees;
static unsigned int allocation_calls, fail_at, hook_calls, ok_calls, list_calls;
static int hook_result;
static bool callback_frees;
static struct tako_terminal_owner *owners[8];
static unsigned int owner_count;
static void refcount_inc(refcount_t *r) { assert(*r && *r < UINT32_MAX); ++*r; }
static void refcount_set(refcount_t *r, unsigned int value) { *r=value; }
static unsigned int refcount_read(const refcount_t *r) { return *r; }
static bool refcount_dec_and_test(refcount_t *r) { assert(*r); return --*r==0; }
#define spin_lock_irqsave(lock,flags) do { (flags)=0;assert(!*(lock));*(lock)=1;spin_depth++; } while (0)
#define spin_unlock_irqrestore(lock,flags) do { (void)(flags);assert(*(lock));*(lock)=0;assert(spin_depth);spin_depth--; } while (0)
static void kfree(void *ptr);
struct tako_terminal_owner *tako_terminal_packet_reserve(struct net *net);
struct tako_terminal_owner *tako_terminal_packet_clone(struct tako_terminal_owner *held);
void tako_terminal_packet_put(struct tako_terminal_owner *held);
void tako_terminal_packet_poison(struct tako_terminal_owner *held);
bool tako_terminal_block(const struct net *net,u8 pf);
#include ORIGIN_DRIVER
static void kfree(void *ptr) {
 unsigned int i;
 assert(!spin_depth);
 for(i=0;i<owner_count;i++) if(owners[i]==ptr) break;
 assert(i<owner_count && !owners[i]->refs);
 free(ptr); owners[i]=NULL;
}
#include "../../scripts/native/docker-container-terminal-kernel-skb-state.h"
#define SKB_EXT_ALIGN_VALUE 8U
#define SKB_EXT_CHUNKSIZEOF(x) ((sizeof(x)+7U)/8U)
static const unsigned int skb_ext_type_len[SKB_EXT_NUM] = {
 [SKB_EXT_TAKO_TERMINAL]=SKB_EXT_CHUNKSIZEOF(struct tako_terminal_skb_refs),
 [SKB_EXT_MODEL_OTHER]=1
};
static unsigned int skbuff_ext_cache;
static void *kmem_cache_alloc(const void *cache,gfp_t flags) {
 (void)cache;(void)flags;allocation_calls++;
 if(fail_at && allocation_calls==fail_at) return NULL;
 void *ptr=calloc(1,512);CHECK(ptr);return ptr;
}
static void kmem_cache_free(const void *cache,void *ptr) {
 (void)cache;assert(ptr);blob_frees++;free(ptr);
}
#define skb_ext_get_ptr(ext,id) ((void *)((char *)(ext)+((ext)->offset[(id)]*8U)))
/* Kernel cache argument is an opaque pointer in this raw malloc boundary. */
#define skbuff_ext_cache (&skbuff_ext_cache)
struct skb_ext *__skb_ext_alloc(gfp_t flags);
void __skb_ext_put(struct skb_ext *ext);
void *skb_ext_add(struct sk_buff *skb,enum skb_ext_id id);
void tako_terminal_skb_poison(const struct sk_buff *skb);
void tako_terminal_skb_copy(struct sk_buff *dst,const struct sk_buff *src);
void tako_terminal_skb_set_owner(struct sk_buff *skb,struct net *net);
#include ORIGIN_EXT_HEADER
#include ORIGIN_SKB_SHARED
#include ORIGIN_EXT_ALLOC
#include ORIGIN_EXT_PUT
#include ORIGIN_EXT_COW
#include ORIGIN_EXT_ADD
#include ORIGIN_SKB_ORIGIN
#include ORIGIN_SET_OWNER
static void rcu_read_lock(void) { assert(!spin_depth);rcu_depth++; }
static void rcu_read_unlock(void) { assert(rcu_depth);rcu_depth--; }
#define list_for_each_entry(skb,head,member) \
 for((skb)=(head)->first;(skb);(skb)=(skb)->member.next)
#define list_for_each_entry_safe(skb,next,head,member) \
 for((skb)=(head)->first;(skb) && (((next)=(skb)->member.next),1);(skb)=(next))
#define __builtin_constant_p(x) 1
#define CONFIG_JUMP_LABEL 1
static int nf_hooks_needed[12][5];
static bool static_key_false(const int *key) { return *key!=0; }
static void release_packet(struct sk_buff *skb) {
 assert(skb->users);
 if(!--skb->users) { skb_ext_put_final(skb);packet_frees++;free(skb); }
}
static void kfree_skb_reason(struct sk_buff *skb,int reason) {
 CHECK(reason==SKB_DROP_REASON_NETFILTER_DROP);release_packet(skb);
}
static void skb_list_del_init(struct sk_buff *skb) {
 struct sk_buff **at=&skb->head->first;
 while(*at!=skb){assert(*at);at=&(*at)->list.next;}
 *at=skb->list.next;skb->list.next=NULL;
}
static void nf_hook_state_init(struct nf_hook_state *state,unsigned int hook,u8 pf,
 struct net_device *in,struct net_device *out,struct sock *sk,struct net *net,
 int (*okfn)(struct net *,struct sock *,struct sk_buff *)) {
 (void)hook;(void)pf;(void)in;(void)out;(void)sk;(void)okfn;state->net=net;
}
static void assert_original_origin(const struct sk_buff *skb,const struct net *net) {
 if(net->tako_terminal && !skb_shared(skb)) {
  const struct tako_terminal_skb_refs *refs=skb_ext_find(skb,SKB_EXT_TAKO_TERMINAL);
  bool found=false;
  CHECK(refs);
  for(unsigned int i=0;i<TAKO_TERMINAL_SKB_OWNERS;i++) if(refs->owners[i]==net->tako_terminal)found=true;
  CHECK(found);
 }
}
static int nf_hook_slow(struct sk_buff *skb,struct nf_hook_state *state,
 const struct nf_hook_entries *entries,unsigned int start) {
 (void)entries;(void)start;assert(rcu_depth==1);hook_calls++;
 assert_original_origin(skb,state->net);
 if(callback_frees)release_packet(skb);
 return hook_result;
}
static void nf_hook_slow_list(struct list_head *head,struct nf_hook_state *state,
 const struct nf_hook_entries *entries) {
 (void)entries;assert(rcu_depth==1);list_calls++;
 struct sk_buff *skb;
 list_for_each_entry(skb,head,list) assert_original_origin(skb,state->net);
}
#include ORIGIN_NF
#undef CONFIG_TAKO_TERMINAL
#define tako_terminal_block raw_off_block
#define tako_terminal_packet_reserve raw_off_reserve
#define tako_terminal_packet_put raw_off_put
#include ORIGIN_OFF_DRIVER
#define nf_hook raw_off_nf_hook
#define NF_HOOK_COND raw_off_cond
#define NF_HOOK raw_off_normal
#define NF_HOOK_LIST raw_off_list
#include ORIGIN_NF
#undef NF_HOOK_LIST
#undef NF_HOOK
#undef NF_HOOK_COND
#undef nf_hook
#undef tako_terminal_packet_put
#undef tako_terminal_packet_reserve
#undef tako_terminal_block
#undef __builtin_constant_p
#define CONFIG_TAKO_TERMINAL 1
static int original_okfn(struct net *net,struct sock *sk,struct sk_buff *skb) {
 (void)sk;assert(!rcu_depth);ok_calls++;assert_original_origin(skb,net);
 if(callback_frees)release_packet(skb);
 return 7;
}
static struct sk_buff *new_packet(void) {
 struct sk_buff *skb=calloc(1,sizeof(*skb));CHECK(skb);skb->users=1;return skb;
}
static struct net new_net(void) {
 assert(owner_count<8);
 struct tako_terminal_owner *o=calloc(1,sizeof(*o));CHECK(o);
 owners[owner_count++]=o;o->refs=1;
 tako_terminal_state_init(&o->state);tako_terminal_state_init(&o->requests);
 tako_terminal_state_init(&o->timewait);tako_terminal_state_init(&o->packet_groups);
 tako_terminal_state_init(&o->device_associations);tako_terminal_admission_init(&o->admission);
 tako_terminal_lifetime_born(&o->lifetime);CHECK(tako_terminal_admission_open(&o->admission,&o->state));
 return (struct net){.tako_terminal=o};
}
static void finish(void) {
 CHECK(!rcu_depth && !spin_depth);
 for(unsigned int i=0;i<owner_count;i++){CHECK(owners[i]->refs==1);tako_owner_put(owners[i]);}
 owner_count=0;fail_at=0;callback_frees=false;
 memset(nf_hooks_needed,0,sizeof(nf_hooks_needed));
}
static void handoff_cases(bool selected_only) {
 struct net net=new_net();struct sk_buff *skb=new_packet();
 net.nf.hooks_ipv4[0]=(struct nf_hook_entries *)(uintptr_t)1;
 nf_hooks_needed[NFPROTO_IPV4][0]=1;hook_result=0;
 CHECK(NF_HOOK(NFPROTO_IPV4,0,&net,NULL,skb,NULL,NULL,original_okfn)==0);
 CHECK(net.tako_terminal->packet_groups.sockets==1);CHECK(skb->active_extensions);
 /* Call token is gone; original skb origin still retains its owner. */
 CHECK(net.tako_terminal->refs==2);release_packet(skb);finish();
 if(selected_only)return;
 for(unsigned int family=0;family<2;family++)for(unsigned int kind=0;kind<4;kind++){
  net=new_net();skb=new_packet();u8 pf=family?NFPROTO_IPV6:NFPROTO_IPV4;
  unsigned int before=ok_calls;
  if(kind==0)CHECK(NF_HOOK_COND(pf,0,&net,NULL,skb,NULL,NULL,original_okfn,false)==7);
  else if(kind==1)CHECK(NF_HOOK_COND(pf,0,&net,NULL,skb,NULL,NULL,original_okfn,true)==7);
  else if(kind==2)CHECK(NF_HOOK(pf,0,&net,NULL,skb,NULL,NULL,original_okfn)==7);
  else CHECK(nf_hook(pf,0,&net,NULL,skb,NULL,NULL,original_okfn)==1);
  CHECK(net.tako_terminal->packet_groups.sockets==1);
  CHECK(ok_calls==before+(kind!=3));release_packet(skb);finish();
 }
 for(unsigned int slow=0;slow<2;slow++){
  net=new_net();struct sk_buff *one=new_packet(),*two=new_packet();
  struct list_head list={.first=one};one->head=two->head=&list;one->list.next=two;
  if(slow){nf_hooks_needed[NFPROTO_IPV6][0]=1;net.nf.hooks_ipv6[0]=(struct nf_hook_entries *)(uintptr_t)1;}
  NF_HOOK_LIST(NFPROTO_IPV6,0,&net,NULL,&list,NULL,NULL,original_okfn);
  CHECK(net.tako_terminal->packet_groups.sockets==2);
  release_packet(one);release_packet(two);finish();
 }
 net=new_net();skb=new_packet();callback_frees=true;
 CHECK(NF_HOOK(NFPROTO_IPV4,0,&net,NULL,skb,NULL,NULL,original_okfn)==7);
 CHECK(net.tako_terminal->refs==1);finish();
 net=new_net();skb=new_packet();tako_terminal_admission_cut(&net.tako_terminal->admission);
 CHECK(NF_HOOK_COND(NFPROTO_IPV4,0,&net,NULL,skb,NULL,NULL,original_okfn,false)==-EPERM);
 CHECK(net.tako_terminal->packet_groups.sockets==0);finish();
 net=new_net();skb=new_packet();fail_at=allocation_calls+1;
 CHECK(NF_HOOK(NFPROTO_IPV4,0,&net,NULL,skb,NULL,NULL,original_okfn)==-EPERM);
 CHECK(net.tako_terminal->packet_groups.poisoned);finish();
}
static void extension_cases(void) {
 struct net nets[5];for(unsigned int i=0;i<5;i++)nets[i]=new_net();
 struct sk_buff *skb=new_packet();
 for(unsigned int i=0;i<4;i++)tako_terminal_skb_set_owner(skb,&nets[i]);
 struct skb_ext *same=skb->extensions;
 tako_terminal_skb_set_owner(skb,&nets[0]);CHECK(skb->extensions==same);
 for(unsigned int i=0;i<4;i++)CHECK(nets[i].tako_terminal->packet_groups.sockets==1);
 tako_terminal_skb_set_owner(skb,&nets[4]);CHECK(nets[4].tako_terminal->packet_groups.poisoned);
 for(unsigned int i=0;i<4;i++)CHECK(!nets[i].tako_terminal->packet_groups.poisoned);
 release_packet(skb);finish();
 for(unsigned int fail=0;fail<2;fail++){
  struct net a=new_net(),b=new_net();struct sk_buff *one=new_packet(),*two=new_packet();
  tako_terminal_skb_set_owner(one,&a);__skb_ext_copy(two,one);
  CHECK(one->extensions==two->extensions && one->extensions->refcnt==2);
  if(fail)fail_at=allocation_calls+1;
  tako_terminal_skb_set_owner(two,&b);
  if(fail){CHECK(one->extensions==two->extensions);CHECK(b.tako_terminal->packet_groups.poisoned);CHECK(a.tako_terminal->packet_groups.sockets==1);}
  else {CHECK(one->extensions!=two->extensions);CHECK(a.tako_terminal->packet_groups.sockets==2);CHECK(b.tako_terminal->packet_groups.sockets==1);}
  release_packet(one);CHECK(a.tako_terminal->packet_groups.sockets==1);
  release_packet(two);CHECK(a.tako_terminal->packet_groups.sockets==0);finish();
 }
 struct net a=new_net(),b=new_net();struct sk_buff *one=new_packet(),*two=new_packet();
 tako_terminal_skb_set_owner(one,&a);tako_terminal_skb_set_owner(two,&b);
 skb_ext_copy(two,one);CHECK(a.tako_terminal->packet_groups.sockets==2);
 CHECK(b.tako_terminal->packet_groups.sockets==1);release_packet(one);release_packet(two);finish();
 a=new_net();b=new_net();skb=new_packet();tako_terminal_skb_set_owner(skb,&a);same=skb->extensions;
 skb->users=2;unsigned int alloc=allocation_calls;
 tako_terminal_skb_set_owner(skb,&b);CHECK(skb->extensions==same && allocation_calls==alloc);
 CHECK(b.tako_terminal->packet_groups.poisoned && !a.tako_terminal->packet_groups.poisoned);
 release_packet(skb);CHECK(a.tako_terminal->packet_groups.sockets==1);release_packet(skb);finish();
 a=new_net();skb=new_packet();a.tako_terminal->packet_groups.sockets=TAKO_TERMINAL_U64_MAX;
 tako_terminal_skb_set_owner(skb,&a);CHECK(a.tako_terminal->packet_groups.poisoned);
 release_packet(skb);CHECK(a.tako_terminal->refs==1);finish();
}
static int unowned_okfn(struct net *net,struct sock *sk,struct sk_buff *skb) {
 (void)net;(void)sk;(void)skb;ok_calls++;return 7;
}
static void unchanged_cases(void) {
 struct net net={0};struct sk_buff *skb=new_packet();unsigned int alloc=allocation_calls;
 CHECK(NF_HOOK(NFPROTO_IPV4,0,&net,NULL,skb,NULL,NULL,unowned_okfn)==7);
 CHECK(!skb->active_extensions && allocation_calls==alloc);release_packet(skb);
 net=new_net();skb=new_packet();tako_terminal_admission_cut(&net.tako_terminal->admission);
 CHECK(raw_off_cond(NFPROTO_IPV4,0,&net,NULL,skb,NULL,NULL,unowned_okfn,false)==7);
 CHECK(!skb->active_extensions && net.tako_terminal->packet_groups.sockets==0);release_packet(skb);finish();
}
int main(int argc,char **argv) {
 bool selected=argc==2 && !strcmp(argv[1],"handoff-only");
 handoff_cases(selected);
 if(!selected){extension_cases();unchanged_cases();}
 CHECK(!owner_count && !spin_depth && !rcu_depth);
 printf("PASS %lu checks; packetFrees=%u blobFrees=%u hooks=%u list=%u\n",checks,packet_frees,blob_frees,hook_calls,list_calls);
 return 0;
}
