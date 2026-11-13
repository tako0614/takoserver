#ifndef TAKOS_DOCKER_GUEST_DRAIN_H
#define TAKOS_DOCKER_GUEST_DRAIN_H
#include <linux/netlink.h>
#include <linux/netfilter/nfnetlink_conntrack.h>

/* This is a complete, unfiltered conntrack DUMP observation, NOT a packet
 * quiescence barrier. In-flight pre-fence packets and flow offload are not
 * discharged by nft's transaction ACK or NLMSG_DONE. No terminal drain grant
 * is produced, including when all four observed counts happen to be zero. */
typedef struct {
  uint32_t sequence, port;
  unsigned char family;
  bool done, failed;
  uint64_t tcp, udp;
  size_t bytes;
} gd_dump;
typedef struct { const unsigned char *value; size_t size; unsigned flags; } gd_attr;

/* Copy headers rather than dereferencing potentially unaligned wire bytes.
 * Legacy nfnetlink nests may omit NLA_F_NESTED; both encodings are accepted.
 * Unknown/duplicate attributes or malformed nested lengths are refusals. */
static bool gd_attrs(const unsigned char *bytes, size_t size, gd_attr *fields, unsigned max) {
  size_t at = 0;
  while (at < size) {
    struct nlattr h;
    if (size - at < sizeof(h)) return false;
    memcpy(&h, bytes + at, sizeof(h));
    unsigned type = h.nla_type & NLA_TYPE_MASK;
    size_t aligned = NLA_ALIGN((size_t)h.nla_len);
    if (h.nla_len < sizeof(h) || aligned > size - at || type == 0 || type > max || fields[type].value ||
        ((h.nla_type & NLA_F_NESTED) && (h.nla_type & NLA_F_NET_BYTEORDER))) return false;
    fields[type] = (gd_attr){bytes + at + sizeof(h), h.nla_len - sizeof(h), h.nla_type & ~NLA_TYPE_MASK};
    at += aligned;
  }
  return at == size;
}
static bool gd_leaf(gd_attr a, size_t size) {
  return a.value && a.size == size && !(a.flags & NLA_F_NESTED);
}
static bool gd_nest(gd_attr a) { return a.value && !(a.flags & NLA_F_NET_BYTEORDER); }
static bool gd_tuple(gd_attr tuple, unsigned char family, unsigned char *protocol) {
  gd_attr t[CTA_TUPLE_MAX + 1] = {0}, ip[CTA_IP_MAX + 1] = {0}, p[CTA_PROTO_MAX + 1] = {0};
  if (!gd_nest(tuple) || !gd_attrs(tuple.value, tuple.size, t, CTA_TUPLE_MAX) ||
      !gd_nest(t[CTA_TUPLE_IP]) || !gd_nest(t[CTA_TUPLE_PROTO]) ||
      !gd_attrs(t[CTA_TUPLE_IP].value, t[CTA_TUPLE_IP].size, ip, CTA_IP_MAX) ||
      !gd_attrs(t[CTA_TUPLE_PROTO].value, t[CTA_TUPLE_PROTO].size, p, CTA_PROTO_MAX)) return false;
  unsigned src = family == AF_INET ? CTA_IP_V4_SRC : CTA_IP_V6_SRC;
  unsigned dst = family == AF_INET ? CTA_IP_V4_DST : CTA_IP_V6_DST;
  size_t width = family == AF_INET ? 4 : 16;
  for (unsigned i = 1; i <= CTA_IP_MAX; i++)
    if (ip[i].value && (i != src && i != dst)) return false;
  if (!gd_leaf(ip[src], width) || !gd_leaf(ip[dst], width) || !gd_leaf(p[CTA_PROTO_NUM], 1) ||
      !gd_leaf(p[CTA_PROTO_SRC_PORT], 2) || !gd_leaf(p[CTA_PROTO_DST_PORT], 2)) return false;
  for (unsigned i = 1; i <= CTA_PROTO_MAX; i++)
    if (p[i].value && i != CTA_PROTO_NUM && i != CTA_PROTO_SRC_PORT && i != CTA_PROTO_DST_PORT) return false;
  if (t[CTA_TUPLE_ZONE].value && !gd_leaf(t[CTA_TUPLE_ZONE], 2)) return false;
  *protocol = p[CTA_PROTO_NUM].value[0];
  return *protocol == IPPROTO_TCP || *protocol == IPPROTO_UDP;
}
enum { GD_COUNTERS, GD_TIMESTAMP, GD_TCP, GD_SEQADJ, GD_SYNPROXY };
/* Ancillary values never filter a record. Validate their supported wire
 * schemas as well; unsupported extensions refuse the entire observation. */
