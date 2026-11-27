/* SPDX-License-Identifier: GPL-2.0-only */
/* Whole actual skb_shift and unchanged merge/extension/free bodies under raw
 * heap/page/protocol/opaque-ref boundaries. No kernel or TCP traffic executes. */
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef SHIFT_FUNCTION
#error "select pinned exact before/after body includes"
#endif
#define CONFIG_TAKO_TERMINAL 1
#define IS_ENABLED(x) 0
#define DEBUG_NET_WARN_ON_ONCE(x) assert(!(x))
#define in_hardirq() false
#define WARN_ON_ONCE(x) assert(!(x))
#define BUG_ON(x) assert(!(x))
#define unlikely(x) (x)
#define GFP_ATOMIC 0U
#define CHECKSUM_PARTIAL 1U
#define MAX_SKB_FRAGS 4U
#define __aligned(n) __attribute__((aligned(n)))
typedef uint8_t u8;
typedef unsigned int gfp_t;
typedef unsigned int refcount_t;
static unsigned int checks,headers_live,blobs_live,pages_live;
#define CHECK(x) do { checks++;assert(x); } while(0)
struct tako_terminal_owner { unsigned int refs,poisoned; };
struct net { struct tako_terminal_owner *tako_terminal; };
static unsigned int clone_calls,clone_fail;
static struct tako_terminal_owner *tako_terminal_packet_reserve(struct net *n) {
 struct tako_terminal_owner *o=n->tako_terminal;if(o){CHECK(o->refs);o->refs++;}return o;
}
static struct tako_terminal_owner *tako_terminal_packet_clone(struct tako_terminal_owner *o) {
 CHECK(o && o->refs);clone_calls++;if(clone_fail && clone_calls==clone_fail)return NULL;o->refs++;return o;
}
static void tako_terminal_packet_put(struct tako_terminal_owner *o) { CHECK(o && o->refs>1);o->refs--; }
static void tako_terminal_packet_poison(struct tako_terminal_owner *o) { CHECK(o && o->refs);o->poisoned=1; }
#include "../../scripts/native/docker-container-terminal-kernel-skb-state.h"
enum skb_ext_id { SKB_EXT_TAKO_TERMINAL, SKB_EXT_OTHER, SKB_EXT_NUM };
#include <ext-struct.inc>
struct raw_page { unsigned int refs;unsigned char bytes[64]; };
typedef struct { struct raw_page *page;unsigned int offset,size; } skb_frag_t;
struct raw_shared { unsigned int nr_frags;skb_frag_t frags[8]; };
struct sk_buff {
 refcount_t users;unsigned int active_extensions,slow_gro;struct skb_ext *extensions;
 unsigned int len,data_len,truesize,ip_summed,pp_recycle;
 void (*destructor)(struct sk_buff *);struct raw_shared info;
};
static unsigned int ext_calls,ext_fail,prepare_calls,prepare_fail;
static bool force_zcopy;
static void refcount_inc(refcount_t *p) { CHECK(*p && *p<UINT_MAX);(*p)++; }
static void refcount_set(refcount_t *p,unsigned int n) { *p=n; }
static unsigned int refcount_read(const refcount_t *p) { return *p; }
static bool refcount_dec_and_test(refcount_t *p) { CHECK(*p);return !--*p; }
#define SKB_EXT_ALIGN_VALUE 8U
#define SKB_EXT_CHUNKSIZEOF(x) ((sizeof(x)+7U)/8U)
static const unsigned int skb_ext_type_len[SKB_EXT_NUM]={ [SKB_EXT_TAKO_TERMINAL]=SKB_EXT_CHUNKSIZEOF(struct tako_terminal_skb_refs),[SKB_EXT_OTHER]=1 };
static unsigned int raw_cache;
#define skbuff_ext_cache (&raw_cache)
static void *kmem_cache_alloc(const void *cache,gfp_t f) {
 (void)f;CHECK(cache==skbuff_ext_cache);ext_calls++;if(ext_fail && ext_calls==ext_fail)return NULL;
 void *p=calloc(1,512);CHECK(p);blobs_live++;return p;
}
static void kmem_cache_free(const void *cache,void *p) { CHECK(cache==skbuff_ext_cache && blobs_live);blobs_live--;free(p); }
#define skb_ext_get_ptr(ext,id) ((void *)((char *)(ext)+((ext)->offset[id]*8U)))
struct skb_ext *__skb_ext_alloc(gfp_t flags);
void __skb_ext_put(struct skb_ext *ext);
void *skb_ext_add(struct sk_buff *skb,enum skb_ext_id id);
void tako_terminal_skb_poison(const struct sk_buff *skb);
void tako_terminal_skb_set_owner(struct sk_buff *skb,struct net *net);
void tako_terminal_skb_copy(struct sk_buff *dst,const struct sk_buff *src);
void tako_terminal_skb_merge(struct sk_buff *to,const struct sk_buff *from);
void skb_release_head_state(struct sk_buff *skb);
#include <ext-header.inc>
#include <shared.inc>
#include <__skb_ext_alloc.inc>
#include <__skb_ext_put.inc>
#include <skb_ext_maybe_cow.inc>
#include <skb_ext_add.inc>
#include <tako_skb_snapshot.inc>
#include <tako_skb_restore.inc>
#include <tako_terminal_skb_poison.inc>
#include <tako_terminal_skb_copy.inc>
#include <tako_terminal_skb_set_owner.inc>
#include <tako_terminal_skb_merge.inc>
static void skb_dst_drop(struct sk_buff *s) { (void)s; }
#include <head-state.inc>
#define skb_shinfo(s) (&(s)->info)
static unsigned int skb_headlen(const struct sk_buff *s) { CHECK(s->len>=s->data_len);return s->len-s->data_len; }
static bool skb_zcopy(const struct sk_buff *s) { (void)s;return force_zcopy; }
static bool skb_cmp_decrypted(const struct sk_buff *a,const struct sk_buff *b) { (void)a;(void)b;return false; }
static int skb_unclone_keeptruesize(struct sk_buff *s,gfp_t f) { (void)s;(void)f;prepare_calls++;return prepare_fail && prepare_calls==prepare_fail?-ENOMEM:0; }
#include <skb_prepare_for_shift.inc>
#include <skb_len_add.inc>
static struct raw_page *skb_frag_page(const skb_frag_t *f) { return f->page; }
static unsigned int skb_frag_off(const skb_frag_t *f) { return f->offset; }
static unsigned int skb_frag_size(const skb_frag_t *f) { return f->size; }
static void skb_frag_size_add(skb_frag_t *f,unsigned int n) { f->size+=n; }
static void skb_frag_size_sub(skb_frag_t *f,unsigned int n) { CHECK(f->size>=n);f->size-=n; }
static void skb_frag_off_add(skb_frag_t *f,unsigned int n) { f->offset+=n; }
static void skb_frag_size_set(skb_frag_t *f,unsigned int n) { f->size=n; }
static void skb_frag_page_copy(skb_frag_t *to,const skb_frag_t *from) { to->page=from->page; }
static void skb_frag_off_copy(skb_frag_t *to,const skb_frag_t *from) { to->offset=from->offset; }
static void __skb_frag_ref(skb_frag_t *f) { CHECK(f->page && f->page->refs);f->page->refs++; }
static void __skb_frag_unref(skb_frag_t *f,bool recycle) { CHECK(!recycle && f->page && f->page->refs);if(!--f->page->refs){CHECK(pages_live);pages_live--;free(f->page);} }
static bool skb_can_coalesce(const struct sk_buff *s,int at,const struct raw_page *page,unsigned int offset) {
 if(!at)return false;
 CHECK(at>0 && (unsigned int)at<=s->info.nr_frags);const skb_frag_t *last=&s->info.frags[at-1];return last->page==page && last->offset+last->size==offset;
}
int skb_shift(struct sk_buff *tgt,struct sk_buff *skb,int shiftlen);
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wsign-compare" /* unchanged upstream body expressions */
#include SHIFT_FUNCTION
#undef CONFIG_TAKO_TERMINAL
#define skb_shift raw_off_shift
int raw_off_shift(struct sk_buff *tgt,struct sk_buff *skb,int shiftlen);
#include SHIFT_FUNCTION
#undef skb_shift
#define CONFIG_TAKO_TERMINAL 1
#pragma GCC diagnostic pop
static void skb_release_all(struct sk_buff *s,int reason) {
 CHECK(!reason);__skb_release_head_state(s,true);
 for(unsigned int i=0;i<s->info.nr_frags;i++)__skb_frag_unref(&s->info.frags[i],false);
}
#define SKB_DROP_REASON_NOT_SPECIFIED 0
static void kfree_skbmem(struct sk_buff *s) { CHECK(headers_live);headers_live--;free(s); }
void __kfree_skb(struct sk_buff *s);
#include <__kfree_skb.inc>
static void free_packet(struct sk_buff *s) { CHECK(s->users==1);s->users=0;__kfree_skb(s); }
static struct sk_buff *new_packet(void) { struct sk_buff *s=calloc(1,sizeof(*s));CHECK(s);s->users=1;s->truesize=2048;headers_live++;return s; }
static struct raw_page *new_page(void) { struct raw_page *p=calloc(1,sizeof(*p));CHECK(p);p->refs=1;pages_live++;return p; }
static void add_frag(struct sk_buff *s,struct raw_page *p,unsigned int offset,unsigned int len) {
 CHECK(s->info.nr_frags<8);s->info.frags[s->info.nr_frags++]=(skb_frag_t){p,offset,len};s->len+=len;s->data_len+=len;s->truesize+=len;
}
static void tag(struct sk_buff *s,struct tako_terminal_owner *o) { struct net n={o};tako_terminal_skb_set_owner(s,&n); }
static bool has(const struct sk_buff *s,const struct tako_terminal_owner *o) { const struct tako_terminal_skb_refs *r=skb_ext_find(s,SKB_EXT_TAKO_TERMINAL);if(r)for(unsigned int i=0;i<TAKO_TERMINAL_SKB_OWNERS;i++)if(r->owners[i]==o)return true;return false; }
static void faults_reset(void) { ext_calls=ext_fail=prepare_calls=prepare_fail=clone_calls=clone_fail=0;force_zcopy=false; }
static void balanced(struct tako_terminal_owner *o,unsigned int n) { CHECK(!headers_live && !pages_live && !blobs_live);for(unsigned int i=0;i<n;i++)CHECK(o[i].refs==1);faults_reset(); }
static void origins_case(unsigned int kind) {
 struct tako_terminal_owner o[6];for(unsigned int i=0;i<6;i++)o[i]=(struct tako_terminal_owner){1,0};
 struct sk_buff *t=new_packet(),*s=new_packet(),*shared=NULL;
 add_frag(t,new_page(),0,8);add_frag(s,new_page(),0,8);
 tag(s,&o[1]);if(kind!=4)tag(t,&o[0]);
 if(kind==1)tag(t,&o[1]); /* exact duplicate original retained once */
 if(kind==2){shared=new_packet();__skb_ext_copy(shared,t);}
 if(kind==3){tag(t,&o[2]);tag(t,&o[3]);tag(t,&o[4]);}
 if(kind==5){shared=new_packet();__skb_ext_copy(shared,t);}
 faults_reset();if(kind==4 || kind==5)ext_fail=1;if(kind==6)clone_fail=1;
 CHECK(skb_shift(t,s,8)==8 && !s->len && t->len==16);
 CHECK(t->ip_summed==CHECKSUM_PARTIAL && s->ip_summed==CHECKSUM_PARTIAL);
 if(kind==3 || kind==4 || kind==5 || kind==6)CHECK(o[1].poisoned);
 else {CHECK(has(t,&o[0]) && has(t,&o[1]));CHECK(!o[1].poisoned);}
 faults_reset();free_packet(s); /* actual raw donor heap free before recipient */
 if(kind<3){CHECK(o[1].refs==2);CHECK(has(t,&o[1]) && !o[1].poisoned);}
 if(shared)free_packet(shared);
 free_packet(t);balanced(o,6);
}
static void payload_cases(void) {
 for(unsigned int kind=0;kind<4;kind++) {
  struct tako_terminal_owner o[2]={{1,0},{1,0}};struct sk_buff *t=new_packet(),*s=new_packet();
  struct raw_page *p=new_page();add_frag(t,p,0,8);
  if(kind>=2){p->refs++;add_frag(s,p,8,8);}else add_frag(s,new_page(),0,8);
  tag(t,&o[0]);tag(s,&o[1]);faults_reset();int len=(kind&1)?4:8;
  CHECK(skb_shift(t,s,len)==len);CHECK(s->len==(unsigned int)(8-len) && t->len==(unsigned int)(8+len));
  CHECK(has(t,&o[0]) && has(t,&o[1]) && !o[1].poisoned);
  free_packet(s);CHECK(o[1].refs==2);free_packet(t);balanced(o,2);
 }
}
static void no_effect_cases(void) {
 for(unsigned int kind=0;kind<7;kind++) {
  struct tako_terminal_owner o[2]={{1,0},{1,0}};struct sk_buff *t=new_packet(),*s=new_packet();
  add_frag(t,new_page(),0,8);add_frag(s,new_page(),0,8);tag(t,&o[0]);tag(s,&o[1]);faults_reset();
  int amount=8;if(kind==0)amount=0;if(kind==1){s->len++;}if(kind==2)force_zcopy=true;
  if(kind==3)prepare_fail=1;
  if(kind==4)prepare_fail=2;
  if(kind==5 || kind==6){for(unsigned int i=1;i<MAX_SKB_FRAGS;i++)add_frag(t,new_page(),0,8);if(kind==6)amount=4;}
  unsigned int len=t->len,donor=s->len,ext=ext_calls,clone=clone_calls;
  CHECK(skb_shift(t,s,amount)==0);CHECK(t->len==len && s->len==donor);
  CHECK(!has(t,&o[1]) && !o[1].poisoned && ext_calls==ext && clone_calls==clone);
  faults_reset();free_packet(s);free_packet(t);balanced(o,2);
 }
}
static void off_and_unowned(void) {
 for(unsigned int off=0;off<2;off++) {
  struct sk_buff *t=new_packet(),*s=new_packet();add_frag(s,new_page(),0,8);faults_reset();
  CHECK((off?raw_off_shift(t,s,8):skb_shift(t,s,8))==8);CHECK(!ext_calls && !clone_calls);
  free_packet(s);free_packet(t);balanced(NULL,0);
 }
 /* Off function alone must not merge even artificially tagged raw headers;
  * helpers stay enabled in this TU, so this is not whole CONFIGoff proof. */
 struct tako_terminal_owner o[2]={{1,0},{1,0}};struct sk_buff *t=new_packet(),*s=new_packet();
 tag(t,&o[0]);tag(s,&o[1]);add_frag(s,new_page(),0,8);faults_reset();
 CHECK(raw_off_shift(t,s,8)==8 && !has(t,&o[1]));free_packet(s);free_packet(t);balanced(o,2);
}
int main(int argc,char **argv) {
 bool selected=argc>1 && !strcmp(argv[1],"selected-only");origins_case(0);if(selected)return 0;
 for(unsigned int i=1;i<7;i++)origins_case(i);
 payload_cases();no_effect_cases();off_and_unowned();
 printf("PASS %u raw payload-shift origin checks; no kernel/native execution\n",checks);return 0;
}
