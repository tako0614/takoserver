/* SPDX-License-Identifier: GPL-2.0-only */
/* Exact actual segmentation and existing extension bodies over raw heap,
 * protocol/page/refcount boundaries; no kernel ABI/runtime/traffic proof. */
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef SEGMENT_FUNCTIONS
#error "select source-packet exact before/after function includes"
#endif
#define CONFIG_TAKO_TERMINAL 1
#define IS_ENABLED(x) 0
#define unlikely(x) (x)
#define likely(x) (x)
#define BUG_ON(x) assert(!(x))
#define WARN_ON_ONCE(x) assert(!(x))
#define DEBUG_NET_WARN_ON_ONCE(x) assert(!(x))
#define in_hardirq() false
#define GFP_ATOMIC 0U
#define NUMA_NO_NODE (-1)
#define NETIF_F_SG 1ULL
#define NETIF_F_GSO_PARTIAL 4ULL
#define RAW_CSUM 2ULL
#define GSO_BY_FRAGS 65535U
#define SKB_GSO_DODGY 1U
#define SKB_GSO_PARTIAL 2U
#define SKBFL_SHARED_FRAG 1U
#define CHECKSUM_NONE 0U
#define MAX_SKB_FRAGS 4U
#define DIV_ROUND_UP(n,d) (((n)+(d)-1)/(d))
#define min(a,b) ((a)<(b)?(a):(b))
#define swap(a,b) do { __typeof__(a) raw_swap=(a);(a)=(b);(b)=raw_swap; } while(0)
#define ERR_PTR(n) ((void *)(intptr_t)(n))
#define IS_ERR(p) ((uintptr_t)(p)>=(uintptr_t)-4095L)
#define __aligned(n) __attribute__((aligned(n)))
#define CHECK_SKB_FIELD(field) ((void)0) /* raw layout is not kernel layout */
typedef uint8_t u8;
typedef uint16_t __be16;
typedef unsigned int refcount_t;
typedef unsigned int gfp_t;
typedef uint64_t netdev_features_t;
static unsigned int checks, headers_live, blobs_live, pages_live;
#define CHECK(e) do { checks++;assert(e); } while(0)
struct tako_terminal_owner { unsigned int refs, poisoned; };
struct net { struct tako_terminal_owner *tako_terminal; };
static struct tako_terminal_owner *tako_terminal_packet_reserve(struct net *net) {
 struct tako_terminal_owner *o=net->tako_terminal;if(o){CHECK(o->refs);o->refs++;}return o;
}
static struct tako_terminal_owner *tako_terminal_packet_clone(struct tako_terminal_owner *o) {
 CHECK(o && o->refs);o->refs++;return o;
}
static void tako_terminal_packet_put(struct tako_terminal_owner *o) { CHECK(o && o->refs>1);o->refs--; }
static void tako_terminal_packet_poison(struct tako_terminal_owner *o) { CHECK(o && o->refs);o->poisoned=1; }
#include "../../scripts/native/docker-container-terminal-kernel-skb-state.h"
enum skb_ext_id { SKB_EXT_TAKO_TERMINAL, SKB_EXT_OTHER, SKB_EXT_NUM };
#include <ext-struct.inc>
struct raw_page { unsigned int refs; unsigned char bytes[64]; };
typedef struct { struct raw_page *page; unsigned int offset,size; } skb_frag_t;
struct sk_buff;
struct raw_shared { struct sk_buff *frag_list; unsigned int gso_size,gso_type,gso_segs,nr_frags,flags;skb_frag_t frags[8]; };
struct raw_gso_cb { unsigned int csum,csum_start,data_offset; };
struct sk_buff {
 refcount_t users;unsigned int active_extensions,slow_gro;struct skb_ext *extensions;
 struct sk_buff *next,*prev;unsigned char *head,*data;unsigned int len,data_len,truesize,end;
 unsigned int head_frag,remcsum_offload,ip_summed,queue_mapping;
 unsigned long tstamp;void *dev,*sk;unsigned char cb[32];
 union { struct { unsigned int network_header,transport_header,mac_header; };unsigned char headers[32]; };
 void (*destructor)(struct sk_buff *);struct raw_shared info;struct raw_gso_cb gso;
};
static unsigned int ext_calls,ext_fail,alloc_calls,alloc_fail,clone_calls,clone_fail;
static unsigned int unclone_calls,unclone_fail,trim_calls,trim_fail,cow_calls,cow_fail;
static unsigned int linear_calls,linear_fail,copy_calls,copy_fail,zero_calls,zero_fail;
static unsigned int protocol_releases;
static bool force_linearize,zero_protocol;
static void refcount_inc(refcount_t *p) { CHECK(*p && *p<UINT_MAX);(*p)++; }
static void refcount_set(refcount_t *p,unsigned int n) { *p=n; }
static unsigned int refcount_read(const refcount_t *p) { return *p; }
static bool refcount_dec_and_test(refcount_t *p) { CHECK(*p);return !--*p; }
#define SKB_EXT_ALIGN_VALUE 8U
#define SKB_EXT_CHUNKSIZEOF(x) ((sizeof(x)+7U)/8U)
static const unsigned int skb_ext_type_len[SKB_EXT_NUM] = {
 [SKB_EXT_TAKO_TERMINAL]=SKB_EXT_CHUNKSIZEOF(struct tako_terminal_skb_refs),[SKB_EXT_OTHER]=1
};
static unsigned int raw_cache;
#define skbuff_ext_cache (&raw_cache)
static void *kmem_cache_alloc(const void *cache,gfp_t flags) {
 (void)flags;CHECK(cache==skbuff_ext_cache);ext_calls++;
 if(ext_fail && ext_calls==ext_fail)return NULL;
 void *p=calloc(1,512);CHECK(p);blobs_live++;return p;
}
static void kmem_cache_free(const void *cache,void *ptr) { CHECK(cache==skbuff_ext_cache && blobs_live);blobs_live--;free(ptr); }
#define skb_ext_get_ptr(ext,id) ((void *)((char *)(ext)+((ext)->offset[id]*8U)))
struct skb_ext *__skb_ext_alloc(gfp_t flags);
void __skb_ext_put(struct skb_ext *ext);
void *skb_ext_add(struct sk_buff *skb,enum skb_ext_id id);
void tako_terminal_skb_poison(const struct sk_buff *skb);
void tako_terminal_skb_set_owner(struct sk_buff *skb,struct net *net);
void tako_terminal_skb_copy(struct sk_buff *dst,const struct sk_buff *src);
void skb_release_head_state(struct sk_buff *skb);
#include <ext-header.inc>
#include <shared.inc>
#include <__skb_ext_alloc.inc>
#include <__skb_ext_put.inc>
#include <skb_ext_maybe_cow.inc>
#include <skb_ext_add.inc>
#include <tako_skb_snapshot.inc>
#include <tako_skb_restore.inc>
#include <tako_terminal_skb_copy.inc>
#include <tako_terminal_skb_poison.inc>
#include <tako_terminal_skb_set_owner.inc>
static void skb_dst_drop(struct sk_buff *skb) { (void)skb;protocol_releases++; }
#include <head-state.inc>
static void skb_dst_copy(struct sk_buff *dst,const struct sk_buff *src) { (void)dst;(void)src; }
static void __nf_copy(struct sk_buff *dst,const struct sk_buff *src,bool set) { (void)dst;(void)src;(void)set; }
#include <__copy_skb_header.inc>
#define skb_shinfo(s) (&(s)->info)
#define SKB_GSO_CB(s) (&(s)->gso)
#define skb_walk_frags(s,iter) for((iter)=skb_shinfo(s)->frag_list;(iter);(iter)=(iter)->next)
static unsigned int skb_headroom(const struct sk_buff *s) { return (unsigned int)(s->data-s->head); }
static unsigned int skb_headlen(const struct sk_buff *s) { CHECK(s->len>=s->data_len);return s->len-s->data_len; }
static unsigned int skb_end_offset(const struct sk_buff *s) { return s->end; }
static unsigned int skb_tnl_header_len(const struct sk_buff *s) { (void)s;return 0; }
static unsigned char *skb_mac_header(const struct sk_buff *s) { return s->head+s->mac_header; }
static int skb_network_offset(const struct sk_buff *s) { return (int)s->network_header-(int)skb_headroom(s); }
static int skb_network_header_len(const struct sk_buff *s) { return (int)s->transport_header-(int)s->network_header; }
static unsigned char *skb_push(struct sk_buff *s,unsigned int n) { CHECK(skb_headroom(s)>=n);s->data-=n;s->len+=n;return s->data; }
#define __skb_push skb_push
static unsigned char *skb_put(struct sk_buff *s,unsigned int n) { unsigned int linear=skb_headlen(s);CHECK(skb_headroom(s)+linear+n<=s->end);unsigned char *p=s->data+linear;s->len+=n;return p; }
#define __skb_put skb_put
static void skb_reserve(struct sk_buff *s,unsigned int n) { CHECK(!s->len && n<s->end);s->data+=n; }
static void skb_headers_offset_update(struct sk_buff *s,int n) { s->network_header+=n;s->transport_header+=n;s->mac_header+=n; }
static void skb_reset_mac_len(struct sk_buff *s) { (void)s; }
static void skb_gso_reset(struct sk_buff *s) { s->info.gso_size=s->info.gso_type=s->info.gso_segs=0; }
static bool skb_needs_linearize(const struct sk_buff *s,netdev_features_t f) { (void)s;(void)f;return force_linearize; }
static int __skb_linearize(struct sk_buff *s) { (void)s;linear_calls++;return linear_fail && linear_calls==linear_fail ? -ENOMEM:0; }
static int skb_unclone(struct sk_buff *s,gfp_t flags) { (void)s;(void)flags;unclone_calls++;return unclone_fail && unclone_calls==unclone_fail ? -ENOMEM:0; }
static int pskb_trim(struct sk_buff *s,unsigned int len) { trim_calls++;if(trim_fail && trim_calls==trim_fail)return -ENOMEM;CHECK(s->len>=len);s->len=len;return 0; }
static int skb_cow_head(struct sk_buff *s,unsigned int room) { (void)s;CHECK(room<=64);cow_calls++;return cow_fail && cow_calls==cow_fail ? -ENOMEM:0; }
static void skb_copy_from_linear_data_offset(const struct sk_buff *s,int offset,void *dst,unsigned int n) { if(!n)return;CHECK(offset>=0 && (unsigned int)offset+n<=skb_headlen(s));memcpy(dst,s->data+offset,n); }
static __be16 skb_network_protocol(const struct sk_buff *s,void *inner) { (void)s;(void)inner;return zero_protocol?0:1; }
static bool can_checksum_protocol(netdev_features_t f,__be16 proto) { CHECK(proto);return (f&RAW_CSUM)!=0; }
static bool net_gso_ok(netdev_features_t f,unsigned int type) { (void)f;(void)type;return false; }
static unsigned int skb_alloc_rx_flag(const struct sk_buff *s) { (void)s;return 0; }
static int skb_orphan_frags(struct sk_buff *s,gfp_t f) { (void)s;(void)f;return 0; }
static int skb_zerocopy_clone(struct sk_buff *dst,struct sk_buff *src,gfp_t f) { (void)dst;(void)src;(void)f;zero_calls++;return zero_fail && zero_calls==zero_fail ? -ENOMEM:0; }
static int skb_copy_bits(const struct sk_buff *s,unsigned int offset,void *dst,unsigned int n) { copy_calls++;if(copy_fail && copy_calls==copy_fail)return -EFAULT;CHECK(offset+n<=skb_headlen(s));memcpy(dst,s->data+offset,n);return 0; }
static unsigned int skb_copy_and_csum_bits(const struct sk_buff *s,unsigned int o,void *dst,unsigned int n) { CHECK(skb_copy_bits(s,o,dst,n)==0);return 0; }
static bool skb_has_shared_frag(const struct sk_buff *s) { (void)s;return force_linearize; }
static unsigned int skb_checksum(const struct sk_buff *s,unsigned int off,unsigned int n,unsigned int seed) { CHECK(off+n<=s->len);return seed; }
static unsigned int skb_frag_size(const skb_frag_t *f) { return f->size; }
static void skb_frag_off_add(skb_frag_t *f,unsigned int n) { f->offset+=n; }
static void skb_frag_size_sub(skb_frag_t *f,unsigned int n) { CHECK(f->size>=n);f->size-=n; }
static void __skb_frag_ref(skb_frag_t *f) { CHECK(f->page && f->page->refs);f->page->refs++; }
static skb_frag_t skb_head_frag_to_page_desc(struct sk_buff *s) { (void)s;CHECK(!"head-frag conversion is outside selected raw paths");return (skb_frag_t){0}; }
#define net_warn_ratelimited(...) ((void)0)
static void sock_wfree(struct sk_buff *s) { (void)s; }
static void kfree_skb(struct sk_buff *s);
static void kfree_skb_list(struct sk_buff *s);
static struct sk_buff *raw_packet(unsigned int len,unsigned int headroom) {
 struct sk_buff *s=calloc(1,sizeof(*s));CHECK(s);s->head=calloc(1,2048);CHECK(s->head);s->end=2048;s->data=s->head+headroom;s->len=len;s->truesize=2048;s->users=1;s->network_header=s->transport_header=s->mac_header=headroom;headers_live++;return s;
}
static struct sk_buff *__alloc_skb(unsigned int size,gfp_t flags,unsigned int rx,int node) {
 (void)flags;CHECK(!rx && node==NUMA_NO_NODE && size<2048);alloc_calls++;if(alloc_fail && alloc_calls==alloc_fail)return NULL;return raw_packet(0,0);
}
static struct sk_buff *skb_clone(struct sk_buff *src,gfp_t flags) {
 (void)flags;clone_calls++;if(clone_fail && clone_calls==clone_fail)return NULL;
 struct sk_buff *dst=raw_packet(src->len,skb_headroom(src));dst->data_len=src->data_len;dst->info=src->info;CHECK(!dst->info.frag_list);
 memcpy(dst->data,src->data,skb_headlen(src));for(unsigned int i=0;i<src->info.nr_frags;i++)__skb_frag_ref(&dst->info.frags[i]);
 __copy_skb_header(dst,src);return dst; /* raw payload copy, real low-level extension share */
}
static void skb_get(struct sk_buff *s) { CHECK(s->users);s->users++; }
static void consume_skb(struct sk_buff *s) { kfree_skb(s); }
struct sk_buff *skb_segment_list(struct sk_buff *s,netdev_features_t f,unsigned int offset);
struct sk_buff *skb_segment(struct sk_buff *s,netdev_features_t f);
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wsign-compare" /* unchanged upstream kernel bodies */
#include SEGMENT_FUNCTIONS
#undef CONFIG_TAKO_TERMINAL
#define skb_segment_list raw_off_segment_list
#define skb_segment raw_off_segment
struct sk_buff *raw_off_segment_list(struct sk_buff *s,netdev_features_t f,unsigned int offset);
struct sk_buff *raw_off_segment(struct sk_buff *s,netdev_features_t f);
#include SEGMENT_FUNCTIONS
#pragma GCC diagnostic pop
#undef skb_segment_list
#undef skb_segment
#define CONFIG_TAKO_TERMINAL 1
static void skb_release_all(struct sk_buff *s,int reason) {
 CHECK(!reason);__skb_release_head_state(s,true);
 kfree_skb_list(s->info.frag_list);s->info.frag_list=NULL;
 for(unsigned int i=0;i<s->info.nr_frags;i++){struct raw_page *p=s->info.frags[i].page;CHECK(p && p->refs);if(!--p->refs){CHECK(pages_live);pages_live--;free(p);}}
 free(s->head);s->head=s->data=NULL;
}
#define SKB_DROP_REASON_NOT_SPECIFIED 0
static void kfree_skbmem(struct sk_buff *s) { CHECK(!s->head && headers_live);headers_live--;free(s); }
void __kfree_skb(struct sk_buff *s);
#include <__kfree_skb.inc>
static void kfree_skb(struct sk_buff *s) { if(!s)return;CHECK(s->users);if(!--s->users)__kfree_skb(s); }
static void kfree_skb_list(struct sk_buff *s) { while(s){struct sk_buff *next=s->next;kfree_skb(s);s=next;} }
static void tag(struct sk_buff *s,struct tako_terminal_owner *o) { struct net net={o};tako_terminal_skb_set_owner(s,&net); }
static bool has(const struct sk_buff *s,const struct tako_terminal_owner *o) { const struct tako_terminal_skb_refs *r=skb_ext_find(s,SKB_EXT_TAKO_TERMINAL);if(r)for(unsigned int i=0;i<TAKO_TERMINAL_SKB_OWNERS;i++)if(r->owners[i]==o)return true;return false; }
static void reset_faults(void) { ext_calls=ext_fail=alloc_calls=alloc_fail=clone_calls=clone_fail=unclone_calls=unclone_fail=trim_calls=trim_fail=cow_calls=cow_fail=linear_calls=linear_fail=copy_calls=copy_fail=zero_calls=zero_fail=0;force_linearize=zero_protocol=false; }
static void balanced(struct tako_terminal_owner *owners,unsigned int n) { CHECK(!headers_live && !blobs_live && !pages_live);for(unsigned int i=0;i<n;i++)CHECK(owners[i].refs==1);reset_faults(); }
static struct sk_buff *list_input(struct tako_terminal_owner *p,struct tako_terminal_owner *a,struct tako_terminal_owner *b) {
 struct sk_buff *head=raw_packet(16,64),*one=raw_packet(8,64),*two=raw_packet(8,64);
 head->info.frag_list=one;one->next=two;head->data_len=16;head->len=32;head->truesize+=one->truesize+two->truesize;
 if(p)tag(head,p);
 if(a)tag(one,a);
 if(b)tag(two,b);
 return head;
}
static void list_case(unsigned int mode,bool selected) {
 struct tako_terminal_owner o[6];for(unsigned int i=0;i<6;i++)o[i]=(struct tako_terminal_owner){1,0};
 struct sk_buff *head=list_input(&o[0],&o[1],&o[2]),*external=NULL;
 if(mode==1){external=head->info.frag_list;skb_get(external);}
 if(mode==2){tag(head,&o[1]);} /* same original dedup on one output */
 if(mode==3){tag(head,&o[3]);tag(head,&o[4]);tag(head,&o[5]);}
 reset_faults();if(mode==4)ext_fail=1;
 struct sk_buff *out=skb_segment_list(head,0,0);CHECK(out==head && out->next && out->next->next);
 if(mode==3)CHECK(o[1].poisoned && o[2].poisoned);
 else if(mode==4)CHECK(o[1].poisoned);
 else {CHECK(!o[1].poisoned && !o[2].poisoned);CHECK(has(out->next,&o[0]) && has(out->next,&o[1]));CHECK(has(out->next->next,&o[2]));}
 kfree_skb_list(out);head->next=NULL;kfree_skb(head);if(external)kfree_skb(external);balanced(o,6);
 (void)selected;
}
static void list_failures(void) {
 for(unsigned int kind=0;kind<5;kind++) {
  struct tako_terminal_owner o[3]={{1,0},{1,0},{1,0}};struct sk_buff *head=list_input(&o[0],&o[1],&o[2]),*external=NULL;
  if(kind==1 || kind==2){external=head->info.frag_list;skb_get(external);}
  reset_faults();if(kind==0)unclone_fail=1;if(kind==1)clone_fail=1;if(kind==2)unclone_fail=2;
  if(kind==3 || kind==4){force_linearize=true;linear_fail=kind==3?1:3;}
  CHECK(IS_ERR(skb_segment_list(head,0,0)));kfree_skb(head);if(external)kfree_skb(external);
  for(unsigned int i=0;i<3;i++)CHECK(!o[i].poisoned);
  balanced(o,3);
 }
}
static struct sk_buff *clone_input(struct tako_terminal_owner *p,struct tako_terminal_owner *a,struct tako_terminal_owner *b,unsigned int mss) {
 struct sk_buff *s=list_input(p,a,b);s->len=s->data_len=16;s->info.gso_size=mss;return s;
}
static void clone_cases(void) {
 for(unsigned int kind=0;kind<8;kind++) {
  struct tako_terminal_owner o[3]={{1,0},{1,0},{1,0}};struct sk_buff *head=clone_input(&o[0],&o[1],&o[2],kind==1?GSO_BY_FRAGS:8);
  reset_faults();if(kind==2)clone_fail=1;if(kind==3)trim_fail=1;if(kind==4)cow_fail=1;if(kind==5)ext_fail=1;if(kind==6){force_linearize=true;linear_fail=1;}
  struct sk_buff *out=skb_segment(head,NETIF_F_SG|(kind==6?0:RAW_CSUM));
  if(kind==2 || kind==3 || kind==4 || kind==6)CHECK(IS_ERR(out));
  else {CHECK(!IS_ERR(out) && out && out->next);if(kind==5)CHECK(o[1].poisoned);else {CHECK(!o[1].poisoned && !o[2].poisoned);CHECK(has(out,&o[0]) && has(out,&o[1]) && has(out->next,&o[2]));}kfree_skb_list(out);}
  kfree_skb(head);balanced(o,3);
 }
}
static void fresh_cases(void) {
 for(unsigned int kind=0;kind<6;kind++) {
  struct tako_terminal_owner o={1,0};struct sk_buff *head=raw_packet(32,64);head->info.gso_size=8;tag(head,&o);reset_faults();
  netdev_features_t features=RAW_CSUM;if(kind==1)features=0;if(kind==2)alloc_fail=2;if(kind==3)copy_fail=2;if(kind==4)zero_protocol=true;if(kind==5)features=NETIF_F_SG|RAW_CSUM|NETIF_F_GSO_PARTIAL;
  struct sk_buff *out=skb_segment(head,features);
  if(kind==2 || kind==3 || kind==4)CHECK(IS_ERR(out));else {CHECK(!IS_ERR(out));for(struct sk_buff *s=out;s;s=s->next)CHECK(has(s,&o));kfree_skb_list(out);}
  kfree_skb(head);CHECK(!o.poisoned);balanced(&o,1);
 }
}
static void page_cases(void) {
 for(unsigned int kind=0;kind<3;kind++) {
  struct tako_terminal_owner o={1,0};struct sk_buff *head=raw_packet(0,64);head->info.nr_frags=kind==2?5:1;head->info.gso_size=kind==2?20:8;
  for(unsigned int i=0;i<head->info.nr_frags;i++){struct raw_page *p=calloc(1,sizeof(*p));CHECK(p);p->refs=1;pages_live++;head->info.frags[i]=(skb_frag_t){p,0,kind==2?4:16};head->data_len+=head->info.frags[i].size;}
  head->len=head->data_len;tag(head,&o);reset_faults();if(kind==1)zero_fail=1;
  struct sk_buff *out=skb_segment(head,NETIF_F_SG|RAW_CSUM);
  if(kind)CHECK(IS_ERR(out));else {CHECK(!IS_ERR(out));kfree_skb_list(out);}kfree_skb(head);CHECK(!o.poisoned);balanced(&o,1);
 }
}
static void ordinary_and_off(void) {
 for(unsigned int off=0;off<2;off++) {
  struct sk_buff *head=list_input(NULL,NULL,NULL);reset_faults();unsigned int before=ext_calls;
  struct sk_buff *out=off?raw_off_segment_list(head,0,0):skb_segment_list(head,0,0);CHECK(out==head && ext_calls==before);kfree_skb_list(out);head->next=NULL;kfree_skb(head);balanced(NULL,0);
  head=raw_packet(16,64);head->info.gso_size=8;out=off?raw_off_segment(head,RAW_CSUM):skb_segment(head,RAW_CSUM);CHECK(!IS_ERR(out) && !ext_calls);kfree_skb_list(out);kfree_skb(head);balanced(NULL,0);
 }
 /* Arbitrary public detach remains conservative after this exact transfer fix. */
 struct tako_terminal_owner o={1,0};struct sk_buff *s=raw_packet(8,64);tag(s,&o);skb_release_head_state(s);CHECK(o.poisoned);s->active_extensions=0;kfree_skb(s);balanced(&o,1);
}
int main(int argc,char **argv) {
 bool selected=argc>1 && !strcmp(argv[1],"selected-only");list_case(0,selected);if(selected)return 0;
 for(unsigned int mode=1;mode<5;mode++)list_case(mode,false);
 list_failures();clone_cases();fresh_cases();page_cases();ordinary_and_off();
 printf("PASS %u raw segmentation-origin checks; no kernel/native execution\n",checks);return 0;
}