static bool gd_scalars(gd_attr nest, unsigned kind) {
  if (!gd_nest(nest)) return false;
  const unsigned char *bytes = nest.value; size_t size = nest.size;
  uint64_t seen = 0;
  size_t at = 0;
  while (at < size) {
    struct nlattr h;
    if (size - at < sizeof(h)) return false;
    memcpy(&h, bytes + at, sizeof(h));
    size_t aligned = NLA_ALIGN((size_t)h.nla_len);
    unsigned type = h.nla_type & NLA_TYPE_MASK; size_t width = 0; bool pad = false;
    if (kind == GD_COUNTERS) {
      if (type == CTA_COUNTERS_PACKETS || type == CTA_COUNTERS_BYTES) width = 8;
      else if (type == CTA_COUNTERS32_PACKETS || type == CTA_COUNTERS32_BYTES) width = 4;
      else if (type == CTA_COUNTERS_PAD) pad = true;
      else return false;
    } else if (kind == GD_TIMESTAMP) {
      if (type == CTA_TIMESTAMP_START || type == CTA_TIMESTAMP_STOP) width = 8;
      else if (type == CTA_TIMESTAMP_PAD) pad = true;
      else return false;
    } else if (kind == GD_TCP) {
      if (type == CTA_PROTOINFO_TCP_STATE || type == CTA_PROTOINFO_TCP_WSCALE_ORIGINAL || type == CTA_PROTOINFO_TCP_WSCALE_REPLY) width = 1;
      else if (type == CTA_PROTOINFO_TCP_FLAGS_ORIGINAL || type == CTA_PROTOINFO_TCP_FLAGS_REPLY) width = 2;
      else return false;
    } else if (kind == GD_SEQADJ) {
      if (type < CTA_SEQADJ_CORRECTION_POS || type > CTA_SEQADJ_OFFSET_AFTER) return false;
      width = 4;
    } else if (kind == GD_SYNPROXY) {
      if (type < CTA_SYNPROXY_ISN || type > CTA_SYNPROXY_TSOFF) return false;
      width = 4;
    } else return false;
    if (h.nla_len != sizeof(h) + width || aligned > size - at || (h.nla_type & NLA_F_NESTED) || (pad && (h.nla_type & NLA_F_NET_BYTEORDER)) ||
        type >= 64 || (!pad && (seen & (1ULL << type)))) return false;
    if (!pad) seen |= 1ULL << type;
    at += aligned;
  }
  uint64_t required = kind == GD_COUNTERS ? (1ULL << CTA_COUNTERS_PACKETS) | (1ULL << CTA_COUNTERS_BYTES) :
    kind == GD_TIMESTAMP ? 1ULL << CTA_TIMESTAMP_START : kind == GD_TCP ? 1ULL << CTA_PROTOINFO_TCP_STATE :
    kind == GD_SEQADJ ? (1ULL << CTA_SEQADJ_CORRECTION_POS) | (1ULL << CTA_SEQADJ_OFFSET_BEFORE) | (1ULL << CTA_SEQADJ_OFFSET_AFTER) :
    (1ULL << CTA_SYNPROXY_ISN) | (1ULL << CTA_SYNPROXY_ITS) | (1ULL << CTA_SYNPROXY_TSOFF);
  return at == size && (seen & required) == required;
}
static bool gd_record(gd_dump *dump, const unsigned char *bytes, size_t size) {
  struct nfgenmsg gen;
  if (size < sizeof(gen)) return false;
  memcpy(&gen, bytes, sizeof(gen));
  if (gen.nfgen_family != dump->family || gen.version != NFNETLINK_V0 || gen.res_id != 0) return false;
  gd_attr fields[CTA_MAX + 1] = {0};
  if (!gd_attrs(bytes + sizeof(gen), size - sizeof(gen), fields, CTA_MAX)) return false;
  unsigned char original, reply_protocol;
  if (!gd_tuple(fields[CTA_TUPLE_ORIG], dump->family, &original) ||
      !gd_tuple(fields[CTA_TUPLE_REPLY], dump->family, &reply_protocol) || original != reply_protocol ||
      !gd_leaf(fields[CTA_STATUS], 4)) return false;
  for (unsigned i = 1; i <= CTA_MAX; i++) {
    gd_attr a = fields[i];
    if (!a.value) continue;
    if (i == CTA_TUPLE_ORIG || i == CTA_TUPLE_REPLY) continue;
    if (i == CTA_TUPLE_MASTER) {
      unsigned char master;
      if (!gd_tuple(a, dump->family, &master)) return false;
    } else if (i == CTA_STATUS || i == CTA_TIMEOUT || i == CTA_MARK || i == CTA_USE || i == CTA_ID ||
               i == CTA_SECMARK || i == CTA_STATUS_MASK) {
      if (!gd_leaf(a, 4)) return false;
    } else if (i == CTA_ZONE) {
      if (!gd_leaf(a, 2)) return false;
    } else if (i == CTA_LABELS || i == CTA_LABELS_MASK) {
      if (!gd_leaf(a, 16)) return false;
    } else if (i == CTA_COUNTERS_ORIG || i == CTA_COUNTERS_REPLY) {
      if (!gd_scalars(a, GD_COUNTERS)) return false;
    } else if (i == CTA_TIMESTAMP) {
      if (!gd_scalars(a, GD_TIMESTAMP)) return false;
    } else if (i == CTA_SEQ_ADJ_ORIG || i == CTA_SEQ_ADJ_REPLY) {
      if (!gd_scalars(a, GD_SEQADJ)) return false;
    } else if (i == CTA_SYNPROXY) {
      if (!gd_scalars(a, GD_SYNPROXY)) return false;
    } else if (i == CTA_PROTOINFO) {
      gd_attr info[CTA_PROTOINFO_MAX + 1] = {0};
      if (original != IPPROTO_TCP || !gd_nest(a) || !gd_attrs(a.value, a.size, info, CTA_PROTOINFO_MAX) ||
          !gd_scalars(info[CTA_PROTOINFO_TCP], GD_TCP)) return false;
      for (unsigned j = 1; j <= CTA_PROTOINFO_MAX; j++) if (j != CTA_PROTOINFO_TCP && info[j].value) return false;
    } else if (i == CTA_SECCTX) {
      gd_attr context[CTA_SECCTX_MAX + 1] = {0};
      if (!gd_nest(a) || !gd_attrs(a.value, a.size, context, CTA_SECCTX_MAX)) return false;
      gd_attr name = context[CTA_SECCTX_NAME];
      if (!name.value || name.flags || !name.size || name.size > 4096 || name.value[name.size - 1] || memchr(name.value, 0, name.size - 1)) return false;
    } else return false;
  }
  uint64_t *count = original == IPPROTO_TCP ? &dump->tcp : &dump->udp;
  if (*count >= 1000000) return false;
  (*count)++; return true;
}
static bool gd_feed(gd_dump *dump, const unsigned char *bytes, size_t size, bool truncated,
                    uint32_t sender_port, uint32_t sender_groups) {
  if (dump->failed || dump->done || truncated || sender_port || sender_groups || !size ||
      dump->bytes > 64 * 1024 * 1024 || size > 64 * 1024 * 1024 - dump->bytes ||
      (dump->family != AF_INET && dump->family != AF_INET6) || !dump->sequence || !dump->port) goto bad;
  dump->bytes += size;
  size_t at = 0;
  while (at < size) {
    struct nlmsghdr h;
    if (size - at < sizeof(h)) goto bad;
    memcpy(&h, bytes + at, sizeof(h));
    size_t aligned = NLMSG_ALIGN((size_t)h.nlmsg_len);
    if (h.nlmsg_len < sizeof(h) || aligned > size - at || h.nlmsg_seq != dump->sequence ||
        h.nlmsg_pid != dump->port || !(h.nlmsg_flags & NLM_F_MULTI) ||
        (h.nlmsg_flags & ~(NLM_F_MULTI | NLM_F_DUMP_FILTERED)) || dump->done) goto bad;
    const unsigned char *body = bytes + at + sizeof(h);
    size_t length = h.nlmsg_len - sizeof(h);
    if (h.nlmsg_type == NLMSG_DONE) {
      int error;
      if (length != sizeof(error)) goto bad;
      memcpy(&error, body, sizeof(error));
      if (error || at + aligned != size) goto bad;
      dump->done = true;
    } else if (h.nlmsg_type != ((NFNL_SUBSYS_CTNETLINK << 8) | IPCTNL_MSG_CT_NEW) ||
               !gd_record(dump, body, length)) goto bad;
    at += aligned;
  }
  return at == size;
bad:
  dump->failed = true; return false;
}

