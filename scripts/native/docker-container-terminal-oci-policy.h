#ifndef DOCKER_CONTAINER_TERMINAL_OCI_POLICY_H
#define DOCKER_CONTAINER_TERMINAL_OCI_POLICY_H
/* Private original-owner implementation. Service/policy files are data only.
 * No caller target, descriptor, PID, mark, script or readiness is accepted.
 * The existing birth DROP and kernel CLOSED gate remain intact. */
#include <stdarg.h>
#include <linux/neighbour.h>
#define OCI_POLICY_FILE ".tako-oci-service.json"
#define OCI_POLICY_TABLE "tako_terminal_service"
#define OCI_POLICY_TEXT_MAX 524288u
#define OCI_POLICY_JSON_MAX 1048576u
#define OCI_POLICY_NODES 65536u
struct oci_policy_service { unsigned int port;
 char health[2049];
 };
struct oci_policy_limits { uint64_t generation, connections, bytes;
 int internet;
 };
struct oci_policy_network { unsigned char address[16];
 unsigned int family, prefix;
 };
struct oci_policy_runtime {
  int pidfd,incoming,outgoing;
  pid_t pid;
  unsigned int attempted,wait_attempted,joined,ok,killed,close_unknown;
};
struct oci_policy_owner {
  struct oci_policy_runtime *runtime;
  struct tns_oci_owner *original;
  struct oci_uplink_owner *uplink;
  struct oci_policy_service service;
  struct oci_policy_limits limits;
  int file, selected, close_unknown;
   struct stat file_identity;
  char file_bytes[16385];
   size_t file_size;
  unsigned int attempt, neighbors[2], verified;
  int pidfd[3], incoming[3], outgoing[3];
   pid_t pid[3];
  unsigned int joined[3], ok[3], killed[3];
  struct oci_policy_network denied[1280];
   size_t denied_count;
  char script[OCI_POLICY_TEXT_MAX], expected[OCI_POLICY_TEXT_MAX];
  size_t script_size, expected_size;
   unsigned int rules;
  uint64_t observed_packets[8], observed_bytes[8], observed_quota;
};
static int oci_policy_hex(unsigned int ch) {
  if(ch>='0' && ch<='9')return (int)(ch-'0');
  if(ch>='a' && ch<='f')return (int)(ch-'a'+10);
  if(ch>='A' && ch<='F')return (int)(ch-'A'+10);
  return -1;
}
/* Same closed path grammar; repeated decoding rejects intermediary traversal,
 * encoded separators, malformed UTF8 and controls. It grants no health fact. */
static int oci_policy_health(const char *path) {
  size_t size = strlen(path);
   if(!size || size>2048 || path[0]!='/' || path[1]=='/')return -1;
  for(size_t i=0;i<size;i++){
    unsigned int c=(unsigned char)path[i];
    if(c=='%'){if(size-i<3 || oci_policy_hex((unsigned char)path[i+1])<0 || oci_policy_hex((unsigned char)path[i+2])<0)return -1;
    i+=2;
    }
    else if(!((c>='a' && c<='z') || (c>='A' && c<='Z') || (c>='0' && c<='9') || strchr("/._~!$&'()*+,;=:@-",(int)c)))return -1;
  }
  char current[2049], next[2049];
  memcpy(current,path,size+1);
  for(size_t depth=0;depth<=size;depth++){
    size_t n=strlen(current), written=0;
    int changed=0,invalid_percent=0;
    if(tns_oci_utf8((struct tns_oci_text){(unsigned char*)current,n})<0)return -1;
    for(size_t i=0;i<n;i++){
      unsigned int c=(unsigned char)current[i];
      if(c<=32 || c==127 || c=='\\' || c=='?' || c=='#')return -1;
      if(c=='.' && (i==0 || current[i-1]=='/') && current[i+1]=='.' && (i+2==n || current[i+2]=='/'))return -1;
      if(c=='%'){int a=n-i>=3?oci_policy_hex((unsigned char)current[i+1]):-1,b=n-i>=3?oci_policy_hex((unsigned char)current[i+2]):-1;
        if(a>=0 && b>=0){c=(unsigned int)(a*16+b);
        if(!c || c=='/' || c=='\\')return -1;
        i+=2;
        changed=1;
        }else invalid_percent=1;
      }
      next[written++]=(char)c;
    }
    next[written]=0;
    if(!changed)return 0;
    if(invalid_percent)return -1;
    memcpy(current,next,written+1);
  }
  return -1;
}
static int oci_policy_service(const char *bytes,size_t size,const char *artifact,size_t artifact_size,struct oci_policy_service *out){
  if(!bytes || !artifact || !out || !size || size>16384)return -1;
  struct oci_egress_cursor c={(const unsigned char*)bytes,size,0};
  uint64_t port;
  struct oci_policy_service service;
  if(oci_egress_take(&c,"{\"kind\":\"linux-oci-owned-service@1\",\"artifact\":")<0 || artifact_size>c.size-c.at || memcmp(c.p+c.at,artifact,artifact_size))return -1;
  c.at+=artifact_size;
  if(oci_egress_take(&c,",\"service\":{\"httpPort\":")<0 || oci_egress_number(&c,&port)<0 || !port || port>65535 ||
      oci_egress_take(&c,",\"healthPath\":")<0 || oci_egress_string(&c,service.health,sizeof(service.health))<0 ||
      oci_policy_health(service.health)<0 || oci_egress_take(&c,"}}")<0 || c.at!=c.size)return -1;
  service.port=(unsigned int)port;
  *out=service;
  return 0;
}
static int oci_policy_limits(struct oci_policy_owner *p){
  struct tns_oci_owner *o=p->original;
  struct oci_egress_cursor c={(const unsigned char*)o->egress_bytes,o->egress_size,0};
  char text[1025];
  if(oci_egress_take(&c,"{\"kind\":\"linux-oci-owned-egress@1\",\"artifact\":")<0 || o->receipt_size>c.size-c.at || memcmp(c.p+c.at,o->receipt_bytes,o->receipt_size))return -1;
  c.at+=o->receipt_size;
  if(oci_egress_take(&c,",\"policy\":{\"tenantRef\":")<0 || oci_egress_string(&c,text,sizeof(text))<0 || !*text ||
      oci_egress_take(&c,",\"generation\":")<0 || oci_egress_number(&c,&p->limits.generation)<0 || !p->limits.generation || p->limits.generation>UINT64_C(9007199254740991) ||
      oci_egress_take(&c,",\"policyDigest\":")<0 || oci_egress_string(&c,text,sizeof(text))<0 || tns_oci_digest(text)<0 ||
      oci_egress_take(&c,",\"outboundInternet\":")<0)return -1;
  if(oci_egress_take(&c,"true")==0)p->limits.internet=1;
  else if(oci_egress_take(&c,"false")==0)p->limits.internet=0;
  else return -1;
  return oci_egress_take(&c,"},\"limits\":{\"maxConnections\":")<0 || oci_egress_number(&c,&p->limits.connections)<0 || p->limits.connections>65535 ||
    oci_egress_take(&c,",\"packetLimitBytes\":")<0 || oci_egress_number(&c,&p->limits.bytes)<0 || p->limits.bytes>UINT64_C(9007199254740991) ||
    oci_egress_take(&c,"}}")<0 || c.at!=c.size ? -1:0;
}
static int oci_policy_file_current(struct oci_policy_owner *p){
  if(!p || !p->selected || p->file<0)return -1;
  struct stat held,named;
  if(fstat(p->file,&held)<0 || fstatat(p->original->root,OCI_POLICY_FILE,&named,AT_SYMLINK_NOFOLLOW)<0 || !S_ISREG(held.st_mode) || held.st_uid ||
      (held.st_mode&07777)!=0600 || held.st_nlink!=1 || !oci_egress_same_stat(&held,&p->file_identity) || !oci_same(&held,&named))return -1;
  char bytes[4096];
  size_t at=0;
  while(at<p->file_size){size_t n=p->file_size-at;
  if(n>sizeof(bytes))n=sizeof(bytes);
    if(pread(p->file,bytes,n,(off_t)at)!=(ssize_t)n || memcmp(bytes,p->file_bytes+at,n))return -1;
    at+=n;
    }
  return pread(p->file,bytes,1,(off_t)at)==0 && fstat(p->file,&held)==0 && oci_egress_same_stat(&held,&p->file_identity)?0:-1;
}
static int oci_policy_original(struct oci_policy_owner *p){
  if(!p || !p->original || !p->uplink || p->uplink->original!=p->original || p->close_unknown ||
      !p->uplink->configured || !p->uplink->pair_known || p->uplink->cleaning || oci_policy_file_current(p)<0 ||
      oci_uplink_original(p->uplink)<0 || oci_not_canceled()<0){if(!errno)errno=ESTALE;
      return -1;
      }return 0;
}
static int oci_policy_current(struct tns_oci_owner *o){return o->policy && o->policy->selected?oci_policy_file_current(o->policy):0;
}
static int oci_policy_select(struct tns_oci_owner *o,struct oci_policy_owner **slot){
  if(!o || !slot || *slot){errno=EALREADY;
  return -1;
  }struct oci_policy_owner *p=calloc(1,sizeof(*p));
  if(!p)return -1;
  int fd=openat(o->root,OCI_POLICY_FILE,O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);
  if(fd<0){int saved=errno;
  free(p);
  errno=saved;
  return saved==ENOENT?0:-1;
  }
  *slot=p;
  p->original=o;
  p->uplink=o->uplink;
  p->file=fd;
  for(unsigned int i=0;i<3;i++)p->pidfd[i]=p->incoming[i]=p->outgoing[i]=-1;
  if(!o->egress_selected || !o->uplink || o->controller_pid!=getpid() || oci_inputs(o)<0 || fstat(fd,&p->file_identity)<0 || !S_ISREG(p->file_identity.st_mode) ||
      p->file_identity.st_uid || (p->file_identity.st_mode&07777)!=0600 || p->file_identity.st_nlink!=1 || p->file_identity.st_size<1 || p->file_identity.st_size>16384){errno=EPROTO;
      return -1;
      }
  p->file_size=(size_t)p->file_identity.st_size;
  if(pread(fd,p->file_bytes,p->file_size,0)!=(ssize_t)p->file_size || oci_policy_service(p->file_bytes,p->file_size,o->receipt_bytes,o->receipt_size,&p->service)<0 ||
      oci_policy_limits(p)<0)return -1;
  p->selected=1;
  return oci_policy_file_current(p);
}
static int oci_policy_network(struct oci_policy_owner *p,unsigned int family,const unsigned char *address,unsigned int prefix){
  size_t width=family==AF_INET?4u:family==AF_INET6?16u:0;
  if(!width || !prefix || prefix>width*8)return -1;
  struct oci_policy_network n={.family=family,.prefix=prefix};
  memcpy(n.address,address,width);
  for(unsigned int bit=prefix;bit<width*8;bit++)n.address[bit/8]&=(unsigned char)~(1u<<(7-bit%8));
  for(size_t i=0;i<p->denied_count;i++)if(p->denied[i].family==family && p->denied[i].prefix==prefix && !memcmp(p->denied[i].address,n.address,width))return 0;
  if(p->denied_count==1280)return -1;
  p->denied[p->denied_count++]=n;
  return 0;
}
/* Complete original Host address and connected/local prefix observations, not
 * tenant-supplied restrictions or Docker bridge aliases. Bounds refuse loss. */
