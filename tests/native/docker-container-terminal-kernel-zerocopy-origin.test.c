/* SPDX-License-Identifier: GPL-2.0-only */
/* Whole actual v6.12 skb_zerocopy plus unchanged actual extension/origin/free
 * helpers. Heap frees are real; page, skb geometry, allocation failures and
 * opaque owner refs are bounded models. No kernel/NFQUEUE/OCI executes.
 * Portable extraction recipe is included below, without private paths.
 */
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef ZEROCOPY_FUNCTION
#error "select exact before/after body includes from the recipe below"
#endif
#define CONFIG_TAKO_TERMINAL 1
#define IS_ENABLED(x) 0
#define DEBUG_NET_WARN_ON_ONCE(x) assert(!(x))
#define in_hardirq() false
#define WARN_ON_ONCE(x) assert(!(x))
#define BUG_ON(x) assert(!(x))
#define unlikely(x) (x)
#define GFP_ATOMIC 0U
#define __aligned(n) __attribute__((aligned(n)))
#define min_t(type,a,b) ((type)(a)<(type)(b)?(type)(a):(type)(b))
typedef uint8_t u8;
typedef unsigned int gfp_t;
typedef unsigned int refcount_t;
static unsigned int checks, headers_live, blobs_live, pages_live;
#define CHECK(x) do { checks++; assert(x); } while (0)
struct tako_terminal_owner { unsigned int refs, poisoned; };
struct net { struct tako_terminal_owner *tako_terminal; };
static unsigned int clone_calls, clone_fail;
static struct tako_terminal_owner *tako_terminal_packet_reserve(struct net *n) {
 struct tako_terminal_owner *o=n->tako_terminal;
 if(o){CHECK(o->refs);o->refs++;}return o;
}
static struct tako_terminal_owner *tako_terminal_packet_clone(struct tako_terminal_owner *o) {
 CHECK(o && o->refs);clone_calls++;
 if(clone_fail && clone_calls==clone_fail)return NULL;
 o->refs++;return o;
}
static void tako_terminal_packet_put(struct tako_terminal_owner *o) { CHECK(o && o->refs>1);o->refs--; }
static void tako_terminal_packet_poison(struct tako_terminal_owner *o) { CHECK(o && o->refs);o->poisoned=1; }
#include "../../scripts/native/docker-container-terminal-kernel-skb-state.h"
enum skb_ext_id { SKB_EXT_TAKO_TERMINAL, SKB_EXT_OTHER, SKB_EXT_NUM };
#include <ext-struct.inc>
struct page { unsigned int refs;unsigned char bytes[512]; };
typedef struct { struct page *page;unsigned int offset,size; } skb_frag_t;
struct raw_shared { unsigned int nr_frags;skb_frag_t frags[8]; };
struct sk_buff {
 refcount_t users;unsigned int active_extensions,slow_gro;struct skb_ext *extensions;
 unsigned int len,data_len,truesize,head_frag,tail,capacity;
 unsigned char *head,*data;struct page *head_page;
 void (*destructor)(struct sk_buff *);struct raw_shared info;
};
static unsigned int ext_calls,ext_fail,copy_calls,copy_fail,orphan_calls,orphan_fail;
static unsigned int tx_errors,zcopy_calls,effects;
static bool first_effect_retained;
static unsigned int raw_cache;
#define skbuff_ext_cache (&raw_cache)
static void refcount_inc(refcount_t *p) { CHECK(*p && *p<UINT_MAX);(*p)++; }
static void refcount_set(refcount_t *p,unsigned int n) { *p=n; }
static unsigned int refcount_read(const refcount_t *p) { return *p; }
static bool refcount_dec_and_test(refcount_t *p) { CHECK(*p);return !--*p; }
#define SKB_EXT_ALIGN_VALUE 8U
#define SKB_EXT_CHUNKSIZEOF(x) ((sizeof(x)+7U)/8U)
static const unsigned int skb_ext_type_len[SKB_EXT_NUM]={ [SKB_EXT_TAKO_TERMINAL]=SKB_EXT_CHUNKSIZEOF(struct tako_terminal_skb_refs),[SKB_EXT_OTHER]=1 };
static void *kmem_cache_alloc(const void *cache,gfp_t f) {
 (void)f;CHECK(cache==skbuff_ext_cache);ext_calls++;
 if(ext_fail && ext_calls==ext_fail)return NULL;
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
static unsigned int skb_tailroom(const struct sk_buff *s) { CHECK(s->capacity>=s->tail);return s->capacity-s->tail; }
static unsigned char *skb_put(struct sk_buff *s,unsigned int n) {
 CHECK(n<=skb_tailroom(s));unsigned char *p=s->data+s->tail;s->tail+=n;s->len+=n;return p;
}
static bool has(const struct sk_buff *s,const struct tako_terminal_owner *o) {
 const struct tako_terminal_skb_refs *r=skb_ext_find(s,SKB_EXT_TAKO_TERMINAL);
 if(r)for(unsigned int i=0;i<TAKO_TERMINAL_SKB_OWNERS;i++)if(r->owners[i]==o)return true;
 return false;
}
static void payload_effect(const struct sk_buff *to,const struct sk_buff *from) {
 if(effects++)return;
 first_effect_retained=true;
 const struct tako_terminal_skb_refs *r=skb_ext_find(from,SKB_EXT_TAKO_TERMINAL);
 if(r)for(unsigned int i=0;i<TAKO_TERMINAL_SKB_OWNERS;i++)
  if(r->owners[i] && !has(to,r->owners[i]) && !r->owners[i]->poisoned)first_effect_retained=false;
}
static struct sk_buff *effect_to;
/* Geometry/copy boundary can write a prefix before returning EFAULT. */
static int skb_copy_bits(const struct sk_buff *from,int offset,void *out,int n) {
 CHECK(!offset && n>=0 && (unsigned int)n<=from->len);copy_calls++;
 if(n)payload_effect(effect_to,from);
 unsigned int amount=(copy_fail && copy_calls==copy_fail)?(unsigned int)n/2U:(unsigned int)n;
 unsigned char *dst=out;
 for(unsigned int k=0;k<amount;k++) {
  unsigned int at=k,linear=skb_headlen(from);
  if(at<linear){dst[k]=from->data[at];continue;}
  at-=linear;bool found=false;
  for(unsigned int j=0;j<from->info.nr_frags;j++) {
   const skb_frag_t *f=&from->info.frags[j];
   if(at<f->size){dst[k]=f->page->bytes[f->offset+at];found=true;break;}at-=f->size;
  }
  CHECK(found);
 }
 return copy_fail && copy_calls==copy_fail?-EFAULT:0;
}
static struct page *virt_to_head_page(const unsigned char *head) { return (struct page *)(void *)(head - offsetof(struct page,bytes)); }
static void *page_address(struct page *p) { return p->bytes; }
static struct page *page_to_netmem(struct page *p) { return p; }
static void get_page(struct page *p) { CHECK(p && p->refs);p->refs++; }
static void put_page(struct page *p) { CHECK(p && p->refs);if(!--p->refs){CHECK(pages_live);pages_live--;free(p);} }
static const struct sk_buff *effect_from;
static void __skb_fill_netmem_desc(struct sk_buff *s,int j,struct page *p,unsigned int offset,int n) {
 CHECK(j>=0 && j<8 && n>0);payload_effect(s,effect_from);
 s->info.frags[j]=(skb_frag_t){p,offset,(unsigned int)n};
}
static unsigned int skb_frag_size(const skb_frag_t *f) { return f->size; }
static void skb_frag_size_set(skb_frag_t *f,unsigned int n) { f->size=n; }
static void skb_frag_ref(struct sk_buff *s,int j) { CHECK(j>=0 && j<8);payload_effect(s,effect_from);get_page(s->info.frags[j].page); }
static int skb_orphan_frags(struct sk_buff *s,gfp_t f) { (void)s;(void)f;orphan_calls++;return orphan_fail && orphan_calls==orphan_fail?-ENOMEM:0; }
static void skb_tx_error(struct sk_buff *s) { (void)s;tx_errors++; }
/* Existing zerocopy-notification protocol is a boundary, not origin logic. */
static int skb_zerocopy_clone(struct sk_buff *to,struct sk_buff *from,gfp_t f) { (void)to;(void)from;(void)f;zcopy_calls++;return 0; }
#include <skb_len_add.inc>
int skb_zerocopy(struct sk_buff *to,struct sk_buff *from,int len,int hlen);
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wsign-compare" /* unchanged upstream expressions */
#include ZEROCOPY_FUNCTION
#undef CONFIG_TAKO_TERMINAL
#define skb_zerocopy raw_off_zerocopy
int raw_off_zerocopy(struct sk_buff *to,struct sk_buff *from,int len,int hlen);
#include ZEROCOPY_FUNCTION
#undef skb_zerocopy
#define CONFIG_TAKO_TERMINAL 1
#pragma GCC diagnostic pop
static void skb_release_all(struct sk_buff *s,int reason) {
 CHECK(!reason);__skb_release_head_state(s,true);
 for(unsigned int i=0;i<s->info.nr_frags;i++)put_page(s->info.frags[i].page);
 put_page(s->head_page);
}
#define SKB_DROP_REASON_NOT_SPECIFIED 0
static void kfree_skbmem(struct sk_buff *s) { CHECK(headers_live);headers_live--;free(s); }
void __kfree_skb(struct sk_buff *s);
#include <__kfree_skb.inc>
static void free_packet(struct sk_buff *s) { CHECK(s->users==1);s->users=0;__kfree_skb(s); }
static struct page *new_page(void) { struct page *p=calloc(1,sizeof(*p));CHECK(p);p->refs=1;pages_live++;return p; }
static struct sk_buff *new_packet(unsigned int linear,unsigned int capacity) {
 struct sk_buff *s=calloc(1,sizeof(*s));CHECK(s && linear<=capacity && capacity<496);
 s->users=1;s->truesize=512;s->head_page=new_page();s->head=s->head_page->bytes;
 s->data=s->head+16;s->capacity=capacity;s->len=s->tail=linear;headers_live++;
 for(unsigned int i=0;i<linear;i++)s->data[i]=(unsigned char)(i+1);
 return s;
}
static void add_frag(struct sk_buff *s,unsigned int n) {
 CHECK(s->info.nr_frags<8 && n<512);struct page *p=new_page();
 for(unsigned int i=0;i<n;i++)p->bytes[i]=(unsigned char)(64+i);
 s->info.frags[s->info.nr_frags++]=(skb_frag_t){p,0,n};s->len+=n;s->data_len+=n;
}
static void tag(struct sk_buff *s,struct tako_terminal_owner *o) { struct net n={o};tako_terminal_skb_set_owner(s,&n); }
static void faults_reset(void) {
 clone_calls=clone_fail=ext_calls=ext_fail=copy_calls=copy_fail=orphan_calls=orphan_fail=0;
 tx_errors=zcopy_calls=effects=0;first_effect_retained=false;effect_to=NULL;effect_from=NULL;
}
static int copy_packet(struct sk_buff *to,struct sk_buff *from,int n,int hlen,bool off) {
 effect_to=to;effect_from=from;return off?raw_off_zerocopy(to,from,n,hlen):skb_zerocopy(to,from,n,hlen);
}
static void balanced(struct tako_terminal_owner *o,unsigned int n) {
 CHECK(!headers_live && !blobs_live && !pages_live);
 for(unsigned int i=0;i<n;i++)CHECK(o[i].refs==1);
 faults_reset();
}
static void origins_case(unsigned int kind) {
 struct tako_terminal_owner o[6];for(unsigned int i=0;i<6;i++)o[i]=(struct tako_terminal_owner){1,0};
 struct sk_buff *to=new_packet(0,0),*from=new_packet(8,8),*shared=NULL;
 from->head_frag=1;add_frag(from,8);tag(from,&o[1]);if(kind!=4)tag(to,&o[0]);
 if(kind==1)tag(to,&o[1]);
 if(kind==2 || kind==5){shared=new_packet(0,0);__skb_ext_copy(shared,to);}
 if(kind==3){tag(to,&o[2]);tag(to,&o[3]);tag(to,&o[4]);}
 if(kind==7)tag(from,&o[2]);
 if(kind==8)o[1].poisoned=1;
 faults_reset();if(kind==4 || kind==5)ext_fail=1;if(kind==6)clone_fail=1;
 CHECK(copy_packet(to,from,12,0,false)==0 && to->len==12 && to->info.nr_frags==2);
 CHECK(from->len==16 && from->info.nr_frags==1);
 struct page *held=to->info.frags[0].page;
 faults_reset();free_packet(from); /* actual donor heap freed before receiver */
 CHECK(held->refs==1 && held->bytes[16]==1);
 if(kind==3 || kind==4 || kind==5 || kind==6)CHECK(o[1].poisoned);
 else {CHECK(has(to,&o[0]) && has(to,&o[1]) && o[1].refs==2);if(kind==7)CHECK(has(to,&o[2]));}
 if(shared){CHECK(!has(shared,&o[1]));free_packet(shared);}
 if(kind==8)CHECK(o[1].poisoned);
 free_packet(to);balanced(o,6);
}
static void payload_cases(void) {
 for(unsigned int kind=0;kind<5;kind++) {
  struct tako_terminal_owner o[2]={{1,0},{1,0}};
  unsigned int linear=kind==3?0:(kind==1?4:8);
  struct sk_buff *from=new_packet(linear,linear),*to=new_packet(0,kind==0?64:(kind==1?4:0));
  from->head_frag=kind!=1;tag(from,&o[1]);tag(to,&o[0]);
  if(kind!=4)add_frag(from,8);
  if(kind==2)add_frag(from,8);
  int n=kind==0?6:(kind==1?12:(kind==2?18:8));int hlen=kind==0?8:(kind==1?4:0);
  faults_reset();CHECK(copy_packet(to,from,n,hlen,false)==0);
  CHECK(first_effect_retained && to->len==(unsigned int)n && has(to,&o[1]) && has(to,&o[0]));
  if(kind==0)CHECK(to->data[0]==1 && to->data[5]==6 && !to->info.nr_frags && !orphan_calls);
  if(kind==1)CHECK(to->data[3]==4 && to->info.nr_frags==1 && to->info.frags[0].size==8);
  if(kind==2)CHECK(to->info.nr_frags==3 && to->info.frags[2].size==2);
  if(kind==3)CHECK(to->info.nr_frags==1 && to->info.frags[0].size==8);
  if(kind==4)CHECK(to->info.nr_frags==1 && !copy_calls);
  free_packet(from);CHECK(o[1].refs==2);free_packet(to);balanced(o,2);
 }
}
static void partial_errors(void) {
 for(unsigned int kind=0;kind<3;kind++) {
  struct tako_terminal_owner o[2]={{1,0},{1,0}};
  struct sk_buff *from=new_packet(8,8),*to=new_packet(0,kind?4:64);add_frag(from,8);
  tag(from,&o[1]);tag(to,&o[0]);faults_reset();if(kind==2)orphan_fail=1;else copy_fail=1;
  CHECK(copy_packet(to,from,kind?12:6,kind?4:8,false)==(kind==2?-ENOMEM:-EFAULT));
  CHECK(first_effect_retained && to->data[0]==1 && to->data[1]==2 && has(to,&o[1]));
  CHECK(to->len==(kind==0?6U:(kind==1?4U:12U)) && !to->info.nr_frags);
  CHECK(tx_errors==(kind==2?1U:0U) && !zcopy_calls);
  faults_reset();free_packet(from);CHECK(o[1].refs==2 && !o[1].poisoned);free_packet(to);balanced(o,2);
 }
}
static void zero_off_unowned(void) {
 struct tako_terminal_owner o[2]={{1,0},{1,0}};
 struct sk_buff *from=new_packet(8,8),*to=new_packet(0,64);tag(from,&o[1]);tag(to,&o[0]);
 faults_reset();CHECK(copy_packet(to,from,0,8,false)==0 && !to->len && !has(to,&o[1]));
 CHECK(!clone_calls && !ext_calls && !effects);free_packet(from);free_packet(to);balanced(o,2);
 for(unsigned int off=0;off<2;off++) {
  from=new_packet(8,8);to=new_packet(0,0);from->head_frag=1;add_frag(from,8);faults_reset();
  CHECK(copy_packet(to,from,12,0,off)==0 && to->len==12 && !ext_calls && !clone_calls);
  free_packet(from);free_packet(to);balanced(NULL,0);
 }
 /* Function-only CONFIG-off: real origin helpers stay enabled in this TU. */
 from=new_packet(8,8);to=new_packet(0,64);tag(from,&o[1]);tag(to,&o[0]);faults_reset();
 CHECK(copy_packet(to,from,6,8,true)==0 && !has(to,&o[1]) && !ext_calls && !clone_calls);
 free_packet(from);free_packet(to);balanced(o,2);
}
int main(int argc,char **argv) {
 origins_case(0);if(argc>1 && !strcmp(argv[1],"selected-only"))return 0;
 for(unsigned int i=1;i<9;i++)origins_case(i);
 payload_cases();partial_errors();zero_off_unowned();
 printf("PASS %u raw zerocopy origin checks; no kernel/native execution\n",checks);return 0;
}

/* Portable extraction: copy the lines between BEGIN/END below into recipe.py.
 * Run from this repo root: python3 recipe.py PRISTINE_V6_12 OUTPUT_DIR
 * Reads only pristine net/core/skbuff.c and include/linux/skbuff.h and the
 * existing repository overlays; exact unique hunk context, no offset fuzz.
 * Compile with the strict flags in SOURCE-PROOF and -IOUTPUT_DIR plus
 * -DZEROCOPY_FUNCTION='"OUTPUT_DIR/after-zerocopy.inc"'. Select before for RED.
 * Actual selected proof uses the independently saved formal21 aggregate;
 * every include generated by this repository-only recipe matches it exactly.
# BEGIN PORTABLE ZEROCOPY EXTRACTION
from pathlib import Path
import re, sys, hashlib
# Run from the Takoserver root: python3 recipe.py PRISTINE_V6_12 OUTPUT_DIR
# Only the two existing pristine files below are read; no kernel checkout/build.
U, G = map(Path, sys.argv[1:3])
G.mkdir(exist_ok=True)
S, H = 'net/core/skbuff.c', 'include/linux/skbuff.h'
current = {p: (U/p).read_text() for p in [S,H]}
assert hashlib.sha256((U/S).read_bytes()).hexdigest() == '71eaeef9c95eb6a36b2c826c91a470447a9b5ae4e2651757ae66cd98e9afc010'
def apply(text):
 for block in re.split(r'(?=^diff --git )', text, flags=re.M):
  if not block.startswith('diff --git '): continue
  lines=block.splitlines(True)
  header=re.fullmatch(r'diff --git a/([^\n ]+) b/([^\n ]+)\n', lines[0])
  assert header and header[1]==header[2]
  p=header[1]
  if p not in current: continue
  i=0
  while i<len(lines):
   h=re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@',lines[i])
   if not h: i+=1;continue
   before=[];after=[];i+=1
   while i<len(lines) and not lines[i].startswith('@@ '):
    line=lines[i];assert line[0] in ' +-'
    if line[0] in ' -':before.append(line[1:])
    if line[0] in ' +':after.append(line[1:])
    i+=1
   assert len(before)==int(h[2] or 1) and len(after)==int(h[4] or 1)
   old,new=''.join(before),''.join(after)
   assert current[p].count(old)==1,(p,h[0],current[p].count(old))
   current[p]=current[p].replace(old,new,1)
for name in ['', 'skb', 'netdev', 'descendant', 'setns', 'gro', 'nfqueue', 'payload', 'nfqueue-verdict', 'payload-bulk', 'nfqueue-batch', 'coalesce', 'payload-napi', 'cut-sync', 'hook-continuation', 'nfqueue-custody', 'skb-net-origin', 'release-sync', 'owner-join', 'segment-origin', 'shift-origin']:
 apply(Path("scripts/native/docker-container-terminal-kernel"+("-"+name if name else "")+"-v6.12.patch").read_text())
pattern = re.compile('(?m)^(?:(?:static|inline|_Noreturn|const|unsigned|signed|long|short|struct|enum)\\s+)*(?:[A-Za-z_]\\w*\\s*\\*?\\s+|[A-Za-z_]\\w*\\s*\\*\\s*)([A-Za-z_]\\w*)\\s*\\([^;{}]*\\)\\s*\\{')
def funcs(s):
    out = {}
    for m in pattern.finditer(s):
        i = m.end() - 1
        depth = 0
        state = 'code'
        while i < len(s):
            c = s[i]
            n = s[i + 1:i + 2]
            if state == 'code':
                if c == '/' and n == '*':
                    state = 'comment'
                    i += 1
                elif c == '/' and n == '/':
                    state = 'line'
                    i += 1
                elif c == '"':
                    state = 'string'
                elif c == "'":
                    state = 'char'
                elif c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if not depth:
                        out[m.group(1)] = s[m.start():i + 1].encode()
                        break
            elif state == 'comment' and c == '*' and (n == '/'):
                state = 'code'
                i += 1
            elif state == 'line' and c == '\n':
                state = 'code'
            elif state in ('string', 'char'):
                if c == '\\':
                    i += 1
                elif state == 'string' and c == '"' or (state == 'char' and c == "'"):
                    state = 'code'
            i += 1
    return out
before=funcs(current[S])['skb_zerocopy']
assert hashlib.sha256(before).hexdigest()=='bd5f9a4e130a77685e7332632b34f28b67a93442cdbef012964005fce4466b94'
apply(Path('scripts/native/docker-container-terminal-kernel-zerocopy-origin-v6.12.patch').read_text())
f=funcs(current[S]);h=current[H]
for n in ['__skb_ext_alloc','__skb_ext_put','skb_ext_maybe_cow','skb_ext_add','tako_skb_snapshot','tako_skb_restore','tako_terminal_skb_poison','tako_terminal_skb_copy','tako_terminal_skb_set_owner','tako_terminal_skb_merge','__kfree_skb']:
 (G/(n+'.inc')).write_bytes(f[n])
hf=funcs(h[h.index('static inline void skb_ext_put_final('):].split('#else\nstruct net;',1)[0])
(G/'ext-header.inc').write_bytes(b'\n'.join(hf[n] for n in ['skb_ext_put_final','skb_ext_put','__skb_ext_copy','skb_ext_copy','__skb_ext_exist','skb_ext_exist','skb_ext_find']))
(G/'ext-struct.inc').write_text(re.search(r'^struct skb_ext \{.*?^};\n',h,re.M|re.S).group(0))
(G/'shared.inc').write_bytes(funcs(h)['skb_shared'])
(G/'skb_len_add.inc').write_bytes(funcs(h)['skb_len_add'])
(G/'head-state.inc').write_bytes(b'\n'.join(f[n] for n in ['__skb_release_head_state','skb_release_head_state']))
(G/'before-zerocopy.inc').write_bytes(before)
(G/'after-zerocopy.inc').write_bytes(f['skb_zerocopy'])
# END PORTABLE ZEROCOPY EXTRACTION
*/