/* This builder accepts only the already selected native table identity. It
 * creates a distinct table exclusively; no flush/delete/replace touches the
 * original enforcement rules, quota, counters or lifetime deny. */
static bool gd_script(const char *base, char *script, size_t capacity, size_t *length) {
  size_t used = 0, size = strlen(base);
  if (size < 10 || size > 49 || strncmp(base, "takos_cx_", 9)) return false;
  for (size_t i = 9; i < size; i++)
    if (!((base[i] >= 'a' && base[i] <= 'z') || (base[i] >= 'A' && base[i] <= 'Z') ||
          (base[i] >= '0' && base[i] <= '9') || base[i] == '_' || base[i] == '-')) return false;
  int n = snprintf(script, capacity, "create table inet %s_drain\n", base);
  if (n < 0 || (size_t)n >= capacity) return false;
  used = (size_t)n;
  const char *hooks[] = {"input", "output", "forward"};
  for (unsigned i = 0; i < 3; i++) {
    n = snprintf(script + used, capacity - used,
      "create chain inet %s_drain %s { type filter hook %s priority -199; policy accept; }\n"
      "add rule inet %s_drain %s meta l4proto != { tcp, udp } drop comment \"takos_drain_protocol\"\n"
      "add rule inet %s_drain %s ct state != established drop comment \"takos_drain_state\"\n"
      "add rule inet %s_drain %s tcp flags & syn == syn drop comment \"takos_drain_syn\"\n",
      base, hooks[i], hooks[i], base, hooks[i], base, hooks[i], base, hooks[i]);
    if (n < 0 || (size_t)n >= capacity - used) return false;
    used += (size_t)n;
  }
  *length = used; return true;
}