static int oci_policy_inventory(struct oci_policy_owner *p){
  struct oci_uplink_owner *u=p->uplink;
  struct oci_uplink_dump *d=malloc(sizeof(*d));
  if(!d)return -1;
  int result=-1;
  if(oci_policy_original(p)<0 || oci_uplink_preflight(u)<0 || oci_uplink_pair(u)<0 || oci_uplink_dump_side(u,0,RTM_GETADDR,d)<0)goto done;
  p->denied_count=0;
  size_t at=0;
  unsigned int count=0;
  while(at<d->used){struct nlmsghdr n;
  memcpy(&n,d->bytes+at,sizeof(n));
  const unsigned char *body=d->bytes+at+NLMSG_HDRLEN;
  struct ifaddrmsg h;
  memcpy(&h,body,sizeof(h));
  struct oci_uplink_attrs a;
    size_t width=h.ifa_family==AF_INET?4u:h.ifa_family==AF_INET6?16u:0;
    if(!width || ++count>1024 || !h.ifa_index || oci_uplink_attrs(body+NLMSG_ALIGN(sizeof(h)),n.nlmsg_len-NLMSG_LENGTH(sizeof(h)),&a)<0 ||
        !a.p[IFA_ADDRESS] || a.size[IFA_ADDRESS]!=width || (a.p[IFA_LOCAL] && (a.size[IFA_LOCAL]!=width || memcmp(a.p[IFA_LOCAL],a.p[IFA_ADDRESS],width))) ||
        oci_policy_network(p,h.ifa_family,a.p[IFA_ADDRESS],(unsigned int)(width*8))<0)goto done;
    at+=NLMSG_ALIGN((size_t)n.nlmsg_len);
  }
  if(!count || oci_uplink_dump_side(u,0,RTM_GETROUTE,d)<0)goto done;
  at=0;
  count=0;
  while(at<d->used){struct nlmsghdr n;
  memcpy(&n,d->bytes+at,sizeof(n));
  const unsigned char *body=d->bytes+at+NLMSG_HDRLEN;
  struct rtmsg h;
  memcpy(&h,body,sizeof(h));
  struct oci_uplink_attrs a;
    size_t width=h.rtm_family==AF_INET?4u:h.rtm_family==AF_INET6?16u:0;
    if(!width || oci_uplink_attrs(body+NLMSG_ALIGN(sizeof(h)),n.nlmsg_len-NLMSG_LENGTH(sizeof(h)),&a)<0)goto done;
    if(h.rtm_scope==RT_SCOPE_LINK || h.rtm_scope==RT_SCOPE_HOST){if(++count>256 || !h.rtm_dst_len || !a.p[RTA_DST] || a.size[RTA_DST]!=width ||
        oci_policy_network(p,h.rtm_family,a.p[RTA_DST],h.rtm_dst_len)<0)goto done;
        }
    at+=NLMSG_ALIGN((size_t)n.nlmsg_len);
  }
  result=oci_policy_original(p);
done:free(d);
if(result<0 && !errno)errno=EPROTO;
return result;
}
/* Permanent neighbors derive solely from this original pair. They avoid
 * guessing link-local/NDP exceptions; veth deletion owns their eventual removal. */
static int oci_policy_neighbor(struct oci_policy_owner *p,int guest){
  struct oci_uplink_owner *u=p->uplink;
  if((guest!=0 && guest!=1) || oci_policy_original(p)<0 || !u->lock_held || tns_oci_once(&p->neighbors[guest])<0)return -1;
  for(unsigned int i=0;i<2;i++){
    struct ndmsg h={.ndm_family=(unsigned char)(i?AF_INET6:AF_INET),.ndm_ifindex=(int)(guest?u->guest_index:u->host_index),.ndm_state=NUD_PERMANENT,.ndm_type=RTN_UNICAST};
    const void *ip=i?(const void*)(guest?u->expected.host6:u->expected.guest6):(const void*)(guest?u->expected.host4:u->expected.guest4);
    struct oci_uplink_request r;
    oci_uplink_request(&r,RTM_NEWNEIGH,NLM_F_CREATE|NLM_F_EXCL,&h,sizeof(h));
    if(oci_uplink_attr(&r,NDA_DST,ip,i?16u:4u)<0 || oci_uplink_attr(&r,NDA_LLADDR,guest?u->host_mac:u->guest_mac,6)<0 || oci_uplink_mutate(u,guest,&r)<0)return -1;
  }
  return oci_policy_original(p);
}
static int oci_policy_neighbor_read(struct oci_policy_owner *p,int guest,int family){
  struct oci_uplink_owner *u=p->uplink;
  if(oci_policy_original(p)<0 || u->sequence==UINT32_MAX)return -1;
  struct{struct nlmsghdr n;
  struct ndmsg h;
  } request={.n={.nlmsg_len=NLMSG_LENGTH(sizeof(struct ndmsg)),.nlmsg_type=RTM_GETNEIGH,.nlmsg_flags=NLM_F_REQUEST|NLM_F_DUMP,.nlmsg_seq=++u->sequence},.h={.ndm_family=(unsigned char)family}};
  int fd=guest?u->guest:u->host;
  uint32_t port=guest?u->guest_port:u->host_port;
  struct sockaddr_nl kernel={.nl_family=AF_NETLINK};
  struct iovec iov={&request,sizeof(request)};
  struct msghdr message={.msg_name=&kernel,.msg_namelen=sizeof(kernel),.msg_iov=&iov,.msg_iovlen=1};
  int64_t now=oci_now();
  if(now<0)return -1;
  int64_t deadline=u->read_scope ? u->read_scope->deadline : now+2500;
  if(u->read_scope && (oci_egress_left(deadline)<0 || oci_not_canceled()<0))return -1;
  if(sendmsg(fd,&message,MSG_NOSIGNAL)!=(ssize_t)sizeof(request))goto fail;
  unsigned int found=0,done=0,records=0;
  size_t total=0;
  while(!done){int left=oci_egress_left(deadline);
  struct pollfd pollfd={.fd=fd,.events=POLLIN};
  if(left<0 || oci_not_canceled()<0 || poll(&pollfd,1,left)!=1 || pollfd.revents!=POLLIN)goto fail;
    union{struct nlmsghdr align;
    unsigned char bytes[OCI_UPLINK_PACKET_MAX];
    } packet;
    struct sockaddr_nl source;
    memset(&source,0,sizeof(source));
    struct iovec received={packet.bytes,sizeof(packet.bytes)};
    struct msghdr actual={.msg_name=&source,.msg_namelen=sizeof(source),.msg_iov=&received,.msg_iovlen=1};
    ssize_t n=recvmsg(fd,&actual,MSG_DONTWAIT);
    if(n<=0 || actual.msg_flags || actual.msg_controllen || actual.msg_namelen!=sizeof(source) || source.nl_family!=AF_NETLINK || source.nl_pid || source.nl_groups || (size_t)n>OCI_UPLINK_DUMP_MAX-total)goto fail;
    total+=(size_t)n;
    size_t at=0;
    while(at<(size_t)n){struct nlmsghdr h;
    if((size_t)n-at<sizeof(h))goto fail;
    memcpy(&h,packet.bytes+at,sizeof(h));
      if(h.nlmsg_len<sizeof(h) || h.nlmsg_len>(size_t)n-at || NLMSG_ALIGN((size_t)h.nlmsg_len)>(size_t)n-at || h.nlmsg_seq!=request.n.nlmsg_seq || h.nlmsg_pid!=port || h.nlmsg_flags!=NLM_F_MULTI)goto fail;
      if(h.nlmsg_type==NLMSG_DONE){int error;
      if(h.nlmsg_len!=NLMSG_LENGTH(sizeof(error)) || at+NLMSG_ALIGN((size_t)h.nlmsg_len)!=(size_t)n)goto fail;
      memcpy(&error,packet.bytes+at+NLMSG_HDRLEN,4);
      if(error)goto fail;
      done=1;
      }
      else{struct ndmsg a;
      struct oci_uplink_attrs attrs;
      if(h.nlmsg_type!=RTM_NEWNEIGH || h.nlmsg_len<NLMSG_LENGTH(sizeof(a)) || ++records>4096)goto fail;
        memcpy(&a,packet.bytes+at+NLMSG_HDRLEN,sizeof(a));
        if(a.ndm_family!=family || a.ndm_ifindex<=0 ||
          oci_uplink_attrs(packet.bytes+at+NLMSG_HDRLEN+NLMSG_ALIGN(sizeof(a)),h.nlmsg_len-NLMSG_LENGTH(sizeof(a)),&attrs)<0)goto fail;
        if((uint32_t)a.ndm_ifindex==(guest?u->guest_index:u->host_index)){
          const void *ip=family==AF_INET?(const void*)(guest?u->expected.host4:u->expected.guest4):(const void*)(guest?u->expected.host6:u->expected.guest6);
          size_t width=family==AF_INET?4u:16u;
          const unsigned char *address=attrs.p[NDA_DST],*link_address=attrs.p[NDA_LLADDR];
          if(a.ndm_flags || !address || attrs.size[NDA_DST]!=width ||
              !link_address || attrs.size[NDA_LLADDR]!=6)goto fail;
          for(unsigned int k=1;k<128;k++)if(attrs.p[k] && k!=NDA_DST && k!=NDA_LLADDR && k!=NDA_CACHEINFO && k!=NDA_PROBES)goto fail;
          if((attrs.p[NDA_CACHEINFO] && attrs.size[NDA_CACHEINFO]!=sizeof(struct nda_cacheinfo)) || (attrs.p[NDA_PROBES] && attrs.size[NDA_PROBES]!=4))goto fail;
          /* Linux derives these IPv6 multicast cache entries on Ethernet.
           * Only the exact permanent unicast peer counts as a peer observation. */
          int multicast_cache=family==AF_INET6 && a.ndm_type==RTN_MULTICAST &&
              a.ndm_state==NUD_NOARP && address[0]==0xff &&
              link_address[0]==0x33 && link_address[1]==0x33 &&
              !memcmp(link_address+2,address+12,4);
          if(!multicast_cache && (++found!=1 || a.ndm_state!=NUD_PERMANENT || a.ndm_type!=RTN_UNICAST ||
              memcmp(address,ip,width) || memcmp(link_address,guest?u->host_mac:u->guest_mac,6)))goto fail;
        }
      }
      at+=NLMSG_ALIGN((size_t)h.nlmsg_len);
    }
  }
  if(found!=1 || oci_policy_original(p)<0)goto fail;
  return 0;
fail:u->broken=1;
if(!errno)errno=EPROTO;
return -1;
}
/* Closed bounded JSON tree used only for structural nft readback. Exact u64
 * numbers avoid rounding dynamic counters into an invented zero. */
