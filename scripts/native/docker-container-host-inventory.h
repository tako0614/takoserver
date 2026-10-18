#ifndef TAKOS_DOCKER_HOST_INVENTORY_H
#define TAKOS_DOCKER_HOST_INVENTORY_H
/* Fixed read-only kernel inventory in the original pinned daemon namespace.
 * All local unicast addresses protect Host control listeners; actual bridge
 * connected prefixes protect other local tenant/control networks, including
 * publicly numbered bridges. There is no caller address/namespace selector. */
enum { HI_LINKS = 512, HI_ADDRESSES = 1024, HI_NETWORKS = 256 };
typedef struct {
  unsigned address_count, network_count;
  char addresses[HI_ADDRESSES][INET6_ADDRSTRLEN];
  char networks[HI_NETWORKS][INET6_ADDRSTRLEN + 5];
} hi_inventory;
static hi_inventory guest_host_inventory;
static bool host_inventory_held;
static int64_t host_inventory_checked;
static int hi_compare_address(const void *a, const void *b) { return strcmp(a, b); }
static bool hi_links(int fd, unsigned bridges[HI_LINKS], unsigned *count) {
  struct { struct nlmsghdr h; struct ifinfomsg link; } request = {
    .h = {.nlmsg_len = NLMSG_LENGTH(sizeof(struct ifinfomsg)), .nlmsg_type = RTM_GETLINK,
      .nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP, .nlmsg_seq = 11}, .link = {.ifi_family = AF_UNSPEC}};
  struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
  if (sendto(fd, &request, request.h.nlmsg_len, 0, (struct sockaddr *)&kernel, sizeof(kernel)) != (ssize_t)request.h.nlmsg_len) return false;
  int64_t until = clock_ms() + IO_MS; size_t total = 0; unsigned links = 0; *count = 0;
  for (;;) {
    char bytes[65536]; ssize_t got;
    if (!db_receive(fd, bytes, sizeof(bytes), until, &got) || (total += (size_t)got) > MAX_FRAME) return false;
    int left = (int)got;
    for (struct nlmsghdr *h = (struct nlmsghdr *)bytes; NLMSG_OK(h, left); h = NLMSG_NEXT(h, left)) {
      if (h->nlmsg_seq != 11 || (h->nlmsg_flags & NLM_F_DUMP_INTR)) return false;
      if (h->nlmsg_type == NLMSG_DONE) return h->nlmsg_len == NLMSG_LENGTH(sizeof(int)) &&
        left == (int)NLMSG_ALIGN(h->nlmsg_len) && *(int *)NLMSG_DATA(h) == 0;
      if (h->nlmsg_type != RTM_NEWLINK || h->nlmsg_len < NLMSG_LENGTH(sizeof(struct ifinfomsg)) || ++links > HI_LINKS) return false;
      struct ifinfomsg *link = NLMSG_DATA(h); if (link->ifi_index < 1) return false;
      int size = IFLA_PAYLOAD(h); struct rtattr *at = IFLA_RTA(link); bool bridge = false, kind_seen = false;
      for (; RTA_OK(at, size); at = RTA_NEXT(at, size)) if ((at->rta_type & NLA_TYPE_MASK) == IFLA_LINKINFO) {
        int nested = RTA_PAYLOAD(at); struct rtattr *info = RTA_DATA(at);
        for (; RTA_OK(info, nested); info = RTA_NEXT(info, nested)) if ((info->rta_type & NLA_TYPE_MASK) == IFLA_INFO_KIND) {
          int length = RTA_PAYLOAD(info);
          if (kind_seen || length < 2 || length > 64 || ((char *)RTA_DATA(info))[length - 1]) return false;
          kind_seen = true; bridge = length == 7 && !memcmp(RTA_DATA(info), "bridge", 7);
        }
        if (nested) return false;
      }
      if (size) return false;
      if (bridge) { if (*count >= HI_LINKS) return false; bridges[(*count)++] = (unsigned)link->ifi_index; }
    }
    if (left) return false;
  }
}
static bool hi_add(const void *bytes, int family, unsigned prefix, bool bridge, hi_inventory *out) {
  if (out->address_count >= HI_ADDRESSES || (family != AF_INET && family != AF_INET6) ||
    prefix > (family == AF_INET ? 32U : 128U)) return false;
  char address[INET6_ADDRSTRLEN]; if (!inet_ntop(family, bytes, address, sizeof(address))) return false;
  bool duplicate = false;
  for (unsigned i = 0; i < out->address_count; i++) if (!strcmp(out->addresses[i], address)) duplicate = true;
  if (!duplicate) strcpy(out->addresses[out->address_count++], address);
  if (bridge) {
    unsigned char masked[16] = {0}; unsigned size = family == AF_INET ? 4 : 16;
    memcpy(masked, bytes, size);
    for (unsigned i = 0; i < size; i++) {
      unsigned start = i * 8;
      masked[i] &= prefix >= start + 8 ? 255U : prefix <= start ? 0U : (255U << (8 - (prefix - start)));
    }
    char network[INET6_ADDRSTRLEN + 5], text[INET6_ADDRSTRLEN];
    if (!inet_ntop(family, masked, text, sizeof(text))) return false;
    int n = snprintf(network, sizeof(network), "%s/%u", text, prefix);
    if (n < 0 || (size_t)n >= sizeof(network)) return false;
    duplicate = false;
    for (unsigned i = 0; i < out->network_count; i++) if (!strcmp(out->networks[i], network)) duplicate = true;
    if (!duplicate) { if (out->network_count >= HI_NETWORKS) return false; strcpy(out->networks[out->network_count++], network); }
  }
  return true;
}
static bool hi_addresses(int fd, const unsigned bridges[HI_LINKS], unsigned bridge_count, hi_inventory *out) {
  struct { struct nlmsghdr h; struct ifaddrmsg address; } request = {
    .h = {.nlmsg_len = NLMSG_LENGTH(sizeof(struct ifaddrmsg)), .nlmsg_type = RTM_GETADDR,
      .nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP, .nlmsg_seq = 12}, .address = {.ifa_family = AF_UNSPEC}};
  struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
  if (sendto(fd, &request, request.h.nlmsg_len, 0, (struct sockaddr *)&kernel, sizeof(kernel)) != (ssize_t)request.h.nlmsg_len) return false;
  int64_t until = clock_ms() + IO_MS; size_t total = 0;
  for (;;) {
    char bytes[65536]; ssize_t got;
    if (!db_receive(fd, bytes, sizeof(bytes), until, &got) || (total += (size_t)got) > MAX_FRAME) return false;
    int left = (int)got;
    for (struct nlmsghdr *h = (struct nlmsghdr *)bytes; NLMSG_OK(h, left); h = NLMSG_NEXT(h, left)) {
      if (h->nlmsg_seq != 12 || (h->nlmsg_flags & NLM_F_DUMP_INTR)) return false;
      if (h->nlmsg_type == NLMSG_DONE) {
        if (h->nlmsg_len != NLMSG_LENGTH(sizeof(int)) || left != (int)NLMSG_ALIGN(h->nlmsg_len) || *(int *)NLMSG_DATA(h) != 0 || !out->address_count) return false;
        qsort(out->addresses, out->address_count, sizeof(out->addresses[0]), hi_compare_address);
        qsort(out->networks, out->network_count, sizeof(out->networks[0]), hi_compare_address);
        return true;
      }
      if (h->nlmsg_type != RTM_NEWADDR || h->nlmsg_len < NLMSG_LENGTH(sizeof(struct ifaddrmsg))) return false;
      struct ifaddrmsg *address = NLMSG_DATA(h);
      if (!address->ifa_index || (address->ifa_family != AF_INET && address->ifa_family != AF_INET6) ||
        (address->ifa_flags & (IFA_F_TENTATIVE | IFA_F_DADFAILED))) return false;
      struct rtattr *at = IFA_RTA(address); int size = IFA_PAYLOAD(h); const void *selected = NULL;
      unsigned kind = address->ifa_family == AF_INET ? IFA_LOCAL : IFA_ADDRESS;
      for (; RTA_OK(at, size); at = RTA_NEXT(at, size)) if ((at->rta_type & NLA_TYPE_MASK) == kind) {
        if (selected || RTA_PAYLOAD(at) != (address->ifa_family == AF_INET ? 4 : 16)) return false;
        selected = RTA_DATA(at);
      }
      if (size || !selected) return false;
      bool bridge = false; for (unsigned i = 0; i < bridge_count; i++) if (bridges[i] == address->ifa_index) bridge = true;
      if (!hi_add(selected, address->ifa_family, address->ifa_prefixlen, bridge, out)) return false;
    }
    if (left) return false;
  }
}
static bool hi_equal(const hi_inventory *a, const hi_inventory *b);
static bool hi_capture(hi_inventory *out) {
  int channel[2]; if (pipe2(channel, O_CLOEXEC | O_NONBLOCK)) return false;
  pid_t parent = getpid(), child = fork();
  if (child == 0) {
    close(channel[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent || setns(netns, CLONE_NEWNET)) _exit(125);
    int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC | SOCK_NONBLOCK, NETLINK_ROUTE), strict = 1;
    struct sockaddr_nl local = {.nl_family = AF_NETLINK}; unsigned bridges[HI_LINKS], count = 0;
    hi_inventory *value = calloc(1, sizeof(*value)), *again = calloc(1, sizeof(*again));
    bool ok = value && again && fd >= 0 && !setsockopt(fd, SOL_NETLINK, NETLINK_GET_STRICT_CHK, &strict, sizeof(strict)) &&
      !bind(fd, (struct sockaddr *)&local, sizeof(local)) && hi_links(fd, bridges, &count) && hi_addresses(fd, bridges, count, value) &&
      hi_links(fd, bridges, &count) && hi_addresses(fd, bridges, count, again) && hi_equal(value, again);
    if (fd >= 0) close(fd);
    if (!ok || !transfer(channel[1], value, sizeof(*value), true)) _exit(125);
    free(value); free(again); close(channel[1]); _exit(0);
  }
  close(channel[1]); if (child < 0) { close(channel[0]); return false; }
  bool ok = transfer(channel[0], out, sizeof(*out), false); close(channel[0]);
  int status = 0; bool reaped = false; int64_t until = clock_ms() + IO_MS;
  while (clock_ms() < until) {
    pid_t got = waitpid(child, &status, WNOHANG);
    if (got == child) { reaped = true; break; }
    if (got < 0) break;
    struct timespec pause = {.tv_nsec = 1000000}; nanosleep(&pause, NULL);
  }
  if (!reaped) { kill(child, SIGKILL); while (waitpid(child, &status, 0) < 0 && errno == EINTR) {} }
  return ok && reaped && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
static bool hi_equal(const hi_inventory *a, const hi_inventory *b) {
  if (a->address_count != b->address_count || a->network_count != b->network_count) return false;
  for (unsigned i = 0; i < a->address_count; i++) if (strcmp(a->addresses[i], b->addresses[i])) return false;
  for (unsigned i = 0; i < a->network_count; i++) if (strcmp(a->networks[i], b->networks[i])) return false;
  return true;
}
static bool host_inventory_current(void) {
  if (!host_inventory_held) return true;
  int64_t now = clock_ms();
  if (now < 0 || now < host_inventory_checked) return false;
  if (now - host_inventory_checked < 250) return true;
  hi_inventory *actual = calloc(1, sizeof(*actual)); if (!actual) return false;
  bool ok = current() && hi_capture(actual) && hi_equal(actual, &guest_host_inventory) && current(); free(actual);
  if (ok) {
    int64_t completed = clock_ms(); if (completed < now) return false;
    host_inventory_checked = completed;
  }
  return ok;
}
static bool host_inventory_reply(void) {
  if (!guest_mode || !host_inventory_held || !selected_current()) return refusal("host_inventory_unavailable");
  char *bytes = malloc(131072); if (!bytes) return false;
  di_output out = {.s = bytes, .capacity = 131072}; bool ok = di_text(&out, "{\"addresses\":[");
  for (unsigned i = 0; ok && i < guest_host_inventory.address_count; i++)
    ok = (!i || di_text(&out, ",")) && di_text(&out, "\"") && di_text(&out, guest_host_inventory.addresses[i]) && di_text(&out, "\"");
  ok = ok && di_text(&out, "],\"networks\":[");
  for (unsigned i = 0; ok && i < guest_host_inventory.network_count; i++)
    ok = (!i || di_text(&out, ",")) && di_text(&out, "\"") && di_text(&out, guest_host_inventory.networks[i]) && di_text(&out, "\"");
  ok = ok && di_text(&out, "]}") && selected_current();
  bool sent = ok ? reply(0, bytes, out.used) : refusal("host_inventory_changed"); free(bytes); return sent;
}
#endif