#ifndef TAKOS_DRAIN_PARSER_ONLY
/* Fixed-rule projection. Refuse additional tables/chains/rules/expressions;
 * nft metadata/handles are allowed but never used as authority. */
static bool gd_keys(const di_parser *p, int object, const char *const keys[], unsigned count) {
  if (object < 0 || p->nodes[object].kind != '{') return false;
  unsigned actual = 0;
  for (int key = p->nodes[object].child; key >= 0 && key < p->nodes[object].next;) {
    bool found = false;
    for (unsigned i = 0; i < count; i++) if (di_key(p, key, keys[i])) found = true;
    if (!found) return false;
    actual++; key = p->nodes[p->nodes[key].next].next;
  }
  if (actual != count) return false;
  for (unsigned i = 0; i < count; i++) if (di_field(p, object, keys[i]) < 0) return false;
  return true;
}
static bool gd_object(const di_parser *p, int object, const char *key) {
  const char *const keys[] = {key}; return gd_keys(p, object, keys, 1);
}
static bool gd_text(const di_parser *p, int object, const char *key, const char *value) {
  return gd_object(p, object, key) && di_equal_text(p, di_field(p, object, key), value);
}
static bool gd_match(const di_parser *p, int item, unsigned rule) {
  if (!gd_object(p, item, "match")) return false;
  int match = di_field(p, item, "match"), left = di_field(p, match, "left"), right = di_field(p, match, "right");
  const char *const keys[] = {"op", "left", "right"};
  if (!gd_keys(p, match, keys, 3) || !di_equal_text(p, di_field(p, match, "op"), rule == 2 ? "==" : "!=")) return false;
  if (rule == 0) {
    if (!gd_object(p, left, "meta") || !gd_text(p, di_field(p, left, "meta"), "key", "l4proto") || !gd_object(p, right, "set")) return false;
    int set = di_field(p, right, "set"), tcp = p->nodes[set].child;
    if (p->nodes[set].kind != '[' || tcp < 0) return false;
    int udp = p->nodes[tcp].next;
    return udp < p->nodes[set].next && p->nodes[udp].next == p->nodes[set].next &&
      di_equal_text(p, tcp, "tcp") && di_equal_text(p, udp, "udp");
  }
  if (rule == 1)
    return gd_object(p, left, "ct") && gd_text(p, di_field(p, left, "ct"), "key", "state") && di_equal_text(p, right, "established");
  if (!gd_object(p, left, "&") || !di_equal_text(p, right, "syn")) return false;
  int operands = di_field(p, left, "&"), payload = p->nodes[operands].child;
  if (p->nodes[operands].kind != '[' || payload < 0) return false;
  int syn = p->nodes[payload].next;
  if (syn >= p->nodes[operands].next || p->nodes[syn].next != p->nodes[operands].next ||
      !di_equal_text(p, syn, "syn") || !gd_object(p, payload, "payload")) return false;
  const char *const payload_keys[] = {"protocol", "field"};
  int field = di_field(p, payload, "payload");
  return gd_keys(p, field, payload_keys, 2) && di_equal_text(p, di_field(p, field, "protocol"), "tcp") &&
    di_equal_text(p, di_field(p, field, "field"), "flags");
}
static bool gd_fence(const unsigned char *bytes, size_t size, const char *table) {
  di_node *nodes = calloc(DI_TOKENS, sizeof(*nodes)); if (!nodes) return false;
  di_parser p = {.s = bytes, .size = size, .nodes = nodes, .until = di_clock() + 500};
  int root = di_value(&p, 0); di_space(&p); bool ok = false, seen_table = false, chains[3] = {false}; unsigned rules[3] = {0};
  if (root != 0 || p.at != size || !gd_object(&p, 0, "nftables")) goto finish;
  int list = di_field(&p, 0, "nftables"); if (nodes[list].kind != '[') goto finish;
  const char *hooks[] = {"input", "output", "forward"};
  for (int item = nodes[list].child; item >= 0 && item < nodes[list].next; item = nodes[item].next) {
    if (gd_object(&p, item, "metainfo")) continue;
    int value;
    if (gd_object(&p, item, "table")) {
      value = di_field(&p, item, "table"); const char *const keys[] = {"family", "name", "handle"};
      if (seen_table || !gd_keys(&p, value, keys, 3) || !di_equal_text(&p, di_field(&p, value, "family"), "inet") ||
          !di_equal_text(&p, di_field(&p, value, "name"), table)) goto finish;
      seen_table = true; continue;
    }
    bool chain = gd_object(&p, item, "chain"), rule = gd_object(&p, item, "rule");
    if (!chain && !rule) goto finish;
    value = di_field(&p, item, chain ? "chain" : "rule");
    if (!di_equal_text(&p, di_field(&p, value, "family"), "inet") || !di_equal_text(&p, di_field(&p, value, "table"), table)) goto finish;
    unsigned index = 3;
    for (unsigned i = 0; i < 3; i++) if (di_equal_text(&p, di_field(&p, value, chain ? "name" : "chain"), hooks[i])) index = i;
    if (index >= 3) goto finish;
    if (chain) {
      const char *const keys[] = {"family", "table", "name", "handle", "type", "hook", "prio", "policy"};
      int priority = di_field(&p, value, "prio");
      if (chains[index] || !gd_keys(&p, value, keys, 8) || !di_equal_text(&p, di_field(&p, value, "type"), "filter") ||
          !di_equal_text(&p, di_field(&p, value, "hook"), hooks[index]) || !di_equal_text(&p, di_field(&p, value, "policy"), "accept") ||
          priority < 0 || nodes[priority].kind != 'd' || nodes[priority].end - nodes[priority].start != 4 ||
          memcmp(bytes + nodes[priority].start, "-199", 4)) goto finish;
      chains[index] = true; continue;
    }
    const char *const keys[] = {"family", "table", "chain", "handle", "expr", "comment"};
    const char *comments[] = {"takos_drain_protocol", "takos_drain_state", "takos_drain_syn"};
    unsigned number = rules[index]; int expr = di_field(&p, value, "expr");
    if (!chains[index] || number >= 3 || !gd_keys(&p, value, keys, 6) ||
        !di_equal_text(&p, di_field(&p, value, "comment"), comments[number]) || expr < 0 || nodes[expr].kind != '[') goto finish;
    int match = nodes[expr].child;
    if (match < 0) goto finish;
    int drop = nodes[match].next;
    if (drop >= nodes[expr].next || nodes[drop].next != nodes[expr].next || !gd_match(&p, match, number) ||
        !gd_object(&p, drop, "drop") || nodes[di_field(&p, drop, "drop")].kind != 'n') goto finish;
    rules[index]++;
  }
  ok = seen_table && di_live(&p);
  for (unsigned i = 0; i < 3; i++) ok = ok && chains[i] && rules[i] == 3;
finish:
  free(nodes); return ok;
}
#ifndef TAKOS_DRAIN_FENCE_ONLY
static bool guest_drain_attempted, guest_drain_fenced;
/* One deadline per command, shared by fence readback, socket handoff and both
 * family dumps. Existing original currentness/native subprocess checks have
 * their own bounded IO; overruns refuse rather than renew this deadline. */