struct oci_policy_node{unsigned int kind,first,next;
size_t key,key_size,text,text_size;
uint64_t number;
int negative;
};
struct oci_policy_tree{struct oci_policy_node *nodes;
unsigned int count;
char *strings;
size_t string_size;
struct oci_egress_cursor cursor;
};
enum{OP_OBJECT=1,OP_ARRAY,OP_STRING,OP_NUMBER,OP_TRUE,OP_FALSE,OP_NULL};
static int oci_policy_json_string(struct oci_policy_tree *t,size_t *offset,size_t *size){
  char value[2049];
  if(oci_egress_string(&t->cursor,value,sizeof(value))<0)return -1;
  size_t n=strlen(value);
  if(n+1>OCI_POLICY_JSON_MAX-t->string_size)return -1;
  *offset=t->string_size;
  *size=n;
  memcpy(t->strings+t->string_size,value,n+1);
  t->string_size+=n+1;
  return 0;
}
static unsigned int oci_policy_json_value(struct oci_policy_tree *t,unsigned int depth){
  if(depth>32 || t->count==OCI_POLICY_NODES)return 0;
  oci_egress_space(&t->cursor);
  if(t->cursor.at==t->cursor.size)return 0;
  unsigned int index=++t->count;
  struct oci_policy_node *n=&t->nodes[index];
  unsigned int ch=t->cursor.p[t->cursor.at];
  if(ch=='{' || ch=='['){n->kind=ch=='{'?OP_OBJECT:OP_ARRAY;
  t->cursor.at++;
  oci_egress_space(&t->cursor);
  char close=ch=='{'?'}':']';
    if(t->cursor.at<t->cursor.size && t->cursor.p[t->cursor.at]==(unsigned char)close){t->cursor.at++;
    return index;
    }
    unsigned int last=0;
    for(;;){size_t key=0,key_size=0;
    if(n->kind==OP_OBJECT){if(oci_policy_json_string(t,&key,&key_size)<0 || key_size>64 || oci_egress_token(&t->cursor,":")<0)return 0;
        for(unsigned int k=n->first;k;k=t->nodes[k].next)if(t->nodes[k].key_size==key_size && !memcmp(t->strings+t->nodes[k].key,t->strings+key,key_size))return 0;
        }
      unsigned int child=oci_policy_json_value(t,depth+1);
      if(!child)return 0;
      t->nodes[child].key=key;
      t->nodes[child].key_size=key_size;
      if(last)t->nodes[last].next=child;
      else n->first=child;
      last=child;
      oci_egress_space(&t->cursor);
      if(t->cursor.at==t->cursor.size)return 0;
      unsigned int next=t->cursor.p[t->cursor.at++];
      if(next==(unsigned char)close)return index;
      if(next!=',')return 0;
      oci_egress_space(&t->cursor);
    }
  }
  if(ch=='"'){n->kind=OP_STRING;
  return oci_policy_json_string(t,&n->text,&n->text_size)==0?index:0;
  }
  if(ch=='t'){n->kind=OP_TRUE;
  return oci_egress_take(&t->cursor,"true")==0?index:0;
  }
  if(ch=='f'){n->kind=OP_FALSE;
  return oci_egress_take(&t->cursor,"false")==0?index:0;
  }
  if(ch=='n'){n->kind=OP_NULL;
  return oci_egress_take(&t->cursor,"null")==0?index:0;
  }
  n->kind=OP_NUMBER;
  if(ch=='-'){n->negative=1;
  t->cursor.at++;
  }return oci_egress_number(&t->cursor,&n->number)==0 && !(n->negative && !n->number)?index:0;
}
static int oci_policy_tree(struct oci_policy_tree *t,const char *bytes,size_t size){
  memset(t,0,sizeof(*t));
  if(!bytes || !size || size>OCI_POLICY_JSON_MAX)return -1;
  t->nodes=calloc(OCI_POLICY_NODES+1,sizeof(*t->nodes));
  t->strings=malloc(OCI_POLICY_JSON_MAX);
  if(!t->nodes || !t->strings)return -1;
  t->cursor=(struct oci_egress_cursor){(const unsigned char*)bytes,size,0};
  unsigned int root=oci_policy_json_value(t,0);
  oci_egress_space(&t->cursor);
  return root==1 && t->cursor.at==size?0:-1;
}
static void oci_policy_tree_free(struct oci_policy_tree *t){free(t->nodes);
free(t->strings);
memset(t,0,sizeof(*t));
}
static int oci_policy_key(const struct oci_policy_tree *t,unsigned int index,const char *key){return t->nodes[index].key_size==strlen(key) && !memcmp(t->strings+t->nodes[index].key,key,strlen(key));
}
static unsigned int oci_policy_get(const struct oci_policy_tree *t,unsigned int object,const char *key){if(!object || t->nodes[object].kind!=OP_OBJECT)return 0;
for(unsigned int i=t->nodes[object].first;i;i=t->nodes[i].next)if(oci_policy_key(t,i,key))return i;
return 0;
}
static int oci_policy_string_is(const struct oci_policy_tree *t,unsigned int i,const char *s){return i && t->nodes[i].kind==OP_STRING && t->nodes[i].text_size==strlen(s) && !memcmp(t->strings+t->nodes[i].text,s,strlen(s));
}
/* nft can serialize a compiled `ct state { ... }` match with `==`.
 * Recognize only the operator spelling on that match. The caller still
 * compares the entire left operand and exact set members below. */
