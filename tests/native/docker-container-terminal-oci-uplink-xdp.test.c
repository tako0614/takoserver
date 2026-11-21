/* SPDX-License-Identifier: GPL-2.0-only */
/* Pure RTM_NEWLINK selector bytes. The official v6.12 rtnl_xdp_fill/report_one
 * bodies run over raw program-id data and a bounded nla byte builder. They do
 * not attach/query BPF or create a kernel/network object. Actual production
 * attr/text/u32/link/XDP selector bodies are extracted unchanged into the
 * pinned packet. This is not a native dump/currentness or no-race proof. */
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <linux/if.h>
#include <linux/if_arp.h>
#include <linux/if_link.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#ifndef XDP_SELECTOR
#error "Extract the exact original or revised selector into the packet"
#endif
#ifndef XDP_PRODUCER
#error "Pin the official Linux v6.12 producer-body excerpt"
#endif
typedef uint8_t u8;
typedef uint32_t u32;
static unsigned long checks;
#define CHECK(x) do { assert(x);checks++; } while (0)
_Static_assert(sizeof(struct nlattr)==sizeof(struct rtattr),"UAPI attr layout");
_Static_assert(XDP_ATTACHED_NONE==0 && XDP_ATTACHED_DRV==1 && XDP_ATTACHED_SKB==2 && XDP_ATTACHED_HW==3 && XDP_ATTACHED_MULTI==4,"fixed v6.12 mode enum");
struct sk_buff { _Alignas(4) unsigned char bytes[128];size_t used; };
struct net_device { uint32_t skb,drv,hw; };
static int nla_put_raw(struct sk_buff *skb,unsigned int type,const void *bytes,size_t size) {
 size_t width=NLA_ALIGN(sizeof(struct nlattr)+size);if(width>sizeof(skb->bytes)-skb->used)return -1;
 struct nlattr attr={.nla_len=(uint16_t)(sizeof(attr)+size),.nla_type=(uint16_t)type};
 memcpy(skb->bytes+skb->used,&attr,sizeof(attr));
 if(size)memcpy(skb->bytes+skb->used+sizeof(attr),bytes,size);
 memset(skb->bytes+skb->used+sizeof(attr)+size,0,width-sizeof(attr)-size);skb->used+=width;return 0;
}
static struct nlattr *nla_nest_start_noflag(struct sk_buff *skb,unsigned int type) {
 size_t at=skb->used;if(nla_put_raw(skb,type,NULL,0)<0)return NULL;
 return (struct nlattr *)(void *)(skb->bytes+at);
}
static int nla_put_u32(struct sk_buff *skb,unsigned int type,uint32_t value) { return nla_put_raw(skb,type,&value,sizeof(value)); }
static int nla_put_u8(struct sk_buff *skb,unsigned int type,uint8_t value) { return nla_put_raw(skb,type,&value,sizeof(value)); }
static void nla_nest_end(struct sk_buff *skb,struct nlattr *nest) {
 size_t at=(unsigned char *)(void *)nest-skb->bytes;struct nlattr attr;memcpy(&attr,nest,sizeof(attr));
 attr.nla_len=(uint16_t)(skb->used-at);memcpy(nest,&attr,sizeof(attr));
}
static void nla_nest_cancel(struct sk_buff *skb,struct nlattr *nest) { skb->used=(unsigned char *)(void *)nest-skb->bytes; }
static uint32_t rtnl_xdp_prog_skb(struct net_device *dev) { return dev->skb; }
static uint32_t rtnl_xdp_prog_drv(struct net_device *dev) { return dev->drv; }
static uint32_t rtnl_xdp_prog_hw(struct net_device *dev) { return dev->hw; }
#include XDP_PRODUCER
#include XDP_SELECTOR
#include XDP_COMPAT
struct raw_link { _Alignas(4) unsigned char bytes[512];size_t used; };
static void add(struct raw_link *link,unsigned int type,const void *bytes,size_t size) {
 size_t width=RTA_ALIGN(sizeof(struct rtattr)+size);CHECK(width<=sizeof(link->bytes)-link->used);
 struct rtattr attr={.rta_len=(uint16_t)(sizeof(attr)+size),.rta_type=(uint16_t)type};
 memcpy(link->bytes+link->used,&attr,sizeof(attr));if(size)memcpy(link->bytes+link->used+sizeof(attr),bytes,size);
 memset(link->bytes+link->used+sizeof(attr)+size,0,width-sizeof(attr)-size);link->used+=width;
}
static struct sk_buff official_xdp(uint32_t skb,uint32_t drv,uint32_t hw) {
 struct sk_buff wire={0};struct net_device dev={.skb=skb,.drv=drv,.hw=hw};CHECK(!rtnl_xdp_fill(&wire,&dev));return wire;
}
static struct raw_link frame(const struct sk_buff *xdp,unsigned int role) {
 struct raw_link link={0};struct ifinfomsg info={.ifi_family=AF_UNSPEC,.ifi_type=ARPHRD_ETHER,.ifi_index=7,.ifi_flags=IFF_UP};
 memcpy(link.bytes,&info,sizeof(info));link.used=NLMSG_ALIGN(sizeof(info));
 const unsigned char mac[6]={2,17,34,51,68,85};add(&link,IFLA_IFNAME,"uplink0",8);add(&link,IFLA_ADDRESS,mac,6);
 if(!role){struct raw_link kind={0};uint32_t peer=8;add(&kind,IFLA_INFO_KIND,"veth",5);add(&link,IFLA_LINKINFO,kind.bytes,kind.used);add(&link,IFLA_LINK,&peer,sizeof(peer));}
 if(xdp){CHECK(xdp->used<=sizeof(link.bytes)-link.used);memcpy(link.bytes+link.used,xdp->bytes,xdp->used);link.used+=xdp->used;}
 return link;
}
static int select_link(const struct sk_buff *xdp,unsigned int role) {
 struct raw_link link=frame(xdp,role);unsigned char mac[6];uint32_t peer=0;
 return oci_uplink_link(link.bytes,link.used,"uplink0",7,mac,&peer,(int)role);
}
static void refuse(const struct sk_buff *wire) { CHECK(select_link(wire,0)<0);CHECK(select_link(wire,1)<0); }
static void set_outer(struct sk_buff *wire,uint16_t type,uint16_t length) {
 struct nlattr h;memcpy(&h,wire->bytes,sizeof(h));h.nla_type=type;h.nla_len=length;memcpy(wire->bytes,&h,sizeof(h));
}
static void set_child(struct sk_buff *wire,uint16_t type,uint16_t length) {
 struct nlattr h;memcpy(&h,wire->bytes+sizeof(h),sizeof(h));h.nla_type=type;h.nla_len=length;memcpy(wire->bytes+sizeof(h),&h,sizeof(h));
}
static void add_child(struct sk_buff *wire,unsigned int type,const void *bytes,size_t size) {
 CHECK(!nla_put_raw(wire,type,bytes,size));nla_nest_end(wire,(struct nlattr *)(void *)wire->bytes);
}
static void counterexample(void) {
 struct sk_buff active=official_xdp(17,0,0),unknown=official_xdp(0,0,0),malformed=official_xdp(0,0,0);
 unknown.bytes[2*sizeof(struct nlattr)]=255;set_child(&malformed,IFLA_XDP_ATTACHED,2);
 int a=select_link(&active,1),u=select_link(&unknown,1),m=select_link(&malformed,1);
 printf("actual original selector active=%d unknown=%d malformed=%d (all must refuse)\n",a,u,m);fflush(stdout);
 CHECK(a<0 && u<0 && m<0);
}
static void compat_cases(const struct sk_buff *none) {
 void (*const builders[])(struct oci_uplink_request *,const char *,int,unsigned int,const unsigned char *,uint32_t)={
  raw_compat_uplink,raw_compat_admission,raw_compat_policy,raw_compat_runtime_current
 };
 const unsigned char mac[6]={2,17,34,51,68,85};
 for(unsigned int i=0;i<4;i++){
  struct oci_uplink_request reply;builders[i](&reply,"uplink0",7,IFF_UP,mac,8);
  unsigned char selected[6];uint32_t peer=0;size_t size=reply.h.nlmsg_len-NLMSG_HDRLEN;
  CHECK(oci_uplink_link(reply.body,size,"uplink0",7,selected,&peer,1)==7);
  CHECK(oci_uplink_link(reply.body,size,"uplink0",7,selected,&peer,0)==7 && peer==8);
  struct oci_uplink_attrs a;CHECK(!oci_uplink_attrs(reply.body+NLMSG_ALIGN(sizeof(struct ifinfomsg)),size-NLMSG_ALIGN(sizeof(struct ifinfomsg)),&a));
  CHECK(a.p[IFLA_XDP] && a.size[IFLA_XDP]==8);
  CHECK(!memcmp(a.p[IFLA_XDP]-sizeof(struct rtattr),none->bytes,none->used));
 }
}
int main(int argc,char **argv) {
 if(argc==2 && !strcmp(argv[1],"counterexample")){counterexample();return 0;}
 struct sk_buff none=official_xdp(0,0,0);CHECK(none.used==12);
 CHECK(select_link(&none,0)==7 && select_link(&none,1)==7);
 compat_cases(&none);
 /* Missing nested state is not the genuine NONE reply emitted by v6.12. */
 CHECK(select_link(NULL,0)<0 && select_link(NULL,1)<0);
 for(unsigned int bits=1;bits<8;bits++){
  struct sk_buff wire=official_xdp((bits&1)?17:0,(bits&2)?23:0,(bits&4)?29:0);refuse(&wire);
 }
 for(unsigned int mode=1;mode<=255;mode++){
  struct sk_buff wire=none;wire.bytes[2*sizeof(struct nlattr)]=(uint8_t)mode;refuse(&wire);
 }
 for(unsigned int id=0;id<128;id++)if(id!=IFLA_XDP_ATTACHED){
  struct sk_buff wire=none;set_child(&wire,(uint16_t)id,5);refuse(&wire);
 }
 for(unsigned int flag=0;flag<2;flag++){
  uint16_t bit=flag?NLA_F_NET_BYTEORDER:NLA_F_NESTED;
  struct sk_buff wire=none;set_child(&wire,(uint16_t)(IFLA_XDP_ATTACHED|bit),5);refuse(&wire);
  wire=none;set_outer(&wire,(uint16_t)(IFLA_XDP|bit),12);refuse(&wire);
 }
 for(unsigned int length=0;length<14;length++)if(length!=5){
  struct sk_buff wire=none;set_child(&wire,IFLA_XDP_ATTACHED,(uint16_t)length);refuse(&wire);
 }
 for(unsigned int type=IFLA_XDP_FD;type<=IFLA_XDP_MAX;type++){
  uint32_t value=type==IFLA_XDP_ATTACHED?0:61;struct sk_buff wire=none;add_child(&wire,type,&value,sizeof(value));refuse(&wire);
 }
 for(unsigned int length=0;length<12;length++){
  struct sk_buff wire=none;wire.used=length;refuse(&wire);
 }
 struct sk_buff wire=none;set_outer(&wire,IFLA_XDP,4);wire.used=4;refuse(&wire);
 wire=none;set_outer(&wire,IFLA_XDP,8);wire.used=8;refuse(&wire);
 wire=none;set_outer(&wire,IFLA_XDP,11);refuse(&wire);
 wire=none;wire.bytes[9]=wire.bytes[10]=wire.bytes[11]=0xa5;
 CHECK(select_link(&wire,0)==7 && select_link(&wire,1)==7); /* Padding is not state. */
 printf("PASS %lu checks; actual v6.12 XDP producer and actual byte selectors only\n",checks);return 0;
}