static bool gd_current(int64_t until) {
  int64_t now = clock_ms();
  return now >= 0 && now < until && selected_current() && clock_ms() < until;
}
static bool gd_read_fence(int64_t until) {
  if (!gd_current(until)) return false;
  char table[80]; snprintf(table, sizeof(table), "%s_drain", table_name);
  char *argv[] = {(char *)nft_binary, "-j", "-a", "list", "table", "inet", table, NULL};
  unsigned char *bytes = NULL; size_t size = 0;
  bool ok = capture_native(argv, NULL, 0, &bytes, &size) && gd_current(until) && gd_fence(bytes, size, table) && gd_current(until);
  free(bytes); return ok;
}
/* A child creates only a netlink socket in the held original guest namespace,
 * then passes that FD back. The controller never changes its own namespace;
 * every send/recv is bracketed by its original selected_current(), including
 * original daemon peer, guest pidfd/NSFS, identity and Host inventory checks. */
static int gd_socket(int64_t until) {
  if (!gd_current(until)) return -1;
  int channel[2]; if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, channel)) return -1;
  pid_t controller = getpid(), child = fork();
  if (child == 0) {
    close(channel[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != controller || !gd_current(until) ||
        setns(guest_netns, CLONE_NEWNET) || !gd_current(until)) _exit(125);
    int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC | SOCK_NONBLOCK, NETLINK_NETFILTER);
    struct sockaddr_nl local = {.nl_family = AF_NETLINK};
    if (fd < 0 || !gd_current(until) || bind(fd, (struct sockaddr *)&local, sizeof(local)) || !gd_current(until)) _exit(125);
    char byte = 'N'; struct iovec iov = {.iov_base = &byte, .iov_len = 1};
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
    struct cmsghdr *c = CMSG_FIRSTHDR(&message); c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &fd, sizeof(fd));
    _exit(sendmsg(channel[1], &message, MSG_NOSIGNAL) == 1 ? 0 : 125);
  }
  close(channel[1]); int fd = -1, status = 0; bool reaped = false;
  if (child > 0 && gd_current(until) && wait_io(channel[0], POLLIN, until) && gd_current(until)) {
    char byte; struct iovec iov = {.iov_base = &byte, .iov_len = 1};
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
    ssize_t got = recvmsg(channel[0], &message, MSG_CMSG_CLOEXEC | MSG_DONTWAIT);
    struct cmsghdr *c = CMSG_FIRSTHDR(&message);
    int received = -1;
    if (c && c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS &&
        c->cmsg_len == CMSG_LEN(sizeof(int)) && !CMSG_NXTHDR(&message, c)) memcpy(&received, CMSG_DATA(c), sizeof(received));
    /* Linux reports the requested MSG_CMSG_CLOEXEC in msg_flags too; every
     * actual truncation/other receive flag still refuses the descriptor. */
    if (got == 1 && byte == 'N' && !(message.msg_flags & ~MSG_CMSG_CLOEXEC) && gd_current(until)) fd = received;
    else if (received >= 0) close(received);
  }
  close(channel[0]);
  while (child > 0 && clock_ms() < until) {
    pid_t got = waitpid(child, &status, WNOHANG);
    if (got == child) { reaped = true; break; }
    if (got < 0) break;
    struct timespec pause = {.tv_nsec = 1000000}; nanosleep(&pause, NULL);
  }
  if (child > 0 && !reaped) { kill(child, SIGKILL); while (waitpid(child, &status, 0) < 0 && errno == EINTR) {} }
  if (!reaped || !WIFEXITED(status) || WEXITSTATUS(status) || !gd_current(until)) { if (fd >= 0) close(fd); return -1; }
  return fd;
}
static bool gd_collect(unsigned char family, uint32_t sequence, gd_dump *result, int64_t until) {
  int fd = gd_socket(until); if (fd < 0) return false;
  struct sockaddr_nl local = {0}; socklen_t local_size = sizeof(local);
  bool ok = gd_current(until) && !getsockname(fd, (struct sockaddr *)&local, &local_size) && local_size == sizeof(local) &&
    local.nl_family == AF_NETLINK && local.nl_pid && !local.nl_groups && gd_current(until);
  struct { struct nlmsghdr header; struct nfgenmsg gen; } request = {
    .header = {.nlmsg_len = sizeof(request), .nlmsg_type = (NFNL_SUBSYS_CTNETLINK << 8) | IPCTNL_MSG_CT_GET,
      .nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP, .nlmsg_seq = sequence, .nlmsg_pid = local.nl_pid},
    .gen = {.nfgen_family = family, .version = NFNETLINK_V0, .res_id = 0}};
  struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
  ok = ok && gd_current(until) && sendto(fd, &request, sizeof(request), MSG_DONTWAIT,
    (struct sockaddr *)&kernel, sizeof(kernel)) == sizeof(request) && gd_current(until);
  gd_dump dump = {.sequence = sequence, .port = local.nl_pid, .family = family};
  unsigned char *bytes = malloc(262144); if (!bytes) ok = false;
  while (ok && !dump.done) {
    if (!gd_current(until) || !wait_io(fd, POLLIN, until) || !gd_current(until)) { ok = false; break; }
    struct sockaddr_nl sender = {0}; struct iovec iov = {.iov_base = bytes, .iov_len = 262144};
    struct msghdr message = {.msg_name = &sender, .msg_namelen = sizeof(sender), .msg_iov = &iov, .msg_iovlen = 1};
    ssize_t size = recvmsg(fd, &message, MSG_DONTWAIT);
    /* No retry after ENOBUFS, EINTR, truncation, malformed or interrupted dump.
     * A caller may start a fresh observation, never reuse these partial counts. */
    ok = gd_current(until) && size > 0 && message.msg_namelen == sizeof(sender) && sender.nl_family == AF_NETLINK &&
      !message.msg_flags && gd_feed(&dump, bytes, (size_t)(size > 0 ? size : 0), false, sender.nl_pid, sender.nl_groups);
  }
  free(bytes); close(fd);
  ok = ok && dump.done && !dump.failed && gd_current(until);
  if (ok) *result = dump;
  return ok;
}
static bool gd_reply(const char *kind, const gd_dump *v4, const gd_dump *v6, int64_t until) {
  if (!gd_current(until)) return refusal("drain_currentness_unavailable");
  char body[768], counts[160] = "";
  if (v4 && v6) snprintf(counts, sizeof(counts), ",\"tcp4\":%llu,\"udp4\":%llu,\"tcp6\":%llu,\"udp6\":%llu",
    (unsigned long long)v4->tcp, (unsigned long long)v4->udp, (unsigned long long)v6->tcp, (unsigned long long)v6->udp);
  int n = snprintf(body, sizeof(body),
    "{\"kind\":\"%s\",\"nativeId\":\"%s\",\"namespaceDevice\":\"%llu\",\"namespaceInode\":\"%llu\","
    "\"fenceTable\":\"%s_drain\",\"barrier\":\"unproven\"%s}", kind, selected_native_id,
    (unsigned long long)guest_namespace_stat.st_dev, (unsigned long long)guest_namespace_stat.st_ino, table_name, counts);
  return n > 0 && (size_t)n < sizeof(body) && gd_current(until) ? reply(0, body, (size_t)n) : refusal("drain_currentness_unavailable");
}
static bool guest_drain_begin(void) {
  int64_t until = clock_ms() + IO_MS;
  if (!native_mode || !guest_mode || quarantine_control || !guest_fail_closed || !guest_watch_armed ||
      guest_drain_attempted || !gd_current(until)) return refusal("drain_begin_refused");
  char script[4096]; size_t length = 0;
  if (!gd_script(table_name, script, sizeof(script), &length) || !gd_current(until)) return refusal("drain_begin_refused");
  /* Consume before the first effect. No lost ACK or failed readback permits
   * another attempt or later RESUMEGUEST/caller-provided NFTAPPLY. */
  guest_drain_attempted = true;
  char *argv[] = {(char *)nft_binary, "-f", "-", NULL}; unsigned char *bytes = NULL; size_t size = 0;
  bool ok = gd_current(until) && capture_native(argv, script, length, &bytes, &size) && gd_current(until); free(bytes);
  if (!ok || !gd_read_fence(until) || !gd_current(until)) return refusal("drain_begin_outcome_unknown");
  guest_drain_fenced = true;
  return gd_reply("docker-guest-drain-fence@1", NULL, NULL, until);
}
static bool guest_drain_read(void) {
  int64_t until = clock_ms() + IO_MS;
  if (!native_mode || !guest_mode || !guest_drain_fenced || !gd_current(until) || !gd_read_fence(until)) return refusal("drain_read_refused");
  gd_dump v4, v6;
  if (!gd_collect(AF_INET, 1, &v4, until) || !gd_collect(AF_INET6, 2, &v6, until) || !gd_read_fence(until) || !gd_current(until))
    return refusal("drain_flow_collection_unavailable");
  return gd_reply("docker-guest-flow-snapshot@1", &v4, &v6, until);
}
#endif
#endif
#endif