static int oci_policy_ct_state_set(const struct oci_policy_tree *t,unsigned int match){
  if(!oci_policy_key(t,match,"match"))return 0;
  unsigned int left=oci_policy_get(t,match,"left"),right=oci_policy_get(t,match,"right");
  unsigned int ct=oci_policy_get(t,left,"ct"),set=oci_policy_get(t,right,"set");
  if(!ct || !set || t->nodes[left].first!=ct || t->nodes[ct].next ||
     t->nodes[right].first!=set || t->nodes[set].next || t->nodes[set].kind!=OP_ARRAY)return 0;
  unsigned int key=oci_policy_get(t,ct,"key"),member=t->nodes[set].first;
  return key && t->nodes[ct].first==key && !t->nodes[key].next &&
    oci_policy_string_is(t,key,"state") && member && t->nodes[member].next;
}
static int oci_policy_equal(const struct oci_policy_tree *a,unsigned int ai,const struct oci_policy_tree *b,unsigned int bi){
  const struct oci_policy_node *x=&a->nodes[ai],*y=&b->nodes[bi];
  if(x->kind!=y->kind)return 0;
  if(x->kind==OP_STRING)return x->text_size==y->text_size && !memcmp(a->strings+x->text,b->strings+y->text,x->text_size);
  if(x->kind==OP_NUMBER)return x->negative==y->negative && x->number==y->number;
  if(x->kind==OP_OBJECT){unsigned int count_a=0,count_b=0;
  for(unsigned int i=x->first;i;i=a->nodes[i].next){count_a++;
  unsigned int found=0;
  for(unsigned int j=y->first;j;j=b->nodes[j].next)if(a->nodes[i].key_size==b->nodes[j].key_size && !memcmp(a->strings+a->nodes[i].key,b->strings+b->nodes[j].key,a->nodes[i].key_size)){found=j;
  break;
  }if(!found)return 0;
  if(oci_policy_key(b,found,"op") && oci_policy_string_is(b,found,"in") &&
     oci_policy_string_is(a,i,"==") && oci_policy_ct_state_set(b,bi))continue;
  if(!oci_policy_equal(a,i,b,found))return 0;
  }for(unsigned int j=y->first;j;j=b->nodes[j].next)count_b++;
  return count_a==count_b;
  }
  if(x->kind==OP_ARRAY && x->key_size==3 && !memcmp(a->strings+x->key,"set",3)){
    unsigned int ac=0,bc=0;
    for(unsigned int i=x->first;i;i=a->nodes[i].next){ac++;
    unsigned int found=0;
      for(unsigned int k=x->first;k!=i;k=a->nodes[k].next)if(oci_policy_equal(a,i,a,k))return 0;
      for(unsigned int j=y->first;j;j=b->nodes[j].next)if(oci_policy_equal(a,i,b,j)){found=1;
      break;
      }
      if(!found)return 0;
      }
    for(unsigned int j=y->first;j;j=b->nodes[j].next)bc++;
    return ac==bc;
  }
  if(x->kind==OP_ARRAY){unsigned int i=x->first,j=y->first;
  while(i && j){if(!oci_policy_equal(a,i,b,j))return 0;
  i=a->nodes[i].next;
  j=b->nodes[j].next;
  }return !i && !j;
  }return 1;
}
static int oci_policy_format(char *out,size_t capacity,const char *format,...) __attribute__((format(printf,3,4)));
static int oci_policy_format(char *out,size_t capacity,const char *format,...){va_list ap;
va_start(ap,format);
int n=vsnprintf(out,capacity,format,ap);
va_end(ap);
return n<0 || (size_t)n>=capacity?-1:0;
}
static int oci_policy_append(char *out,size_t *used,size_t capacity,const char *text){size_t n=strlen(text);
if(n>=capacity-*used)return -1;
memcpy(out+*used,text,n+1);
*used+=n;
return 0;
}
static int oci_policy_object(struct oci_policy_owner *p,const char *json){return oci_policy_append(p->expected,&p->expected_size,sizeof(p->expected),",")<0 || oci_policy_append(p->expected,&p->expected_size,sizeof(p->expected),json)<0?-1:0;
}
static int oci_policy_chain(struct oci_policy_owner *p,const char *name,const char *hook,int priority,const char *policy){char text[512],json[512];
  if(hook){if(oci_policy_format(text,sizeof(text),"chain %s { type filter hook %s priority %d; policy %s;\n",name,hook,priority,policy)<0 ||
      oci_policy_format(json,sizeof(json),"{\"chain\":{\"family\":\"inet\",\"table\":\"%s\",\"name\":\"%s\",\"type\":\"filter\",\"hook\":\"%s\",\"prio\":%d,\"policy\":\"%s\"}}",OCI_POLICY_TABLE,name,hook,priority,policy)<0)return -1;
  }else if(oci_policy_format(text,sizeof(text),"chain %s {\n",name)<0 || oci_policy_format(json,sizeof(json),"{\"chain\":{\"family\":\"inet\",\"table\":\"%s\",\"name\":\"%s\"}}",OCI_POLICY_TABLE,name)<0)return -1;
  return oci_policy_append(p->script,&p->script_size,sizeof(p->script),text)<0 || oci_policy_object(p,json)<0?-1:0;
}
static int oci_policy_rule(struct oci_policy_owner *p,const char *chain,const char *rule,const char *expr){char text[4096],json[8192];
  if(oci_policy_format(text,sizeof(text),"%s comment \"policy_%u\"\n",rule,p->rules)<0 || oci_policy_format(json,sizeof(json),"{\"rule\":{\"family\":\"inet\",\"table\":\"%s\",\"chain\":\"%s\",\"expr\":[%s],\"comment\":\"policy_%u\"}}",OCI_POLICY_TABLE,chain,expr,p->rules)<0 ||
    oci_policy_append(p->script,&p->script_size,sizeof(p->script),text)<0 || oci_policy_object(p,json)<0)return -1;
    p->rules++;
    return 0;
}
static int oci_policy_chain_end(struct oci_policy_owner *p){return oci_policy_append(p->script,&p->script_size,sizeof(p->script),"}\n");
}
static int oci_policy_deny(struct oci_policy_owner *p,const char *chain,const char *family,const char *field,const char *address,unsigned int prefix){
  unsigned int width=!strcmp(family,"ip")?32u:128u;
  char text[512],right[256],expr[1024];
  if(prefix==width){if(oci_policy_format(text,sizeof(text),"%s %s %s counter name private_denied drop",family,field,address)<0 || oci_policy_format(right,sizeof(right),"\"%s\"",address)<0)return -1;
  }
  else if(oci_policy_format(text,sizeof(text),"%s %s %s/%u counter name private_denied drop",family,field,address,prefix)<0 || oci_policy_format(right,sizeof(right),"{\"prefix\":{\"addr\":\"%s\",\"len\":%u}}",address,prefix)<0)return -1;
  if(oci_policy_format(expr,sizeof(expr),"{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"%s\",\"field\":\"%s\"}},\"right\":%s}},{\"counter\":\"private_denied\"},{\"drop\":null}",family,field,right)<0)return -1;
  return oci_policy_rule(p,chain,text,expr);
}
static const char *const oci_policy_counters[]={"dns_denied","private_denied","host_replies","raw_accepted","cap_denied","forward_denied","input_denied","outbound_denied"};
static int oci_policy_compile(struct oci_policy_owner *p){
  if(oci_policy_original(p)<0 || !p->denied_count)return -1;
  struct oci_uplink_owner *u=p->uplink;
  p->script_size=p->expected_size=0;
  p->rules=0;
  char text[4096],json[8192];
  if(oci_policy_format(text,sizeof(text),"create table inet %s\ntable inet %s {\n",OCI_POLICY_TABLE,OCI_POLICY_TABLE)<0 || oci_policy_append(p->script,&p->script_size,sizeof(p->script),text)<0 ||
      oci_policy_format(json,sizeof(json),"{\"nftables\":[{\"table\":{\"family\":\"inet\",\"name\":\"%s\"}}",OCI_POLICY_TABLE)<0 || oci_policy_append(p->expected,&p->expected_size,sizeof(p->expected),json)<0)return -1;
  for(unsigned int i=0;i<8;i++){
    if(oci_policy_format(text,sizeof(text),"counter %s { }\n",oci_policy_counters[i])<0 || oci_policy_append(p->script,&p->script_size,sizeof(p->script),text)<0 ||
        oci_policy_format(json,sizeof(json),"{\"counter\":{\"family\":\"inet\",\"table\":\"%s\",\"name\":\"%s\"}}",OCI_POLICY_TABLE,oci_policy_counters[i])<0 || oci_policy_object(p,json)<0)return -1;
  }
  if(oci_policy_format(text,sizeof(text),"quota budget { over %llu bytes; }\n",(unsigned long long)p->limits.bytes)<0 || oci_policy_append(p->script,&p->script_size,sizeof(p->script),text)<0 ||
      oci_policy_format(json,sizeof(json),"{\"quota\":{\"family\":\"inet\",\"table\":\"%s\",\"name\":\"budget\",\"bytes\":%llu,\"inv\":true}}",OCI_POLICY_TABLE,(unsigned long long)p->limits.bytes)<0 || oci_policy_object(p,json)<0)return -1;
  if(oci_policy_chain(p,"dns_guard","output",-320,"accept")<0 || oci_policy_rule(p,"dns_guard","ip daddr 127.0.0.11 counter name dns_denied drop","{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"ip\",\"field\":\"daddr\"}},\"right\":\"127.0.0.11\"}},{\"counter\":\"dns_denied\"},{\"drop\":null}")<0 ||
      oci_policy_rule(p,"dns_guard","ip6 daddr ::ffff:127.0.0.11 counter name dns_denied drop","{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"ip6\",\"field\":\"daddr\"}},\"right\":\"::ffff:127.0.0.11\"}},{\"counter\":\"dns_denied\"},{\"drop\":null}")<0 || oci_policy_chain_end(p)<0 || oci_policy_chain(p,"budgeted",NULL,0,NULL)<0 ||
      oci_policy_rule(p,"budgeted","quota name budget counter name cap_denied drop","{\"quota\":\"budget\"},{\"counter\":\"cap_denied\"},{\"drop\":null}")<0 || oci_policy_rule(p,"budgeted","counter name raw_accepted accept","{\"counter\":\"raw_accepted\"},{\"accept\":null}")<0 || oci_policy_chain_end(p)<0 || oci_policy_chain(p,"output","output",0,"drop")<0)return -1;
  if(oci_policy_rule(p,"output","ip daddr 127.0.0.11 counter name dns_denied drop","{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"ip\",\"field\":\"daddr\"}},\"right\":\"127.0.0.11\"}},{\"counter\":\"dns_denied\"},{\"drop\":null}")<0 ||
      oci_policy_rule(p,"output","ip6 daddr ::ffff:127.0.0.11 counter name dns_denied drop","{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"ip6\",\"field\":\"daddr\"}},\"right\":\"::ffff:127.0.0.11\"}},{\"counter\":\"dns_denied\"},{\"drop\":null}")<0 ||
      oci_policy_rule(p,"output","oifname lo ip daddr 127.0.0.0/8 accept","{\"match\":{\"op\":\"==\",\"left\":{\"meta\":{\"key\":\"oifname\"}},\"right\":\"lo\"}},{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"ip\",\"field\":\"daddr\"}},\"right\":{\"prefix\":{\"addr\":\"127.0.0.0\",\"len\":8}}}},{\"accept\":null}")<0 ||
      oci_policy_rule(p,"output","oifname lo ip6 daddr ::1 accept","{\"match\":{\"op\":\"==\",\"left\":{\"meta\":{\"key\":\"oifname\"}},\"right\":\"lo\"}},{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"ip6\",\"field\":\"daddr\"}},\"right\":\"::1\"}},{\"accept\":null}")<0 ||
      oci_policy_rule(p,"output","meta l4proto tcp tcp dport 25 counter name private_denied drop","{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"tcp\",\"field\":\"dport\"}},\"right\":25}},{\"counter\":\"private_denied\"},{\"drop\":null}")<0)return -1;
  char host[2][INET6_ADDRSTRLEN],guest[2][INET6_ADDRSTRLEN];
  for(unsigned int i=0;i<2;i++){
    const char *family=i?"ip6":"ip";
    if(!inet_ntop(i?AF_INET6:AF_INET,i?(const void*)u->expected.host6:(const void*)u->expected.host4,host[i],sizeof(host[i])) || !inet_ntop(i?AF_INET6:AF_INET,i?(const void*)u->expected.guest6:(const void*)u->expected.guest4,guest[i],sizeof(guest[i])))return -1;
    if(oci_policy_format(text,sizeof(text),"oifname %s %s saddr %s %s daddr %s meta l4proto tcp tcp sport %u ct state established ct direction reply counter name host_replies jump budgeted",u->guest_name,family,guest[i],family,host[i],p->service.port)<0 ||
        oci_policy_format(json,sizeof(json),"{\"match\":{\"op\":\"==\",\"left\":{\"meta\":{\"key\":\"oifname\"}},\"right\":\"%s\"}},{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"%s\",\"field\":\"saddr\"}},\"right\":\"%s\"}},{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"%s\",\"field\":\"daddr\"}},\"right\":\"%s\"}},{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"tcp\",\"field\":\"sport\"}},\"right\":%u}},{\"match\":{\"op\":\"in\",\"left\":{\"ct\":{\"key\":\"state\"}},\"right\":\"established\"}},{\"match\":{\"op\":\"==\",\"left\":{\"ct\":{\"key\":\"direction\"}},\"right\":\"reply\"}},{\"counter\":\"host_replies\"},{\"jump\":{\"target\":\"budgeted\"}}",u->guest_name,family,guest[i],family,host[i],p->service.port)<0 || oci_policy_rule(p,"output",text,json)<0)return -1;
  }
  for(size_t i=0;i<p->denied_count;i++){
    const struct oci_policy_network *n=&p->denied[i];
    char address[INET6_ADDRSTRLEN];
    if(!inet_ntop((int)n->family,n->address,address,sizeof(address)) || oci_policy_deny(p,"output",n->family==AF_INET?"ip":"ip6","daddr",address,n->prefix)<0)return -1;
    if(n->family==AF_INET){char mapped[64];
    if(oci_policy_format(mapped,sizeof(mapped),"::ffff:%s",address)<0 || oci_policy_deny(p,"output","ip6","daddr",mapped,96+n->prefix)<0)return -1;
    }
  }
  static const struct{const char *family,*address;
  unsigned int prefix;
  } blocked[]={
    {"ip","0.0.0.0",8},{"ip","224.0.0.0",3},{"ip","10.0.0.0",8},{"ip","172.16.0.0",12},{"ip","192.168.0.0",16},{"ip","100.64.0.0",10},{"ip","127.0.0.0",8},{"ip","169.254.0.0",16},
    {"ip6","::",128},{"ip6","ff00::",8},{"ip6","fc00::",7},{"ip6","fe80::",10},{"ip6","::1",128},
    {"ip6","::ffff:0.0.0.0",104},{"ip6","::ffff:224.0.0.0",99},{"ip6","::ffff:10.0.0.0",104},{"ip6","::ffff:172.16.0.0",108},{"ip6","::ffff:192.168.0.0",112},{"ip6","::ffff:100.64.0.0",106},{"ip6","::ffff:127.0.0.0",104},{"ip6","::ffff:169.254.0.0",112}};
  for(size_t i=0;i<sizeof(blocked)/sizeof(blocked[0]);i++)if(oci_policy_deny(p,"output",blocked[i].family,"daddr",blocked[i].address,blocked[i].prefix)<0)return -1;
  if(!p->limits.internet && oci_policy_rule(p,"output","counter name outbound_denied drop","{\"counter\":\"outbound_denied\"},{\"drop\":null}")<0)return -1;
  if(oci_policy_format(text,sizeof(text),"ct count over %llu counter name cap_denied drop",(unsigned long long)p->limits.connections)<0 ||
      oci_policy_format(json,sizeof(json),"{\"ct count\":{\"val\":%llu,\"inv\":true}},{\"counter\":\"cap_denied\"},{\"drop\":null}",(unsigned long long)p->limits.connections)<0 || oci_policy_rule(p,"output",text,json)<0 ||
      oci_policy_rule(p,"output","meta l4proto { tcp, udp } jump budgeted","{\"match\":{\"op\":\"==\",\"left\":{\"meta\":{\"key\":\"l4proto\"}},\"right\":{\"set\":[\"tcp\",\"udp\"]}}},{\"jump\":{\"target\":\"budgeted\"}}")<0 || oci_policy_chain_end(p)<0 || oci_policy_chain(p,"input","input",0,"drop")<0 ||
      oci_policy_rule(p,"input","iifname lo accept","{\"match\":{\"op\":\"==\",\"left\":{\"meta\":{\"key\":\"iifname\"}},\"right\":\"lo\"}},{\"accept\":null}")<0)return -1;
  char mac[18];
  if(oci_policy_format(mac,sizeof(mac),"%02x:%02x:%02x:%02x:%02x:%02x",u->host_mac[0],u->host_mac[1],u->host_mac[2],u->host_mac[3],u->host_mac[4],u->host_mac[5])<0)return -1;
  for(unsigned int i=0;i<2;i++){
    const char *family=i?"ip6":"ip";
    if(oci_policy_format(text,sizeof(text),"iifname %s ether saddr %s %s saddr %s %s daddr %s meta l4proto tcp tcp dport %u ct state { new, established } ct direction original accept",u->guest_name,mac,family,host[i],family,guest[i],p->service.port)<0 ||
        oci_policy_format(json,sizeof(json),"{\"match\":{\"op\":\"==\",\"left\":{\"meta\":{\"key\":\"iifname\"}},\"right\":\"%s\"}},{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"ether\",\"field\":\"saddr\"}},\"right\":\"%s\"}},{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"%s\",\"field\":\"saddr\"}},\"right\":\"%s\"}},{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"%s\",\"field\":\"daddr\"}},\"right\":\"%s\"}},{\"match\":{\"op\":\"==\",\"left\":{\"payload\":{\"protocol\":\"tcp\",\"field\":\"dport\"}},\"right\":%u}},{\"match\":{\"op\":\"in\",\"left\":{\"ct\":{\"key\":\"state\"}},\"right\":{\"set\":[\"new\",\"established\"]}}},{\"match\":{\"op\":\"==\",\"left\":{\"ct\":{\"key\":\"direction\"}},\"right\":\"original\"}},{\"accept\":null}",u->guest_name,mac,family,host[i],family,guest[i],p->service.port)<0 || oci_policy_rule(p,"input",text,json)<0)return -1;
  }
  for(size_t i=0;i<sizeof(blocked)/sizeof(blocked[0]);i++)if(oci_policy_deny(p,"input",blocked[i].family,"saddr",blocked[i].address,blocked[i].prefix)<0)return -1;
  if(oci_policy_rule(p,"input","meta l4proto { tcp, udp } ct state { established, related } ct direction reply accept","{\"match\":{\"op\":\"==\",\"left\":{\"meta\":{\"key\":\"l4proto\"}},\"right\":{\"set\":[\"tcp\",\"udp\"]}}},{\"match\":{\"op\":\"in\",\"left\":{\"ct\":{\"key\":\"state\"}},\"right\":{\"set\":[\"established\",\"related\"]}}},{\"match\":{\"op\":\"==\",\"left\":{\"ct\":{\"key\":\"direction\"}},\"right\":\"reply\"}},{\"accept\":null}")<0 ||
      oci_policy_rule(p,"input","counter name input_denied drop","{\"counter\":\"input_denied\"},{\"drop\":null}")<0 || oci_policy_chain_end(p)<0 || oci_policy_chain(p,"forward","forward",-310,"drop")<0 ||
      oci_policy_rule(p,"forward","counter name forward_denied drop","{\"counter\":\"forward_denied\"},{\"drop\":null}")<0 || oci_policy_chain_end(p)<0 || oci_policy_chain_end(p)<0 ||
      oci_policy_append(p->expected,&p->expected_size,sizeof(p->expected),"]}")<0)return -1;
  return oci_policy_original(p);
}
static int oci_policy_u64(const struct oci_policy_tree *t,unsigned int i,uint64_t *value){if(!i || t->nodes[i].kind!=OP_NUMBER || t->nodes[i].negative)return -1;
*value=t->nodes[i].number;
return 0;
}
static int oci_policy_meta(const struct oci_policy_tree *t,unsigned int body){
  if(t->nodes[body].kind!=OP_OBJECT)return -1;
  unsigned int seen=0;
  for(unsigned int i=t->nodes[body].first;i;i=t->nodes[i].next){if(oci_policy_key(t,i,"version") || oci_policy_key(t,i,"release_name")){if(t->nodes[i].kind!=OP_STRING || !t->nodes[i].text_size || t->nodes[i].text_size>256)return -1;
  }
    else if(oci_policy_key(t,i,"json_schema_version")){uint64_t n;
    if(oci_policy_u64(t,i,&n)<0 || n!=1)return -1;
    seen=1;
    }else return -1;
    }
  return seen?0:-1;
}
static int oci_policy_readback(struct oci_policy_owner *p,const char *bytes,size_t size){
  struct oci_policy_tree actual={0},expected={0};
  int result=-1;
  unsigned char *seen=NULL;
  if(oci_policy_tree(&actual,bytes,size)<0 || oci_policy_tree(&expected,p->expected,p->expected_size)<0)goto done;
  unsigned int aa=oci_policy_get(&actual,1,"nftables"),ea=oci_policy_get(&expected,1,"nftables");
  if(!aa || !ea || actual.nodes[1].first!=aa || actual.nodes[aa].next || actual.nodes[aa].kind!=OP_ARRAY || expected.nodes[ea].kind!=OP_ARRAY)goto done;
  seen=calloc(expected.count+1,1);
  if(!seen)goto done;
  unsigned int metadata=0,counters=0,quotas=0,last[5]={0};
  uint64_t packets[8]={0},counts[8]={0},quota=0;
  for(unsigned int item=actual.nodes[aa].first;item;item=actual.nodes[item].next){unsigned int body=actual.nodes[item].first;
    if(actual.nodes[item].kind!=OP_OBJECT || !body || actual.nodes[body].next || actual.nodes[body].kind!=OP_OBJECT)goto done;
    if(oci_policy_key(&actual,body,"metainfo")){if(++metadata>1 || oci_policy_meta(&actual,body)<0)goto done;
    continue;
    }
    int counter=oci_policy_key(&actual,body,"counter"),isquota=oci_policy_key(&actual,body,"quota"),rule=oci_policy_key(&actual,body,"rule"),table=oci_policy_key(&actual,body,"table");
    if(counter){unsigned int name=oci_policy_get(&actual,body,"name"),which=8;
      for(unsigned int i=0;i<8;i++)if(oci_policy_string_is(&actual,name,oci_policy_counters[i])){which=i;
      break;
      }
      if(which==8 || (counters&(1u<<which)) || oci_policy_u64(&actual,oci_policy_get(&actual,body,"packets"),&packets[which])<0 || oci_policy_u64(&actual,oci_policy_get(&actual,body,"bytes"),&counts[which])<0)goto done;
      counters|=1u<<which;
    }
    if(isquota){if(quotas++ || oci_policy_u64(&actual,oci_policy_get(&actual,body,"used"),&quota)<0)goto done;
    }
    /* Only actual object-level runtime fields may be normalized away. No
     * expression, counter reference, rule, policy, quota or mark is erased. */
    unsigned int *link=&actual.nodes[body].first;
    while(*link){unsigned int i=*link;
    int remove=0;
      if(oci_policy_key(&actual,i,"handle")){uint64_t handle;
      if(oci_policy_u64(&actual,i,&handle)<0 || !handle)goto done;
      remove=1;
      }
      if(table && oci_policy_key(&actual,i,"flags")){if(actual.nodes[i].kind!=OP_ARRAY || actual.nodes[i].first)goto done;
      remove=1;
      }
      if(counter && (oci_policy_key(&actual,i,"packets") || oci_policy_key(&actual,i,"bytes")))remove=1;
      if(isquota && oci_policy_key(&actual,i,"used"))remove=1;
      if(remove)*link=actual.nodes[i].next;
      else link=&actual.nodes[i].next;
    }
    unsigned int match=0;
    for(unsigned int wanted=expected.nodes[ea].first;wanted;wanted=expected.nodes[wanted].next){unsigned int eb=expected.nodes[wanted].first;
      if(!seen[wanted] && actual.nodes[body].key_size==expected.nodes[eb].key_size && !memcmp(actual.strings+actual.nodes[body].key,expected.strings+expected.nodes[eb].key,actual.nodes[body].key_size) && oci_policy_equal(&actual,body,&expected,eb)){match=wanted;
      break;
      }}
    if(!match)goto done;
    seen[match]=1;
    if(rule){unsigned int chain=oci_policy_get(&actual,body,"chain"),which=5;
    const char *const names[]={"dns_guard","budgeted","output","input","forward"};
    for(unsigned int i=0;i<5;i++)if(oci_policy_string_is(&actual,chain,names[i])){which=i;
    break;
    }
      if(which==5 || match<=last[which])goto done;
      last[which]=match;
      }
  }
  for(unsigned int i=expected.nodes[ea].first;i;i=expected.nodes[i].next)if(!seen[i])goto done;
  if(counters!=255 || quotas!=1)goto done;
  memcpy(p->observed_packets,packets,sizeof(packets));
  memcpy(p->observed_bytes,counts,sizeof(counts));
  p->observed_quota=quota;
  result=0;
done:free(seen);
oci_policy_tree_free(&actual);
oci_policy_tree_free(&expected);
if(result<0)errno=EPROTO;
return result;
}
static int oci_policy_close_fd(struct oci_policy_owner *p,int *slot){if(*slot<0)return 0;
int fd=*slot;
*slot=-1;
if(close(fd)<0){p->close_unknown=1;
return -1;
}return 0;
}
static int oci_policy_join(struct oci_policy_owner *p,unsigned int stage,int timeout){
  if(!p->pid[stage] || p->joined[stage])return 0;
  struct pollfd fd={.fd=p->pidfd[stage],.events=POLLIN};
  int n=poll(&fd,1,timeout);
  if(n!=1 || fd.revents!=POLLIN){if(!errno)errno=n?EPROTO:ETIMEDOUT;
  return -1;
  }
  siginfo_t info;
  memset(&info,0,sizeof(info));
  if(waitid(P_PIDFD,(id_t)p->pidfd[stage],&info,WEXITED|WNOHANG)<0 || info.si_pid!=p->pid[stage] || (info.si_code!=CLD_EXITED && info.si_code!=CLD_KILLED && info.si_code!=CLD_DUMPED))return -1;
  p->joined[stage]=1;
  p->ok[stage]=info.si_code==CLD_EXITED && !info.si_status;
  return 0;
}
static _Noreturn void oci_policy_child(struct oci_policy_owner *p,unsigned int stage,int input,int output){
  struct tns_oci_owner *o=p->original;
  int executable=fcntl(o->egress_binary,F_DUPFD_CLOEXEC,10),network=fcntl(o->network,F_DUPFD_CLOEXEC,10),incoming=fcntl(input,F_DUPFD_CLOEXEC,10),outgoing=fcntl(output,F_DUPFD_CLOEXEC,10);
  if(executable<0 || network<0 || incoming<0 || outgoing<0 || dup3(executable,3,O_CLOEXEC)<0 || dup3(network,4,O_CLOEXEC)<0 || dup2(incoming,0)!=0 || dup2(outgoing,1)!=1 ||
      syscall(SYS_close_range,2u,2u,0u)<0 || syscall(SYS_close_range,5u,UINT_MAX,0u)<0 || prctl(PR_SET_PDEATHSIG,SIGKILL)<0 || getppid()!=o->controller_pid)_exit(125);
  struct stat st;
  struct statfs fs;
  if(fstat(4,&st)<0 || fstatfs(4,&fs)<0 || (unsigned long)fs.f_type!=(unsigned long)NSFS_MAGIC || ioctl(4,NS_GET_NSTYPE)!=CLONE_NEWNET || (uint64_t)st.st_dev!=o->identity.device || (uint64_t)st.st_ino!=o->identity.inode || setns(4,CLONE_NEWNET)<0 || close(4)<0)_exit(125);
  int null=open("/dev/null",O_WRONLY|O_CLOEXEC|O_NOFOLLOW);
  if(null!=2 || fstat(null,&st)<0 || !S_ISCHR(st.st_mode) || major(st.st_rdev)!=1 || minor(st.st_rdev)!=3)_exit(125);
  for(int fd=0;fd<3;fd++){int flags=fcntl(fd,F_GETFL);
  if(flags<0 || fcntl(fd,F_SETFL,flags&~O_NONBLOCK)<0 || fcntl(fd,F_SETFD,0)<0)_exit(125);
  }
  char *const check[]={"nft","--check","-f","-",NULL},*const apply[]={"nft","-f","-",NULL},*const readback[]={"nft","-j","list","table","inet",OCI_POLICY_TABLE,NULL};
  char *const ruleset[]={"nft","-j","list","ruleset",NULL};
  char *const environment[]={"PATH=/usr/sbin:/usr/bin:/sbin:/bin",NULL};
  char *const *argv=stage==0?check:stage==1?apply:stage==2?(o->admission_ruleset_reads?ruleset:readback):NULL;
  if(!argv)_exit(125);
  umask(077);
  syscall(SYS_execveat,3,"",argv,environment,AT_EMPTY_PATH);
  _exit(125);
}
static int oci_policy_command(struct oci_policy_owner *p,unsigned int stage,int64_t deadline,char *output,size_t *used){
  if(stage>=3 || p->pid[stage] || (stage && !p->ok[stage-1]) || oci_policy_original(p)<0 || oci_egress_left(deadline)<0)return -1;
  int in[2],out[2];
  if(pipe2(in,O_CLOEXEC|O_NONBLOCK)<0)return -1;
  if(pipe2(out,O_CLOEXEC|O_NONBLOCK)<0){(void)oci_policy_close_fd(p,&in[0]);
  (void)oci_policy_close_fd(p,&in[1]);
  return -1;
  }
  p->incoming[stage]=in[1];
  p->outgoing[stage]=out[0];
  struct clone_args args;
  memset(&args,0,sizeof(args));
  args.flags=CLONE_PIDFD|CLONE_CLEAR_SIGHAND;
  args.exit_signal=SIGCHLD;
  args.pidfd=(uint64_t)(uintptr_t)&p->pidfd[stage];
  long child=syscall(SYS_clone3,&args,sizeof(args));
  if(!child)oci_policy_child(p,stage,in[0],out[1]);
  (void)oci_policy_close_fd(p,&in[0]);
  (void)oci_policy_close_fd(p,&out[1]);
  if(child<0)return -1;
  p->pid[stage]=(pid_t)child;
  if(oci_policy_original(p)<0)return -1;
  size_t at=0,size=stage==2?0:p->script_size;
  while(at<size){int left=oci_egress_left(deadline);
  struct pollfd fd={.fd=in[1],.events=POLLOUT};
  if(left<0 || oci_not_canceled()<0 || poll(&fd,1,left)!=1 || fd.revents!=POLLOUT)return -1;
  ssize_t n=write(in[1],p->script+at,size-at);
  if(n<=0)return -1;
  at+=(size_t)n;
  }
  if(oci_policy_close_fd(p,&p->incoming[stage])<0)return -1;
  *used=0;
  for(;;){int left=oci_egress_left(deadline);
  struct pollfd fd={.fd=out[0],.events=POLLIN};
  if(left<0 || oci_not_canceled()<0 || poll(&fd,1,left)!=1 || (fd.revents!=POLLIN && fd.revents!=POLLHUP && fd.revents!=(POLLIN|POLLHUP)))return -1;
    ssize_t n=read(out[0],output+*used,OCI_POLICY_JSON_MAX-*used);
    if(n<0)return -1;
    if(!n)break;
    *used+=(size_t)n;
    if(*used==OCI_POLICY_JSON_MAX){errno=EOVERFLOW;
    return -1;
    }}
  if(oci_policy_close_fd(p,&p->outgoing[stage])<0)return -1;
  int left=oci_egress_left(deadline);
  if(left<0 || oci_policy_join(p,stage,left)<0 || !p->ok[stage] || oci_policy_original(p)<0){if(!errno)errno=EPROTO;
  return -1;
  }return 0;
}
static int oci_policy_inventory_same(struct oci_policy_owner *p){
  size_t count=p->denied_count;
  struct oci_policy_network *before=malloc(count*sizeof(*before));
  if(!before)return -1;
  memcpy(before,p->denied,count*sizeof(*before));
  int result=oci_policy_inventory(p);
  if(result==0 && count!=p->denied_count)result=-1;
  if(result==0)for(size_t i=0;i<count;i++){int found=0;
  for(size_t j=0;j<count;j++)if(before[i].family==p->denied[j].family && before[i].prefix==p->denied[j].prefix && !memcmp(before[i].address,p->denied[j].address,16)){found=1;
  break;
  }if(!found){result=-1;
  break;
  }}
  free(before);
  if(result<0 && !errno)errno=ESTALE;
  return result;
}
static int oci_policy_install(struct oci_policy_owner *p){
  if(!p)return 0;
  if(tns_oci_once(&p->attempt)<0){errno=EALREADY;
  return -1;
  }
  if(oci_policy_original(p)<0 || oci_uplink_lock(p->uplink)<0 || oci_policy_inventory(p)<0 || oci_policy_compile(p)<0)return -1;
  for(int side=0;side<2;side++){if(oci_policy_neighbor(p,side)<0 || oci_policy_neighbor_read(p,side,AF_INET)<0 || oci_policy_neighbor_read(p,side,AF_INET6)<0)return -1;
  }
  char *output=malloc(OCI_POLICY_JSON_MAX);
  if(!output)return -1;
  size_t used=0;
  int result=-1;
  int64_t now=oci_now();
  if(now<0)goto done;
  int64_t deadline=now+10000;
  for(unsigned int stage=0;stage<3;stage++){if(oci_policy_command(p,stage,deadline,output,&used)<0 || (stage<2 && used))goto done;
  }
  if(oci_policy_readback(p,output,used)<0 || oci_policy_inventory_same(p)<0 || oci_policy_original(p)<0 || oci_uplink_unlock(p->uplink)<0)goto done;
  p->verified=1;
   /* Structural source fact only; birth DROP/kernel deny persist. */
  result=0;
done:free(output);
return result;
}
/* A fresh read-only command has separate custody from all three install slots.
 * Only an entirely observed, joined and closed read may retire this record.
 * Any failed/unknown read stays on this original owner; it is never replayed. */
