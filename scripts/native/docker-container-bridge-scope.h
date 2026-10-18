#ifndef TAKOS_DOCKER_BRIDGE_SCOPE_H
#define TAKOS_DOCKER_BRIDGE_SCOPE_H
#include <linux/if_link.h>
#include <linux/if_addr.h>
#include <linux/rtnetlink.h>

/* No caller-selected interface, table, script or command. An original network
 * ID is resolved through the pinned daemon. Actual rtnetlink facts are read in
 * its held namespace, then retained and checked around every scoped operation. */
typedef struct {
  char name[16], mac[18], addresses[8][INET6_ADDRSTRLEN];
  unsigned ifindex, count;
} db_binding;
static db_binding bridge_binding;
static bool bridge_mode, bridge_install_attempted;
static char bridge_script[MAX_SCRIPT + 1];
static size_t bridge_script_size;

static bool db_receive(int fd, void *bytes, size_t size, int64_t until, ssize_t *used) {
  if (!wait_io(fd, POLLIN, until)) return false;
  struct sockaddr_nl source = {0};
  struct iovec vector = {.iov_base = bytes, .iov_len = size};
  struct msghdr message = {.msg_name = &source, .msg_namelen = sizeof(source), .msg_iov = &vector, .msg_iovlen = 1};
  *used = recvmsg(fd, &message, MSG_DONTWAIT | MSG_TRUNC);
  return *used > 0 && (size_t)*used <= size && !(message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) &&
    message.msg_namelen == sizeof(source) && source.nl_family == AF_NETLINK && source.nl_pid == 0 && source.nl_groups == 0;
}
static bool db_attributes(struct rtattr *at, int size, db_binding *out) {
  bool name = false, mac = false, kind = false;
  for (; RTA_OK(at, size); at = RTA_NEXT(at, size)) {
    int length = RTA_PAYLOAD(at);
    if (at->rta_type == IFLA_IFNAME) {
      if (name || length < 2 || length > 16 || ((char *)RTA_DATA(at))[length - 1] ||
        strlen(RTA_DATA(at)) != (size_t)length - 1) return false;
      name = true; strcpy(out->name, RTA_DATA(at));
    } else if (at->rta_type == IFLA_ADDRESS) {
      if (mac || length != 6) return false;
      unsigned char *b = RTA_DATA(at);
      if ((b[0] & 1) || !(b[0] | b[1] | b[2] | b[3] | b[4] | b[5])) return false;
      snprintf(out->mac, sizeof(out->mac), "%02x:%02x:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3], b[4], b[5]); mac = true;
    } else if (at->rta_type == IFLA_LINKINFO) {
      int nested = length; struct rtattr *info = RTA_DATA(at);
      for (; RTA_OK(info, nested); info = RTA_NEXT(info, nested)) if (info->rta_type == IFLA_INFO_KIND) {
        if (kind || RTA_PAYLOAD(info) != 7 || memcmp(RTA_DATA(info), "bridge", 7)) return false;
        kind = true;
      }
      if (nested) return false;
    }
  }
  return size == 0 && name && mac && kind;
}
static bool db_link(int fd, const char *name, db_binding *out) {
  struct { struct nlmsghdr h; struct ifinfomsg link; char attr[64]; } request = {
    .h = {.nlmsg_len = NLMSG_LENGTH(sizeof(struct ifinfomsg)), .nlmsg_type = RTM_GETLINK,
      .nlmsg_flags = NLM_F_REQUEST, .nlmsg_seq = 1}, .link = {.ifi_family = AF_UNSPEC}};
  struct rtattr *attr = (struct rtattr *)((char *)&request + NLMSG_ALIGN(request.h.nlmsg_len));
  attr->rta_type = IFLA_IFNAME; attr->rta_len = RTA_LENGTH(strlen(name) + 1);
  memcpy(RTA_DATA(attr), name, strlen(name) + 1); request.h.nlmsg_len = NLMSG_ALIGN(request.h.nlmsg_len) + RTA_ALIGN(attr->rta_len);
  struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
  if (sendto(fd, &request, request.h.nlmsg_len, 0, (struct sockaddr *)&kernel, sizeof(kernel)) != (ssize_t)request.h.nlmsg_len) return false;
  char bytes[65536]; ssize_t got;
  if (!db_receive(fd, bytes, sizeof(bytes), clock_ms() + IO_MS, &got)) return false;
  int left = (int)got; bool found = false;
  for (struct nlmsghdr *h = (struct nlmsghdr *)bytes; NLMSG_OK(h, left); h = NLMSG_NEXT(h, left)) {
    if (found || h->nlmsg_seq != 1 || h->nlmsg_type != RTM_NEWLINK || h->nlmsg_len < NLMSG_LENGTH(sizeof(struct ifinfomsg))) return false;
    struct ifinfomsg *link = NLMSG_DATA(h);
    if (link->ifi_index < 1 || !db_attributes(IFLA_RTA(link), IFLA_PAYLOAD(h), out) || strcmp(out->name, name)) return false;
    out->ifindex = (unsigned)link->ifi_index; found = true;
  }
  return left == 0 && found;
}
static int db_compare_address(const void *a, const void *b) { return strcmp(a, b); }
static bool db_addresses(int fd, db_binding *out) {
  struct { struct nlmsghdr h; struct ifaddrmsg address; } request = {
    .h = {.nlmsg_len = NLMSG_LENGTH(sizeof(struct ifaddrmsg)), .nlmsg_type = RTM_GETADDR,
      .nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP, .nlmsg_seq = 2}, .address = {.ifa_family = AF_UNSPEC, .ifa_index = out->ifindex}};
  struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
  if (sendto(fd, &request, request.h.nlmsg_len, 0, (struct sockaddr *)&kernel, sizeof(kernel)) != (ssize_t)request.h.nlmsg_len) return false;
  int64_t until = clock_ms() + IO_MS; size_t total = 0;
  for (;;) {
    char bytes[65536]; ssize_t got;
    if (!db_receive(fd, bytes, sizeof(bytes), until, &got) || (total += (size_t)got) > MAX_FRAME) return false;
    int left = (int)got;
    for (struct nlmsghdr *h = (struct nlmsghdr *)bytes; NLMSG_OK(h, left); h = NLMSG_NEXT(h, left)) {
      if (h->nlmsg_seq != 2 || (h->nlmsg_flags & NLM_F_DUMP_INTR)) return false;
      if (h->nlmsg_type == NLMSG_DONE) {
        if (h->nlmsg_len != NLMSG_LENGTH(sizeof(int)) || left != (int)NLMSG_ALIGN(h->nlmsg_len) || *(int *)NLMSG_DATA(h) != 0 || out->count == 0) return false;
        qsort(out->addresses, out->count, sizeof(out->addresses[0]), db_compare_address);
        for (unsigned i = 1; i < out->count; i++) if (!strcmp(out->addresses[i - 1], out->addresses[i])) return false;
        return true;
      }
      if (h->nlmsg_type != RTM_NEWADDR || h->nlmsg_len < NLMSG_LENGTH(sizeof(struct ifaddrmsg))) return false;
      struct ifaddrmsg *address = NLMSG_DATA(h);
      if (address->ifa_index != out->ifindex) return false;
      if ((address->ifa_family != AF_INET && address->ifa_family != AF_INET6) ||
        (address->ifa_scope != RT_SCOPE_UNIVERSE && address->ifa_scope != RT_SCOPE_LINK) ||
        (address->ifa_flags & (IFA_F_TENTATIVE | IFA_F_DADFAILED))) return false;
      struct rtattr *at = IFA_RTA(address); int size = IFA_PAYLOAD(h); const void *selected = NULL;
      unsigned selected_kind = address->ifa_family == AF_INET ? IFA_LOCAL : IFA_ADDRESS;
      for (; RTA_OK(at, size); at = RTA_NEXT(at, size)) if (at->rta_type == selected_kind) {
        if (selected || RTA_PAYLOAD(at) != (address->ifa_family == AF_INET ? 4 : 16)) return false;
        selected = RTA_DATA(at);
      }
      if (size || !selected || out->count >= 8 || !inet_ntop(address->ifa_family, selected,
        out->addresses[out->count], sizeof(out->addresses[0]))) return false;
      out->count++;
    }
    if (left) return false;
  }
}
static bool db_kernel(const char *name, db_binding *out) {
  int pipefd[2]; if (pipe2(pipefd, O_CLOEXEC | O_NONBLOCK)) return false;
  pid_t controller = getpid(), child = fork();
  if (child == 0) {
    close(pipefd[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != controller || setns(netns, CLONE_NEWNET)) _exit(125);
    int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC | SOCK_NONBLOCK, NETLINK_ROUTE);
    struct sockaddr_nl local = {.nl_family = AF_NETLINK}; db_binding value = {0}; int strict = 1;
    bool ok = fd >= 0 && !setsockopt(fd, SOL_NETLINK, NETLINK_GET_STRICT_CHK, &strict, sizeof(strict)) && !bind(fd, (struct sockaddr *)&local, sizeof(local)) && db_link(fd, name, &value) && db_addresses(fd, &value);
    if (fd >= 0) close(fd);
    if (!ok || !transfer(pipefd[1], &value, sizeof(value), true)) _exit(125);
    close(pipefd[1]); _exit(0);
  }
  close(pipefd[1]);
  if (child < 0) { close(pipefd[0]); return false; }
  bool ok = transfer(pipefd[0], out, sizeof(*out), false); close(pipefd[0]);
  int status; bool reaped = false; int64_t until = clock_ms() + IO_MS;
  while (clock_ms() < until) {
    pid_t got = waitpid(child, &status, WNOHANG);
    if (got == child) { reaped = true; break; }
    if (got < 0) break;
    struct timespec pause = {.tv_nsec = 1000000}; nanosleep(&pause, NULL);
  }
  if (!reaped) { kill(child, SIGKILL); while (waitpid(child, &status, 0) < 0 && errno == EINTR) {} }
  return ok && reaped && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
static bool db_network_name(char name[16]) {
  char path[256]; snprintf(path, sizeof(path), "/v1.51/networks/%s", network_id);
  unsigned char *body = NULL; size_t size = 0;
  if (!json_snapshot(path, &body, &size)) { if (body) { explicit_bzero(body, size); free(body); } return false; }
  di_node *nodes = calloc(DI_TOKENS, sizeof(*nodes)); bool ok = false;
  if (nodes) {
    di_parser p = {.s = body, .size = size, .nodes = nodes, .until = di_clock() + 500};
    int root = di_value(&p, 0); di_space(&p);
    if (root == 0 && p.at == size && di_live(&p) && di_equal_text(&p, di_field(&p, 0, "Id"), network_id) &&
      di_equal_text(&p, di_field(&p, 0, "Driver"), "bridge") && di_equal_text(&p, di_field(&p, 0, "Scope"), "local") &&
      di_false(&p, 0, "Ingress") && di_false(&p, 0, "Attachable")) {
      int options = di_field(&p, 0, "Options");
      ok = di_copy_c(&p, di_field(&p, options, "com.docker.network.bridge.name"), name, 16) &&
        token(name, 15, false) && ((name[0] >= 'a' && name[0] <= 'z') || (name[0] >= 'A' && name[0] <= 'Z'));
    }
    free(nodes);
  }
  explicit_bzero(body, size); free(body);
  return ok && current();
}
static bool db_equal(const db_binding *a, const db_binding *b) {
  if (strcmp(a->name, b->name) || strcmp(a->mac, b->mac) || a->ifindex != b->ifindex || a->count != b->count) return false;
  for (unsigned i = 0; i < a->count; i++) if (strcmp(a->addresses[i], b->addresses[i])) return false;
  return true;
}
static bool db_current(void) {
  char name[16]; db_binding actual = {0};
  return current() && db_network_name(name) && !strcmp(name, bridge_binding.name) &&
    db_kernel(name, &actual) && db_equal(&actual, &bridge_binding) && current();
}
#include <stdarg.h>
static bool db_line(const char *format, ...) {
  if (bridge_script_size >= MAX_SCRIPT) return false;
  va_list args; va_start(args, format);
  int n = vsnprintf(bridge_script + bridge_script_size, MAX_SCRIPT + 1 - bridge_script_size, format, args); va_end(args);
  if (n < 0 || (size_t)n >= MAX_SCRIPT + 1 - bridge_script_size) return false;
  bridge_script_size += (size_t)n; return true;
}
static bool db_set(char out[1024], char addresses[16][INET6_ADDRSTRLEN], unsigned count) {
  size_t used = 0; out[0] = 0;
  if (!count || count > 16) return false;
  if (count > 1) { strcpy(out, "{ "); used = 2; }
  for (unsigned i = 0; i < count; i++) {
    int n = snprintf(out + used, 1024 - used, "%s%s", i ? ", " : "", addresses[i]);
    if (n < 0 || (size_t)n >= 1024 - used) return false;
    used += (size_t)n;
  }
  if (count > 1) { if (used + 3 >= 1024) return false; strcpy(out + used, " }"); }
  return true;
}
static bool db_compile(void) {
  bridge_script_size = 0;
  char table[80]; snprintf(table, sizeof(table), "%s_bridge", table_name);
  char v4[16][INET6_ADDRSTRLEN] = {{0}}, v6[16][INET6_ADDRSTRLEN] = {{0}}, destinations[16][INET6_ADDRSTRLEN] = {{0}};
  unsigned n4 = 0, n6 = 0, nd = 0;
  for (unsigned i = 0; i < bridge_binding.count; i++) {
    struct in6_addr address;
    if (inet_pton(AF_INET6, bridge_binding.addresses[i], &address) == 1) {
      strcpy(v6[n6++], bridge_binding.addresses[i]); strcpy(destinations[nd++], bridge_binding.addresses[i]);
      struct in6_addr solicited; memset(&solicited, 0, sizeof(solicited));
      solicited.s6_addr[0] = 0xff; solicited.s6_addr[1] = 2; solicited.s6_addr[11] = 1; solicited.s6_addr[12] = 0xff;
      memcpy(solicited.s6_addr + 13, address.s6_addr + 13, 3);
      char text[INET6_ADDRSTRLEN]; if (!inet_ntop(AF_INET6, &solicited, text, sizeof(text))) return false;
      bool duplicate = false;
      for (unsigned j = 0; j < nd; j++) if (!strcmp(destinations[j], text)) duplicate = true;
      if (!duplicate) strcpy(destinations[nd++], text);
    } else {
      struct in_addr address4;
      if (inet_pton(AF_INET, bridge_binding.addresses[i], &address4) != 1) return false;
      strcpy(v4[n4++], bridge_binding.addresses[i]);
    }
  }
  char set4[1024] = "", set6[1024] = "", setnd[1024] = "";
  if ((n4 && !db_set(set4, v4, n4)) || (n6 && (!db_set(set6, v6, n6) || !db_set(setnd, destinations, nd)))) return false;
  if (!db_line("create table bridge %s\ntable bridge %s {\nset disabled { type ifname; }\ncounter killed { }\ncounter bridge_denied { }\n", table, table)) return false;
  const char *hooks[] = {"prerouting", "input", "forward", "output"}; unsigned tag = 0;
  for (unsigned hook = 0; hook < 4; hook++) {
    if (!db_line("chain %s { type filter hook %s priority -210; policy accept;\n%s @disabled counter name killed drop comment \"cxb_%u\"\n", hooks[hook], hooks[hook], hook == 3 ? "obrname" : "ibrname", tag++)) return false;
    const char *name = bridge_binding.name, *mac = bridge_binding.mac;
    if (hook == 0) {
      if (!db_line("ibrname \"%s\" ether saddr %s counter name bridge_denied drop comment \"cxb_%u\"\n", name, mac, tag++)) return false;
      if (n4 && (!db_line("ibrname \"%s\" ip saddr %s counter name bridge_denied drop comment \"cxb_%u\"\n", name, set4, tag++) ||
        !db_line("ibrname \"%s\" arp saddr ip %s counter name bridge_denied drop comment \"cxb_%u\"\n", name, set4, tag++))) return false;
      if (n6 && !db_line("ibrname \"%s\" ip6 saddr %s counter name bridge_denied drop comment \"cxb_%u\"\n", name, set6, tag++)) return false;
      if (!db_line("ibrname \"%s\" ether type != { ip, ip6, arp } counter name bridge_denied drop comment \"cxb_%u\"\n", name, tag++)) return false;
    } else if (hook == 1) {
      if (n4 && !db_line("ibrname \"%s\" arp operation { request, reply } arp daddr ip %s accept comment \"cxb_%u\"\n", name, set4, tag++)) return false;
      if (n6 && !db_line("ibrname \"%s\" meta l4proto ipv6-icmp icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 ip6 daddr %s accept comment \"cxb_%u\"\n", name, setnd, tag++)) return false;
      if (!db_line("ibrname \"%s\" ether daddr %s ether type { ip, ip6 } accept comment \"cxb_%u\"\n", name, mac, tag++) ||
        !db_line("ibrname \"%s\" counter name bridge_denied drop comment \"cxb_%u\"\n", name, tag++)) return false;
    } else if (hook == 2 && !db_line("ibrname \"%s\" counter name bridge_denied drop comment \"cxb_%u\"\n", name, tag++)) return false;
    if (!db_line("}\n")) return false;
  }
  return db_line("}\n");
}
static bool db_capture(void) {
  char expected[64], name[16]; snprintf(expected, sizeof(expected), "takos_cx_%.32s", network_id);
  return !strcmp(expected, table_name) && db_network_name(name) && db_kernel(name, &bridge_binding) &&
    db_compile() && db_current();
}
static bool db_projection(void) {
  char result[1024]; di_output out = {.s = result, .capacity = sizeof(result)};
  if (!db_current()) return refusal("bridge_scope_changed");
  char first[160]; int n = snprintf(first, sizeof(first), "{\"name\":\"%s\",\"ifindex\":%u,\"mac\":\"%s\",\"addresses\":[", bridge_binding.name, bridge_binding.ifindex, bridge_binding.mac);
  if (n < 0 || (size_t)n >= sizeof(first) || !di_text(&out, first)) return false;
  for (unsigned i = 0; i < bridge_binding.count; i++) {
    if ((i && !di_text(&out, ",")) || !di_text(&out, "\"") || !di_text(&out, bridge_binding.addresses[i]) || !di_text(&out, "\"")) return false;
  }
  return di_text(&out, "]}") && db_current() ? reply(0, result, out.used) : refusal("bridge_scope_changed");
}
#endif