static int oci_policy_runtime_close_fd(struct oci_policy_runtime *r,int *slot) {
  if (*slot < 0) return 0;
  int fd = *slot; *slot = -1;
  if (close(fd) < 0) { r->close_unknown = 1; return -1; }
  return 0;
}
static int oci_policy_runtime_join(struct oci_policy_runtime *r,int timeout) {
  if (!r->pid || r->joined) return 0;
  if (r->wait_attempted) { errno = EUCLEAN; return -1; }
  struct pollfd fd = {.fd=r->pidfd,.events=POLLIN};
  int n = poll(&fd,1,timeout);
  if (n != 1 || fd.revents != POLLIN) {
    if (!errno) errno = n ? EPROTO : ETIMEDOUT;
    return -1;
  }
  siginfo_t info; memset(&info,0,sizeof(info));
  r->wait_attempted = 1;
  if (waitid(P_PIDFD,(id_t)r->pidfd,&info,WEXITED|WNOHANG) < 0 ||
      info.si_pid != r->pid ||
      (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED && info.si_code != CLD_DUMPED)) {
    if (!errno) errno = EPROTO;
    return -1;
  }
  r->joined = 1;
  r->ok = info.si_code == CLD_EXITED && !info.si_status;
  return 0;
}
static int oci_policy_runtime_stop(struct oci_policy_owner *p) {
  if (!p || !p->runtime) return 0;
  if (!p->original || p->original->controller_pid != getpid()) { errno = EPERM; return -1; }
  struct oci_policy_runtime *r = p->runtime;
  int saved = 0;
  if (r->pid && !r->joined && !r->killed) {
    r->killed = 1;
    if (syscall(SYS_pidfd_send_signal,r->pidfd,SIGKILL,NULL,0) < 0 && errno != ESRCH)
      saved = errno;
  }
  if (oci_policy_runtime_join(r,1000) < 0 && !saved) saved = errno ? errno : EPROTO;
  if (oci_policy_runtime_close_fd(r,&r->incoming) < 0 && !saved) saved = errno;
  if (oci_policy_runtime_close_fd(r,&r->outgoing) < 0 && !saved) saved = errno;
  if (r->joined && oci_policy_runtime_close_fd(r,&r->pidfd) < 0 && !saved) saved = errno;
  if (r->close_unknown && !saved) saved = EUCLEAN;
  if (saved) { errno = saved; return -1; }
  return 0;
}
static int oci_policy_runtime_facts(struct oci_policy_owner *p) {
  if (oci_policy_original(p) < 0 || !p->verified ||
      oci_uplink_config_readback(p->uplink) < 0 || oci_policy_inventory_same(p) < 0)
    return -1;
  for (int side=0;side<2;side++)
    if (oci_policy_neighbor_read(p,side,AF_INET) < 0 ||
        oci_policy_neighbor_read(p,side,AF_INET6) < 0) return -1;
  return oci_policy_original(p);
}

/* Use the already-installed original baseline with the independently bound
 * GET transport. Inventory comparisons have their own writable copy. */
static inline int oci_policy_read_topology_current(struct tns_oci_owner *o,
                                                   struct oci_uplink_read *r,
                                                   struct stat *topology_identity) {
  if (!o || !r || !r->ready || !r->scratch || r->scratch->original != o ||
      !topology_identity || oci_uplink_read_current(r) < 0) return -1;
  const struct oci_uplink_owner *u = r->original;
  const struct oci_policy_owner *original = o->policy;
  if (!u->create_sent || !u->create_known || !u->link_path_captured || !u->driver_captured ||
      !u->host_index || !u->guest_index || !u->loopback_index || !original->denied_count) {
    errno = EUCLEAN;
    return -1;
  }
  struct oci_policy_owner *readback = malloc(sizeof(*readback));
  if (!readback) return -1;
  *readback = *original;
  readback->uplink = r->scratch;
  readback->runtime = NULL;
  int result = oci_policy_runtime_facts(readback);
  if (!result) result = oci_uplink_read_topology_identity(r, topology_identity);
  free(readback);
  return result;
}
static int oci_policy_runtime_read(struct oci_policy_owner *p,int64_t deadline,
                                   char *output,size_t *used) {
  struct oci_policy_runtime *r = p->runtime;
  if (!r || tns_oci_once(&r->attempted) < 0 || oci_policy_original(p) < 0 ||
      !p->uplink->lock_held || oci_egress_left(deadline) < 0) return -1;
  int in[2],out[2];
  if (pipe2(in,O_CLOEXEC|O_NONBLOCK) < 0) return -1;
  r->incoming = in[1];
  if (pipe2(out,O_CLOEXEC|O_NONBLOCK) < 0) {
    (void)oci_policy_runtime_close_fd(r,&in[0]);
    return -1;
  }
  r->outgoing = out[0];
  struct clone_args args; memset(&args,0,sizeof(args));
  args.flags = CLONE_PIDFD|CLONE_CLEAR_SIGHAND;
  args.exit_signal = SIGCHLD;
  args.pidfd = (uint64_t)(uintptr_t)&r->pidfd;
  long child = syscall(SYS_clone3,&args,sizeof(args));
  if (!child) oci_policy_child(p,2,in[0],out[1]);
  if (child > 0) r->pid = (pid_t)child;
  int failed = oci_policy_runtime_close_fd(r,&in[0]) < 0;
  if (oci_policy_runtime_close_fd(r,&out[1]) < 0) failed = 1;
  if (child < 0 || failed || oci_policy_original(p) < 0 ||
      oci_policy_runtime_close_fd(r,&r->incoming) < 0) return -1;
  *used = 0;
  for (;;) {
    int left = oci_egress_left(deadline);
    struct pollfd fd = {.fd=r->outgoing,.events=POLLIN};
    if (left < 0 || oci_not_canceled() < 0 || poll(&fd,1,left) != 1 ||
        (fd.revents != POLLIN && fd.revents != POLLHUP && fd.revents != (POLLIN|POLLHUP))) return -1;
    ssize_t n = read(r->outgoing,output+*used,OCI_POLICY_JSON_MAX-*used);
    if (n < 0) return -1;
    if (!n) break;
    *used += (size_t)n;
    if (*used == OCI_POLICY_JSON_MAX) { errno = EOVERFLOW; return -1; }
  }
  if (oci_policy_runtime_close_fd(r,&r->outgoing) < 0) return -1;
  int left = oci_egress_left(deadline);
  if (left < 0 || oci_policy_runtime_join(r,left) < 0 || !r->ok ||
      oci_policy_original(p) < 0 || oci_policy_readback(p,output,*used) < 0) return -1;
  return 0;
}
static int oci_policy_runtime_current(struct tns_oci_owner *o) {
  if (!o || !o->policy) return 0; /* Preserve the original no-policy behavior. */
  struct oci_policy_owner *p = o->policy;
  if (p->original != o || p->runtime || !p->verified) { errno = EUCLEAN; return -1; }
  struct oci_policy_runtime *r = calloc(1,sizeof(*r));
  if (!r) return -1;
  r->pidfd = r->incoming = r->outgoing = -1;
  p->runtime = r;
  char *output = malloc(OCI_POLICY_JSON_MAX);
  if (!output) return -1;
  size_t used = 0;
  int result = -1;
  if (oci_policy_original(p) < 0 || oci_uplink_lock(p->uplink) < 0 ||
      oci_policy_runtime_facts(p) < 0) goto done;
  int64_t now = oci_now();
  if (now < 0 || oci_policy_runtime_read(p,now+10000,output,&used) < 0 ||
      oci_policy_runtime_facts(p) < 0 || oci_not_canceled() < 0 ||
      oci_policy_runtime_close_fd(r,&r->pidfd) < 0 || r->close_unknown ||
      oci_uplink_unlock(p->uplink) < 0) goto done;
  explicit_bzero(r,sizeof(*r)); free(r); p->runtime = NULL;
  result = 0;
done:
  free(output);
  /* Failures deliberately leave the original child/FD/lock record retained.
   * Cancel/close may stop and join it, but cannot turn that read into success. */
  return result;
}

static int oci_policy_stop(struct oci_policy_owner *p){
  if(!p)return 0;
  if(!p->original || p->original->controller_pid!=getpid()){errno=EPERM;
  return -1;
  }int saved=0;
  if(oci_policy_runtime_stop(p)<0)saved=errno?errno:EPROTO;
  for(unsigned int i=0;i<3;i++){
    if(p->pid[i] && !p->joined[i] && !p->killed[i]){p->killed[i]=1;
    if(syscall(SYS_pidfd_send_signal,p->pidfd[i],SIGKILL,NULL,0)<0 && errno!=ESRCH && !saved)saved=errno;
    }
    if(oci_policy_join(p,i,1000)<0 && !saved)saved=errno?errno:EPROTO;
    if(oci_policy_close_fd(p,&p->incoming[i])<0 && !saved)saved=errno;
    if(oci_policy_close_fd(p,&p->outgoing[i])<0 && !saved)saved=errno;
  }
  if(saved){errno=saved;
  return -1;
  }return 0;
}
/* Closing our private transport never deletes a table or repairs missing ACK.
 * A possibly applied but unverified policy retains the same original owner. */
static int oci_policy_close(struct oci_policy_owner **slot){
  if(!slot || !*slot)return 0;
  struct oci_policy_owner *p=*slot;
  struct tns_oci_owner *o=p->original;
  if(!o || o->controller_pid!=getpid() || (o->command_pid && (!o->init_joined || !o->init_custody || !o->init_stop_attempt || !o->command_joined || !o->command_ok || (o->start_pid && !o->start_joined))) || oci_policy_stop(p)<0)return -1;
  /* Only this existing original uncreated/actually-init-joined cleanup gate
   * may retire a failed read record. It never qualifies a runtime observation
   * or permits another read. Unknown consuming wait/close remains retained. */
  if(p->runtime){
    struct oci_policy_runtime *r=p->runtime;
    if((r->pid && !r->joined) || r->pidfd>=0 || r->incoming>=0 ||
        r->outgoing>=0 || r->close_unknown){errno=EUCLEAN;return -1;}
    explicit_bzero(r,sizeof(*r));free(r);p->runtime=NULL;
  }
  if((p->pid[1] && !p->verified) || p->close_unknown){errno=EUCLEAN;
  return -1;
  }
  for(unsigned int i=0;i<3;i++)if(oci_policy_close_fd(p,&p->pidfd[i])<0)return -1;
  if(oci_policy_close_fd(p,&p->file)<0)return -1;
  explicit_bzero(p,sizeof(*p));
  free(p);
  *slot=NULL;
  return 0;
}

/* This record owns one actual Host forwarding object, never guest policy slots.
 * Its handle is learned only from this create transaction's kernel echo. */
#define OCI_HOST_PATH_STAGES 6u
struct oci_host_path_owner {
  struct oci_uplink_owner *uplink;
  pid_t controller;
  struct tns_identity creator;
  uint64_t cookie, handle;
  uint32_t host_index, guest_index, uplink_index;
  char claim[65], table[80], host_name[16], uplink_name[16];
  char script[8192], expected[16384], deletion[160];
  size_t script_size, expected_size, deletion_size;
  int pidfd[OCI_HOST_PATH_STAGES], incoming[OCI_HOST_PATH_STAGES], outgoing[OCI_HOST_PATH_STAGES];
  pid_t pid[OCI_HOST_PATH_STAGES];
  unsigned int attempted[OCI_HOST_PATH_STAGES], wait_attempted[OCI_HOST_PATH_STAGES];
  unsigned int joined[OCI_HOST_PATH_STAGES], ok[OCI_HOST_PATH_STAGES], killed[OCI_HOST_PATH_STAGES];
  unsigned int verified, removed, unknown, close_unknown;
};
static int oci_host_path_current(struct oci_host_path_owner *p, int cleaning) {
  struct oci_uplink_owner *u = p ? p->uplink : NULL;
  uint32_t port = 0;
  if (!u || !u->original || u->host_path != p || p->controller != getpid() || geteuid() != 0 ||
      memcmp(p->claim, u->original->id, sizeof(p->claim)) ||
      !tns_identity_equal(&p->creator, &u->creator) || p->cookie != u->host_cookie ||
      p->host_index != u->host_index || p->guest_index != u->guest_index ||
      p->uplink_index != u->expected.index || memcmp(p->host_name, u->host_name, 16) ||
      memcmp(p->uplink_name, u->expected.name, 16) ||
      !u->create_known || !u->pair_known || !u->lock_held ||
      (cleaning ? oci_uplink_cleanup_current(u) : oci_uplink_original(u)) < 0 ||
      oci_uplink_host_current(u) < 0 ||
      oci_uplink_socket_identity(u->host, p->cookie, &port) < 0 || port != u->host_port ||
      (cleaning ? (!u->delete_known || oci_uplink_absent(u) < 0) :
       (oci_uplink_pair(u) < 0 || oci_uplink_driver_link(u) < 0))) {
    if (!errno) errno = ESTALE;
    return -1;
  }
  return 0;
}
static int oci_host_path_program(struct oci_host_path_owner *p) {
  if (!p->host_index || !p->guest_index || !p->uplink_index || p->host_index == p->uplink_index ||
      oci_policy_format(p->table, sizeof(p->table), "tako_host_%s", p->claim) < 0 ||
      oci_policy_format(p->script, sizeof(p->script),
        "create table inet %s\nadd chain inet %s forward { type filter hook forward priority 0; policy accept; }\n",
        p->table, p->table) < 0 ||
      oci_policy_format(p->expected, sizeof(p->expected),
        "{\"nftables\":[{\"table\":{\"family\":\"inet\",\"name\":\"%s\"}},"
        "{\"chain\":{\"family\":\"inet\",\"table\":\"%s\",\"name\":\"forward\","
        "\"type\":\"filter\",\"hook\":\"forward\",\"prio\":0,\"policy\":\"accept\"}}",
        p->table, p->table) < 0) return -1;
  p->script_size = strlen(p->script); p->expected_size = strlen(p->expected);
  /* Neither protocol nor port is restricted here. Host-local service traffic
   * traverses INPUT/OUTPUT, not this FORWARD-only negative fence. */
  for (unsigned int i = 0; i < 6; ++i) {
    const char *first = i < 3 ? "iif" : "oif";
    const char *second = i == 0 ? "iifname" : i == 1 ? "oif" : i == 2 ? "oifname" :
                         i == 3 ? "oifname" : i == 4 ? "iif" : "iifname";
    char value[64], json_value[64], text[1024], json[2048];
    if (i == 1 || i == 4) {
      if (oci_policy_format(value, sizeof(value), "%u", p->uplink_index) < 0) return -1;
      /* v1.1.1 prints ifindex expressions as the current interface name,
       * including with -n; current() bookends that name/index/MAC tuple. */
      if (oci_policy_format(json_value, sizeof(json_value), "\"%s\"", p->uplink_name) < 0) return -1;
    } else {
      const char *name = i == 0 || i == 3 ? p->host_name : p->uplink_name;
      if (oci_policy_format(value, sizeof(value), "\"%s\"", name) < 0) return -1;
      memcpy(json_value, value, strlen(value) + 1);
    }
    if (oci_policy_format(text, sizeof(text),
        "add rule inet %s forward meta %s %u meta %s != %s drop comment \"host_path_%u\"\n",
        p->table, first, p->host_index, second, value, i) < 0 ||
        oci_policy_format(json, sizeof(json),
        ",{\"rule\":{\"family\":\"inet\",\"table\":\"%s\",\"chain\":\"forward\","
        "\"expr\":[{\"match\":{\"op\":\"==\",\"left\":{\"meta\":{\"key\":\"%s\"}},\"right\":\"%s\"}},"
        "{\"match\":{\"op\":\"!=\",\"left\":{\"meta\":{\"key\":\"%s\"}},\"right\":%s}},"
        "{\"drop\":null}],\"comment\":\"host_path_%u\"}}",
        p->table, first, p->host_name, second, json_value, i) < 0 ||
        oci_policy_append(p->script, &p->script_size, sizeof(p->script), text) < 0 ||
        oci_policy_append(p->expected, &p->expected_size, sizeof(p->expected), json) < 0) return -1;
  }
  return oci_policy_append(p->expected, &p->expected_size, sizeof(p->expected), "]}");
}

/* echo==1 is accepted only for the original successful create command. GETs
 * can compare an already retained handle; they can never create ownership. */
static int oci_host_path_readback(struct oci_host_path_owner *p, const char *bytes, size_t size, int echo) {
  struct oci_policy_tree actual = {0}, expected = {0};
  int result = -1; uint64_t handle = 0;
  if ((echo ? p->handle || !p->joined[1] || !p->ok[1] : !p->handle) ||
      oci_policy_tree(&actual, bytes, size) < 0 ||
      oci_policy_tree(&expected, p->expected, p->expected_size) < 0) goto done;
  unsigned int aa = oci_policy_get(&actual, 1, "nftables"), ea = oci_policy_get(&expected, 1, "nftables");
  if (!aa || !ea || actual.nodes[1].first != aa || actual.nodes[aa].next ||
      actual.nodes[aa].kind != OP_ARRAY || expected.nodes[ea].kind != OP_ARRAY) goto done;
  unsigned int wanted = expected.nodes[ea].first, metadata = 0, objects = 0;
  for (unsigned int item = actual.nodes[aa].first; item; item = actual.nodes[item].next) {
    unsigned int body = actual.nodes[item].first;
    if (actual.nodes[item].kind != OP_OBJECT || !body || actual.nodes[body].next || actual.nodes[body].kind != OP_OBJECT) goto done;
    if (oci_policy_key(&actual, body, "metainfo")) {
      if (++metadata > 1 || oci_policy_meta(&actual, body) < 0) goto done;
      continue;
    }
    if (echo) {
      /* EXCL NEWTABLE is reported as create; chains/rules use add. */
      if (!wanted || !oci_policy_key(&actual, body,
          oci_policy_key(&expected, expected.nodes[wanted].first, "table") ? "create" : "add")) goto done;
      body = actual.nodes[body].first;
      if (!body || actual.nodes[body].next || actual.nodes[body].kind != OP_OBJECT) goto done;
    }
    if (!wanted) goto done;
    unsigned int eb = expected.nodes[wanted].first;
    if (actual.nodes[body].key_size != expected.nodes[eb].key_size ||
        memcmp(actual.strings + actual.nodes[body].key, expected.strings + expected.nodes[eb].key, actual.nodes[body].key_size)) goto done;
    int table = oci_policy_key(&actual, body, "table");
    unsigned int *link = &actual.nodes[body].first;
    while (*link) {
      unsigned int i = *link;
      if (oci_policy_key(&actual, i, "handle")) {
        uint64_t value;
        if (oci_policy_u64(&actual, i, &value) < 0 || !value) goto done;
        if (table) handle = value;
        *link = actual.nodes[i].next;
      } else if (table && oci_policy_key(&actual, i, "flags")) {
        if (actual.nodes[i].kind != OP_ARRAY || actual.nodes[i].first) goto done;
        *link = actual.nodes[i].next;
      } else link = &actual.nodes[i].next;
    }
    if (!oci_policy_equal(&actual, body, &expected, eb)) goto done;
    objects++; wanted = expected.nodes[wanted].next;
  }
  if (wanted || objects != 8 || !handle || (!echo && handle != p->handle)) goto done;
  if (echo) p->handle = handle; /* Entire original transaction echo validated. */
  result = 0;
done:
  oci_policy_tree_free(&actual); oci_policy_tree_free(&expected);
  if (result < 0) errno = EPROTO;
  return result;
}
/* Cleanup compares the original transaction's table identity after the pair
 * has disappeared. Rule ifindex printers can no longer resolve that pair name. */
static int oci_host_path_tables(struct oci_host_path_owner *p, const char *bytes, size_t size, int present) {
  struct oci_policy_tree actual = {0}; int result = -1; unsigned int found = 0;
  if (!p->handle || (!present && (!p->joined[4] || !p->ok[4])) ||
      oci_policy_tree(&actual, bytes, size) < 0) goto done;
  unsigned int aa = oci_policy_get(&actual, 1, "nftables"), metadata = 0;
  if (!aa || actual.nodes[1].first != aa || actual.nodes[aa].next || actual.nodes[aa].kind != OP_ARRAY) goto done;
  for (unsigned int item = actual.nodes[aa].first; item; item = actual.nodes[item].next) {
    unsigned int body = actual.nodes[item].first;
    if (actual.nodes[item].kind != OP_OBJECT || !body || actual.nodes[body].next || actual.nodes[body].kind != OP_OBJECT) goto done;
    if (oci_policy_key(&actual, body, "metainfo")) {
      if (++metadata > 1 || oci_policy_meta(&actual, body) < 0) goto done;
      continue;
    }
    if (!oci_policy_key(&actual, body, "table")) goto done;
    unsigned int family = oci_policy_get(&actual, body, "family"), name = oci_policy_get(&actual, body, "name");
    uint64_t handle = 0;
    if (!family || !name || actual.nodes[family].kind != OP_STRING || actual.nodes[name].kind != OP_STRING ||
        !actual.nodes[family].text_size || !actual.nodes[name].text_size ||
        oci_policy_u64(&actual, oci_policy_get(&actual, body, "handle"), &handle) < 0 || !handle) goto done;
    int named = oci_policy_string_is(&actual, family, "inet") && oci_policy_string_is(&actual, name, p->table);
    if (handle == p->handle || named) {
      if (!present || handle != p->handle || !named || ++found != 1) goto done;
    }
    for (unsigned int i = actual.nodes[body].first; i; i = actual.nodes[i].next) {
      if (oci_policy_key(&actual, i, "family") || oci_policy_key(&actual, i, "name") || oci_policy_key(&actual, i, "handle")) continue;
      if (!oci_policy_key(&actual, i, "flags") || actual.nodes[i].kind != OP_ARRAY) goto done;
      if (named && actual.nodes[i].first) goto done;
      /* Other tables are not inspected, adopted or altered. */
    }
  }
  if (found != (unsigned int)present) goto done;
  result = 0;
done:
  oci_policy_tree_free(&actual); if (result < 0) errno = EPROTO; return result;
}
static int oci_host_path_close_fd(struct oci_host_path_owner *p, int *slot) {
  if (*slot < 0) return 0;
  int fd = *slot; *slot = -1;
  if (close(fd) < 0) { p->close_unknown = 1; return -1; }
  return 0;
}
static int oci_host_path_join(struct oci_host_path_owner *p, unsigned int stage, int timeout) {
  if (stage >= OCI_HOST_PATH_STAGES || !p->pid[stage]) { errno = EINVAL; return -1; }
  if (p->joined[stage]) return 0;
  if (p->wait_attempted[stage]) { errno = EUCLEAN; return -1; }
  struct pollfd fd = {.fd = p->pidfd[stage], .events = POLLIN};
  int n = poll(&fd, 1, timeout);
  if (n != 1 || fd.revents != POLLIN) { if (!errno) errno = n ? EPROTO : ETIMEDOUT; return -1; }
  siginfo_t info; memset(&info, 0, sizeof(info));
  p->wait_attempted[stage] = 1;
  if (waitid(P_PIDFD, (id_t)p->pidfd[stage], &info, WEXITED | WNOHANG) < 0 ||
      info.si_pid != p->pid[stage] || (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED && info.si_code != CLD_DUMPED)) {
    p->unknown = 1; return -1;
  }
  p->joined[stage] = 1;
  p->ok[stage] = info.si_code == CLD_EXITED && !info.si_status;
  return 0;
}
static _Noreturn void oci_host_path_child(struct oci_host_path_owner *p, unsigned int stage, int input, int output) {
  struct tns_oci_owner *o = p->uplink->original;
  int executable = fcntl(o->egress_binary, F_DUPFD_CLOEXEC, 10), network = fcntl(p->uplink->netfd, F_DUPFD_CLOEXEC, 10);
  int incoming = fcntl(input, F_DUPFD_CLOEXEC, 10), outgoing = fcntl(output, F_DUPFD_CLOEXEC, 10);
  if (executable < 0 || network < 0 || incoming < 0 || outgoing < 0 || dup3(executable, 3, O_CLOEXEC) < 0 ||
      dup3(network, 4, O_CLOEXEC) < 0 || dup2(incoming, 0) != 0 || dup2(outgoing, 1) != 1 ||
      syscall(SYS_close_range, 2u, 2u, 0u) < 0 || syscall(SYS_close_range, 5u, UINT_MAX, 0u) < 0 ||
      prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != p->controller) _exit(125);
  struct stat st; struct statfs fs;
  if (fstat(4, &st) < 0 || fstatfs(4, &fs) < 0 || (unsigned long)fs.f_type != (unsigned long)NSFS_MAGIC ||
      ioctl(4, NS_GET_NSTYPE) != CLONE_NEWNET || (uint64_t)st.st_dev != p->creator.device ||
      (uint64_t)st.st_ino != p->creator.inode || setns(4, CLONE_NEWNET) < 0 || close(4) < 0) _exit(125);
  int null = open("/dev/null", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (null != 2 || fstat(null, &st) < 0 || !S_ISCHR(st.st_mode) || major(st.st_rdev) != 1 || minor(st.st_rdev) != 3) _exit(125);
  for (int fd = 0; fd < 3; ++fd) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) < 0 || fcntl(fd, F_SETFD, 0) < 0) _exit(125);
  }
  char *const check[] = {"nft", "-c", "-f", "-", NULL};
  char *const apply[] = {"nft", "-j", "-a", "-n", "-e", "-f", "-", NULL};
  char *const readback[] = {"nft", "-j", "-a", "-n", "list", "table", "inet", p->table, NULL};
  char *const remove[] = {"nft", "-f", "-", NULL};
  char *const absent[] = {"nft", "-j", "-a", "-n", "list", "tables", NULL};
  char *const environment[] = {"PATH=/usr/sbin:/usr/bin:/sbin:/bin", NULL};
  char *const *argv = stage == 0 ? check : stage == 1 ? apply : stage == 2 ? readback : stage == 4 ? remove : stage == 3 || stage == 5 ? absent : NULL;
  if (!argv) _exit(125);
  umask(077); syscall(SYS_execveat, 3, "", argv, environment, AT_EMPTY_PATH); _exit(125);
}
static int oci_host_path_command(struct oci_host_path_owner *p, unsigned int stage, int64_t deadline, char *output, size_t *used) {
  int cleaning = stage >= 3;
  if (stage >= OCI_HOST_PATH_STAGES || p->attempted[stage] || p->unknown || p->close_unknown ||
      (stage && !p->ok[stage - 1]) || oci_host_path_current(p, cleaning) < 0 || oci_egress_left(deadline) < 0) return -1;
  p->attempted[stage] = 1; /* Each operation is consumed before any dispatch. */
  int in[2] = {-1, -1}, out[2] = {-1, -1};
  if (pipe2(in, O_CLOEXEC | O_NONBLOCK) < 0) goto fail;
  if (pipe2(out, O_CLOEXEC | O_NONBLOCK) < 0) {
    (void)oci_host_path_close_fd(p, &in[0]); (void)oci_host_path_close_fd(p, &in[1]); goto fail;
  }
  p->incoming[stage] = in[1]; p->outgoing[stage] = out[0];
  struct clone_args args; memset(&args, 0, sizeof(args));
  args.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND; args.exit_signal = SIGCHLD;
  args.pidfd = (uint64_t)(uintptr_t)&p->pidfd[stage];
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (!child) oci_host_path_child(p, stage, in[0], out[1]);
  (void)oci_host_path_close_fd(p, &in[0]); (void)oci_host_path_close_fd(p, &out[1]);
  if (child < 0) goto fail;
  p->pid[stage] = (pid_t)child;
  if (p->close_unknown || oci_host_path_current(p, cleaning) < 0) goto fail;
  size_t at = 0, size = stage < 2 ? p->script_size : stage == 4 ? p->deletion_size : 0;
  const char *bytes = stage == 4 ? p->deletion : p->script;
  while (at < size) {
    int left = oci_egress_left(deadline); struct pollfd fd = {.fd = p->incoming[stage], .events = POLLOUT};
    if (left < 0 || (!cleaning && oci_not_canceled() < 0) || poll(&fd, 1, left) != 1 || fd.revents != POLLOUT) goto fail;
    ssize_t n = write(fd.fd, bytes + at, size - at);
    if (n <= 0 || (size_t)n > size - at) goto fail;
    at += (size_t)n;
  }
  if (oci_host_path_close_fd(p, &p->incoming[stage]) < 0) goto fail;
  *used = 0;
  for (;;) {
    int left = oci_egress_left(deadline); struct pollfd fd = {.fd = p->outgoing[stage], .events = POLLIN};
    if (left < 0 || (!cleaning && oci_not_canceled() < 0) || *used >= OCI_POLICY_JSON_MAX || poll(&fd, 1, left) != 1 ||
        (fd.revents != POLLIN && fd.revents != POLLHUP && fd.revents != (POLLIN | POLLHUP))) goto fail;
    ssize_t n = read(fd.fd, output + *used, OCI_POLICY_JSON_MAX - *used);
    if (n < 0 || (size_t)n > OCI_POLICY_JSON_MAX - *used) goto fail;
    if (!n) break;
    *used += (size_t)n;
  }
  if (oci_host_path_close_fd(p, &p->outgoing[stage]) < 0) goto fail;
  int left = oci_egress_left(deadline);
  if (left < 0 || oci_host_path_join(p, stage, left) < 0 || !p->ok[stage] || oci_host_path_current(p, cleaning) < 0) goto fail;
  return 0;
fail:
  p->unknown = 1; if (!errno) errno = EPROTO; return -1;
}
static int oci_host_path_install(struct oci_uplink_owner *u) {
  if (!u || u->host_path || !u->pair_known || !u->create_known || u->configured ||
      !u->lock_held || oci_uplink_original(u) < 0 || oci_uplink_pair(u) < 0) { if (!errno) errno = EALREADY; return -1; }
  struct oci_host_path_owner *p = calloc(1, sizeof(*p));
  if (!p) return -1;
  u->host_path = p; p->uplink = u; p->controller = getpid(); p->creator = u->creator; p->cookie = u->host_cookie;
  p->host_index = u->host_index; p->guest_index = u->guest_index; p->uplink_index = u->expected.index;
  memcpy(p->claim, u->original->id, sizeof(p->claim)); memcpy(p->host_name, u->host_name, 16); memcpy(p->uplink_name, u->expected.name, 16);
  for (unsigned int i = 0; i < OCI_HOST_PATH_STAGES; ++i) p->pidfd[i] = p->incoming[i] = p->outgoing[i] = -1;
  if (oci_host_path_current(p, 0) < 0 || oci_host_path_program(p) < 0) { p->unknown = 1; return -1; }
  char *output = malloc(OCI_POLICY_JSON_MAX); if (!output) { p->unknown = 1; return -1; }
  int result = -1; int64_t now = oci_now(); if (now < 0) goto done;
  int64_t deadline = now + 10000; size_t used = 0;
  if (oci_host_path_command(p, 0, deadline, output, &used) < 0 || used ||
      oci_host_path_command(p, 1, deadline, output, &used) < 0 || oci_host_path_readback(p, output, used, 1) < 0 ||
      oci_host_path_command(p, 2, deadline, output, &used) < 0 || oci_host_path_readback(p, output, used, 0) < 0 ||
      oci_host_path_current(p, 0) < 0) goto done;
  p->verified = 1; result = 0;
done:
  free(output); if (result < 0) { p->unknown = 1; if (!errno) errno = EPROTO; } return result;
}
static int oci_host_path_close(struct oci_uplink_owner *u) {
  struct oci_host_path_owner *p = u ? u->host_path : NULL;
  if (!p) return 0;
  if (p->uplink != u || p->controller != getpid() || u->controller != getpid() || u->original->controller_pid != getpid()) { errno = EPERM; return -1; }
  for (unsigned int i = 0; i < OCI_HOST_PATH_STAGES; ++i) {
    if (p->pid[i] && !p->joined[i]) {
      if (!p->killed[i]) {
        p->killed[i] = 1;
        if (syscall(SYS_pidfd_send_signal, p->pidfd[i], SIGKILL, NULL, 0) < 0 && errno != ESRCH) p->unknown = 1;
      }
      if (oci_host_path_join(p, i, 1000) < 0) return -1;
    }
    if (oci_host_path_close_fd(p, &p->incoming[i]) < 0 || oci_host_path_close_fd(p, &p->outgoing[i]) < 0) return -1;
  }
  if (p->pid[1]) {
    if (p->unknown || p->close_unknown || !p->verified || !p->handle || !p->ok[1] || oci_host_path_current(p, 1) < 0) { errno = EUCLEAN; return -1; }
    if (!p->removed) {
      char *output = malloc(OCI_POLICY_JSON_MAX); if (!output) return -1;
      int result = -1; int64_t now = oci_now(); size_t used = 0;
      if (now >= 0 && oci_policy_format(p->deletion, sizeof(p->deletion), "delete table inet handle %llu\n", (unsigned long long)p->handle) == 0) {
        p->deletion_size = strlen(p->deletion);
        if (oci_host_path_command(p, 3, now + 10000, output, &used) == 0 && oci_host_path_tables(p, output, used, 1) == 0 &&
            oci_host_path_command(p, 4, now + 10000, output, &used) == 0 && !used &&
            oci_host_path_command(p, 5, now + 10000, output, &used) == 0 && oci_host_path_tables(p, output, used, 0) == 0 &&
            oci_host_path_current(p, 1) == 0) { p->removed = 1; result = 0; }
      }
      free(output); if (result < 0) { p->unknown = 1; if (!errno) errno = EPROTO; return -1; }
    }
  }
  for (unsigned int i = 0; i < OCI_HOST_PATH_STAGES; ++i) {
    if (p->pid[i] && !p->joined[i]) { errno = EUCLEAN; return -1; }
    if (oci_host_path_close_fd(p, &p->pidfd[i]) < 0) return -1;
  }
  if (p->close_unknown) { errno = EUCLEAN; return -1; }
  explicit_bzero(p, sizeof(*p)); free(p); u->host_path = NULL; return 0;
}
#include "docker-container-terminal-oci-policy-read.h"
#endif
