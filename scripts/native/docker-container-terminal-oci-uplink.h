#ifndef DOCKER_CONTAINER_TERMINAL_OCI_UPLINK_H
#define DOCKER_CONTAINER_TERMINAL_OCI_UPLINK_H

/* Private implementation for the original opaque OCI producer. Expected Host
 * topology is data; only actual original namespace/socket/dump producers can
 * supply a physical binding. The kernel gate and birth DROP remain CLOSED.
 * No callback, caller FD/PID, arbitrary command or foreign namespace is used. */
#include <arpa/inet.h>
#include <linux/ethtool.h>
#include <linux/if.h>
#include <linux/if_addr.h>
#include <linux/if_arp.h>
#include <linux/if_link.h>
#include <linux/fib_rules.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <linux/veth.h>
#include <linux/sockios.h>
#include <sys/socket.h>

#define OCI_UPLINK_FILE ".tako-oci-topology.json"
#define OCI_UPLINK_DUMP_MAX 1048576u
#define OCI_UPLINK_PACKET_MAX 65536u
struct oci_uplink_topology {
  char name[16]; uint32_t index; unsigned char mac[6];
  unsigned char local4[4], gateway4[4], local6[16], gateway6[16];
  unsigned char host4[4], guest4[4], host6[16], guest6[16];
  unsigned int prefix4, prefix6;
};
struct oci_uplink_dump {
  uint32_t sequence, port; uint16_t type;
  unsigned int done, failed, records;
  size_t used;
  unsigned char bytes[OCI_UPLINK_DUMP_MAX];
};
/* A bounded GET buffer, not a feature policy or a supported-driver class.
 * The returned size must fit in full; no feature words are silently omitted. */
#define OCI_UPLINK_FEATURE_WORDS 8u
struct oci_uplink_features {
  uint32_t cmd, size;
  struct ethtool_get_features_block blocks[OCI_UPLINK_FEATURE_WORDS];
};
_Static_assert(offsetof(struct oci_uplink_features, blocks) == sizeof(struct ethtool_gfeatures), "ethtool GET layout");
struct oci_uplink_driver_facts {
  struct ethtool_drvinfo driver;
  struct oci_uplink_features features;
};
struct oci_uplink_owner {
  struct tns_oci_owner *original;
  struct oci_uplink_topology expected;
  struct tns_identity identity, creator;
  uint64_t cookie;
  pid_t controller, child;
  int netfd, guest, host, child_pidfd, channel;
  int lock_root, lock; unsigned int lock_held; struct stat lock_identity;
  int received_rights[8]; unsigned int received_count;
  uint32_t guest_port, host_port, sequence;
  uint64_t host_cookie;
  struct oci_uplink_driver_facts driver_facts;
  unsigned int driver_attempted, driver_captured;
  int file; unsigned int file_selected; struct stat file_identity;
  size_t file_size; char file_bytes[32769];
  char host_name[16], guest_name[16];
  uint32_t host_index, guest_index; unsigned char host_mac[6], guest_mac[6];
  unsigned int create_sent, create_known, pair_known, configured, delete_sent, delete_known;
  unsigned int phase, cleaning;
  unsigned int attempt, child_joined, child_ok, kill_attempt, broken, close_unknown;
};

static int oci_uplink_prefix(const unsigned char *a, const unsigned char *b, unsigned int bits) {
  size_t whole = bits / 8; unsigned int left = bits % 8;
  return !memcmp(a, b, whole) && (!left || !((a[whole] ^ b[whole]) & (0xffu << (8 - left))));
}
static int oci_uplink_ip(char *text, int family, unsigned char *out, unsigned int *prefix) {
  char *slash = strchr(text, '/'); unsigned int width = family == AF_INET ? 32u : 128u;
  if (prefix) {
    if (!slash || !slash[1] || slash[1] == '0') return -1;
    *slash++ = 0; uint64_t n;
    struct oci_egress_cursor c = {(unsigned char *)slash, strlen(slash), 0};
    if (oci_egress_number(&c, &n) < 0 || c.at != c.size || !n || n > width) return -1;
    *prefix = (unsigned int)n;
  } else if (slash) return -1;
  if (strchr(text, '%') || (family == AF_INET6 && strchr(text, '.')) || inet_pton(family, text, out) != 1) return -1;
  char canonical[INET6_ADDRSTRLEN];
  if (!inet_ntop(family, out, canonical, sizeof(canonical)) || strcmp(text, canonical)) return -1;
  if (family == AF_INET) return !out[0] || out[0] == 127 || out[0] >= 224 ? -1 : 0;
  static const unsigned char zero[16] = {0}, loop[16] = {[15] = 1}, mapped[12] = {[10] = 255, [11] = 255};
  return !memcmp(out, zero, 16) || !memcmp(out, loop, 16) || !memcmp(out, mapped, 12) || out[0] == 255 ? -1 : 0;
}
static int oci_uplink_topology(const char *bytes, size_t size, const char *artifact,
                                 size_t artifact_size, struct oci_uplink_topology *out) {
  if (!bytes || !artifact || !out || !size || size > 32768 || !artifact_size) return -1;
  struct oci_egress_cursor c = {(const unsigned char *)bytes, size, 0};
  if (oci_egress_take(&c, "{\"kind\":\"linux-oci-owned-topology@1\",\"artifact\":") < 0 ||
      artifact_size > c.size - c.at || memcmp(c.p + c.at, artifact, artifact_size)) return -1;
  c.at += artifact_size;
  if (oci_egress_take(&c, ",\"topology\":{") < 0) return -1;
  struct oci_uplink_topology t = {0};
  const char *const keys[] = {"interfaceName", "interfaceIndex", "interfaceMac", "ipv4Address", "ipv4Gateway", "ipv6Address", "ipv6Gateway", "peerIpv4Host", "peerIpv4Guest", "peerIpv6Host", "peerIpv6Guest"};
  for (size_t i = 0; i < 11; ++i) {
    if ((i && oci_egress_take(&c, ",") < 0) || oci_egress_take(&c, "\"") < 0 ||
        oci_egress_take(&c, keys[i]) < 0 || oci_egress_take(&c, "\":") < 0) return -1;
    if (i == 1) {
      uint64_t n; if (oci_egress_number(&c, &n) < 0 || !n || n > INT_MAX) return -1;
      t.index = (uint32_t)n; continue;
    }
    char text[128]; if (oci_egress_string(&c, text, sizeof(text)) < 0) return -1;
    if (!i) {
      size_t n = strlen(text); if (!n || n > 15 || !strcmp(text, ".") || !strcmp(text, "..") || !strcmp(text, "lo")) return -1;
      for (size_t j = 0; j < n; ++j) if (!((text[j] >= 'a' && text[j] <= 'z') || (text[j] >= 'A' && text[j] <= 'Z') ||
          (text[j] >= '0' && text[j] <= '9') || text[j] == '_' || text[j] == '.' || text[j] == '-')) return -1;
      memcpy(t.name, text, n + 1);
    } else if (i == 2) {
      if (strlen(text) != 17) return -1;
      unsigned int any = 0;
      for (size_t j = 0; j < 6; ++j) {
        unsigned int n = 0;
        for (size_t k = 0; k < 2; ++k) {
          unsigned int h = (unsigned char)text[j * 3 + k];
          if (h >= '0' && h <= '9') h -= '0'; else if (h >= 'a' && h <= 'f') h = h - 'a' + 10; else return -1;
          n = n * 16 + h;
        }
        if (j < 5 && text[j * 3 + 2] != ':') return -1;
        t.mac[j] = (unsigned char)n; any |= n;
      }
      if (!any || (t.mac[0] & 1)) return -1;
    } else {
      unsigned char *dest = i == 3 ? t.local4 : i == 4 ? t.gateway4 : i == 5 ? t.local6 : i == 6 ? t.gateway6 :
        i == 7 ? t.host4 : i == 8 ? t.guest4 : i == 9 ? t.host6 : t.guest6;
      int family = i == 3 || i == 4 || i == 7 || i == 8 ? AF_INET : AF_INET6;
      unsigned int *prefix = i == 3 ? &t.prefix4 : i == 5 ? &t.prefix6 : NULL;
      if (oci_uplink_ip(text, family, dest, prefix) < 0) return -1;
    }
  }
  if (oci_egress_take(&c, "}}") < 0 || c.at != c.size ||
      !memcmp(t.local4, t.gateway4, 4) || !oci_uplink_prefix(t.local4, t.gateway4, t.prefix4) ||
      !memcmp(t.local6, t.gateway6, 16) ||
      (!oci_uplink_prefix(t.local6, t.gateway6, t.prefix6) && !(t.gateway6[0] == 0xfe && (t.gateway6[1] & 0xc0) == 0x80))) return -1;
  if (!(t.host4[0] == 10 || (t.host4[0] == 172 && (t.host4[1] & 0xf0) == 16) ||
        (t.host4[0] == 192 && t.host4[1] == 168)) || (t.host4[3] & 1) ||
      memcmp(t.host4, t.guest4, 3) || t.guest4[3] != t.host4[3] + 1 ||
      t.host6[0] != 0xfd || (t.host6[15] & 1) || memcmp(t.host6, t.guest6, 15) ||
      t.guest6[15] != t.host6[15] + 1 ||
      oci_uplink_prefix(t.host4, t.local4, t.prefix4 < 31 ? t.prefix4 : 31) ||
      oci_uplink_prefix(t.host6, t.local6, t.prefix6 < 127 ? t.prefix6 : 127)) return -1;
  if (t.prefix4 < 31) {
    uint32_t a, b; memcpy(&a, t.local4, 4); memcpy(&b, t.gateway4, 4);
    a = ntohl(a); b = ntohl(b); uint32_t mask = UINT32_MAX >> t.prefix4;
    if (!(a & mask) || (a & mask) == mask || !(b & mask) || (b & mask) == mask) return -1;
  }
  *out = t; return 0;
}

/* Strict bounded multipart collector. It cannot turn interrupted/error/empty
 * transport into a completed snapshot. Collected bytes are observations only. */
static int oci_uplink_dump_feed(struct oci_uplink_dump *d, const void *bytes, size_t size) {
  if (!d || !bytes || !size || d->done || d->failed || !d->sequence || !d->port) return -1;
  const unsigned char *p = bytes; size_t at = 0;
  while (at < size) {
    if (size - at < sizeof(struct nlmsghdr)) goto fail;
    struct nlmsghdr h; memcpy(&h, p + at, sizeof(h));
    if (h.nlmsg_len < sizeof(h) || h.nlmsg_len > size - at ||
        h.nlmsg_seq != d->sequence || h.nlmsg_pid != d->port ||
        h.nlmsg_flags != NLM_F_MULTI) goto fail;
    size_t aligned = NLMSG_ALIGN((size_t)h.nlmsg_len);
    if (aligned > size - at) goto fail;
    if (h.nlmsg_type == NLMSG_DONE) {
      int result; if (h.nlmsg_len != NLMSG_LENGTH(sizeof(result)) || at + aligned != size) goto fail;
      memcpy(&result, p + at + NLMSG_HDRLEN, sizeof(result)); if (result) goto fail;
      d->done = 1;
    } else {
      size_t fixed = d->type == RTM_NEWLINK ? sizeof(struct ifinfomsg) : d->type == RTM_NEWADDR ? sizeof(struct ifaddrmsg) :
        d->type == RTM_NEWROUTE ? sizeof(struct rtmsg) : d->type == RTM_NEWRULE ? sizeof(struct fib_rule_hdr) : 0;
      if (!fixed || h.nlmsg_type != d->type || h.nlmsg_len < NLMSG_LENGTH(fixed) ||
          d->records == 4096 || aligned > sizeof(d->bytes) - d->used) goto fail;
      size_t attrs = NLMSG_ALIGN(NLMSG_LENGTH(fixed));
      while (attrs < h.nlmsg_len) {
        struct rtattr a;
        if (h.nlmsg_len - attrs < sizeof(a)) goto fail;
        memcpy(&a, p + at + attrs, sizeof(a));
        if (a.rta_len < sizeof(a) || a.rta_len > h.nlmsg_len - attrs || RTA_ALIGN((size_t)a.rta_len) > h.nlmsg_len - attrs) goto fail;
        attrs += RTA_ALIGN((size_t)a.rta_len);
      }
      if (attrs != h.nlmsg_len) goto fail;
      memcpy(d->bytes + d->used, p + at, aligned); d->used += aligned; d->records++;
    }
    at += aligned;
  }
  return 0;
fail:
  d->failed = 1; errno = EPROTO; return -1;
}

static int oci_uplink_host_current(struct oci_uplink_owner *u);
static int oci_uplink_file_current(struct oci_uplink_owner *u);
static int oci_uplink_cleanup_current(struct oci_uplink_owner *u);
static int oci_uplink_lock_current(struct oci_uplink_owner *u);
static int oci_uplink_original(struct oci_uplink_owner *u) {
  if (u && u->cleaning) return oci_uplink_cleanup_current(u);
  if (!u || !u->original || u->controller != getpid() || u->broken || u->close_unknown ||
      !u->original->egress_selected || !u->original->egress_guard_verified ||
      oci_egress_original(u->original) < 0 || oci_uplink_file_current(u) < 0 ||
      (u->host >= 0 && oci_uplink_host_current(u) < 0) ||
      (u->lock >= 0 && oci_uplink_lock_current(u) < 0)) { if (!errno) errno = EPERM; return -1; }
  struct tns_lifetime life;
  if (tns_owner_observe_lifetime(u->original->birth, &life) < 0 ||
      !tns_identity_equal(&life.identity, &u->identity) || life.net_cookie != u->cookie ||
      life.born != 1 || life.release_attempted || life.reference_released || life.net_gone || life.poisoned) {
    if (!errno) errno = ESTALE;
    return -1;
  }
  return oci_not_canceled();
}
static int oci_uplink_socket_identity(int fd, uint64_t cookie, uint32_t *port) {
  int value; socklen_t n = sizeof(value);
  if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &value, &n) < 0 || n != sizeof(value) || value != AF_NETLINK) return -1;
  n = sizeof(value);
  if (getsockopt(fd, SOL_SOCKET, SO_PROTOCOL, &value, &n) < 0 || n != sizeof(value) || value != NETLINK_ROUTE) return -1;
  n = sizeof(value);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &value, &n) < 0 || n != sizeof(value) || value != SOCK_RAW) return -1;
  uint64_t actual = 0; n = sizeof(actual);
  if (!cookie || getsockopt(fd, SOL_SOCKET, SO_NETNS_COOKIE, &actual, &n) < 0 || n != sizeof(actual) || actual != cookie) return -1;
  struct sockaddr_nl address; memset(&address, 0, sizeof(address)); n = sizeof(address);
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0 || !(flags & FD_CLOEXEC) || getsockname(fd, (struct sockaddr *)&address, &n) < 0 ||
      n != sizeof(address) || address.nl_family != AF_NETLINK || !address.nl_pid || address.nl_groups) return -1;
  *port = address.nl_pid; return 0;
}
static _Noreturn void oci_uplink_child(struct oci_uplink_owner *u, int channel) {
  int ns = fcntl(u->original->network, F_DUPFD_CLOEXEC, 10), io = fcntl(channel, F_DUPFD_CLOEXEC, 10);
  if (ns < 0 || io < 0 || dup3(ns, 3, O_CLOEXEC) < 0 || dup3(io, 4, O_CLOEXEC) < 0 ||
      syscall(SYS_close_range, 0u, 2u, 0u) < 0 || syscall(SYS_close_range, 5u, UINT_MAX, 0u) < 0 ||
      prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != u->controller) _exit(125);
  struct stat st; struct statfs fs;
  if (fstat(3, &st) < 0 || fstatfs(3, &fs) < 0 || (unsigned long)fs.f_type != (unsigned long)NSFS_MAGIC ||
      ioctl(3, NS_GET_NSTYPE) != CLONE_NEWNET || (uint64_t)st.st_dev != u->identity.device ||
      (uint64_t)st.st_ino != u->identity.inode || setns(3, CLONE_NEWNET) < 0 || close(3) < 0) _exit(125);
  int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC | SOCK_NONBLOCK, NETLINK_ROUTE), one = 1;
  struct sockaddr_nl local = {.nl_family = AF_NETLINK}; uint32_t port;
  if (fd < 0 || setsockopt(fd, SOL_NETLINK, NETLINK_GET_STRICT_CHK, &one, sizeof(one)) < 0 ||
      setsockopt(fd, SOL_NETLINK, NETLINK_EXT_ACK, &one, sizeof(one)) < 0 ||
      setsockopt(fd, SOL_NETLINK, NETLINK_CAP_ACK, &one, sizeof(one)) < 0 ||
      bind(fd, (struct sockaddr *)&local, sizeof(local)) < 0 || oci_uplink_socket_identity(fd, u->cookie, &port) < 0) _exit(125);
  struct { uint64_t device, inode, cookie; } fact = {u->identity.device, u->identity.inode, u->cookie};
  union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } ancillary;
  memset(&ancillary, 0, sizeof(ancillary));
  struct iovec iov = {&fact, sizeof(fact)};
  struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = ancillary.bytes, .msg_controllen = sizeof(ancillary)};
  struct cmsghdr *c = CMSG_FIRSTHDR(&message); c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(c), &fd, sizeof(fd));
  if (sendmsg(4, &message, MSG_NOSIGNAL) != (ssize_t)sizeof(fact)) _exit(125);
  if (close(fd) < 0 || close(4) < 0) _exit(125);
  _exit(0);
}
static int oci_uplink_join(struct oci_uplink_owner *u, int timeout) {
  if (!u->child || u->child_joined) return 0;
  struct pollfd p = {.fd = u->child_pidfd, .events = POLLIN}; int n = poll(&p, 1, timeout);
  if (n < 0) return -1;
  if (!n) { errno = ETIMEDOUT; return -1; }
  if (p.revents != POLLIN) { errno = EPROTO; return -1; }
  siginfo_t info; memset(&info, 0, sizeof(info));
  if (waitid(P_PIDFD, (id_t)u->child_pidfd, &info, WEXITED | WNOHANG) < 0) return -1;
  if (info.si_pid != u->child || (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED && info.si_code != CLD_DUMPED)) { errno = EPROTO; return -1; }
  u->child_joined = 1; u->child_ok = info.si_code == CLD_EXITED && info.si_status == 0; return 0;
}
static int oci_uplink_close_fd(struct oci_uplink_owner *u, int *slot) {
  if (*slot < 0) return 0;
  int fd = *slot; *slot = -1;
  if (close(fd) < 0) { u->close_unknown = 1; return -1; }
  return 0;
}
static int oci_uplink_guest_channel(struct tns_oci_owner *o, struct oci_uplink_owner *u) {
  if (!o || !u || tns_oci_once(&u->attempt) < 0) { errno = EALREADY; return -1; }
  u->original = o; u->controller = getpid(); u->identity = o->identity;
  u->guest = u->host = u->channel = u->child_pidfd = u->netfd = u->lock_root = u->lock = -1;
  struct tns_lifetime life;
  if (tns_owner_observe_lifetime(o->birth, &life) < 0 || !tns_identity_equal(&life.identity, &u->identity)) return -1;
  u->cookie = life.net_cookie;
  if (oci_uplink_original(u) < 0) return -1;
  int pair[2]; if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, pair) < 0) return -1;
  u->channel = pair[0];
  int64_t now = oci_now(); if (now < 0) { (void)oci_uplink_close_fd(u, &pair[1]); return -1; }
  int64_t deadline = now + 2500;
  struct clone_args args; memset(&args, 0, sizeof(args)); args.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND;
  args.pidfd = (uint64_t)(uintptr_t)&u->child_pidfd; args.exit_signal = SIGCHLD;
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (!child) oci_uplink_child(u, pair[1]);
  (void)oci_uplink_close_fd(u, &pair[1]);
  if (child < 0) return -1;
  u->child = (pid_t)child;
  if (oci_uplink_original(u) < 0) return -1;
  struct pollfd p = {.fd = u->channel, .events = POLLIN}; int left = oci_egress_left(deadline);
  if (left < 0 || poll(&p, 1, left) != 1 || p.revents != POLLIN) { errno = EPROTO; return -1; }
  struct { uint64_t device, inode, cookie; } fact;
  union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } ancillary;
  struct iovec iov = {&fact, sizeof(fact)}; memset(&ancillary, 0, sizeof(ancillary));
  struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = ancillary.bytes, .msg_controllen = sizeof(ancillary)};
  ssize_t n = recvmsg(u->channel, &message, MSG_CMSG_CLOEXEC | MSG_DONTWAIT);
  /* Returned SCM_RIGHTS descriptors already belong to this process, including
   * a malformed two-FD payload fitting CMSG_SPACE(one int). Capture all bounded
   * returned rights BEFORE semantic validation. Never guess truncated extras. */
  int valid_control = message.msg_controllen <= sizeof(ancillary);
  size_t at = 0; unsigned int messages = 0;
  while (valid_control && at < message.msg_controllen) {
    struct cmsghdr c;
    if (message.msg_controllen - at < sizeof(c)) { valid_control = 0; break; }
    memcpy(&c, ancillary.bytes + at, sizeof(c));
    if (c.cmsg_len < CMSG_LEN(0) || c.cmsg_len > message.msg_controllen - at) { valid_control = 0; break; }
    size_t payload = c.cmsg_len - CMSG_LEN(0);
    if (c.cmsg_level == SOL_SOCKET && c.cmsg_type == SCM_RIGHTS) {
      for (size_t j = 0; j + sizeof(int) <= payload; j += sizeof(int)) {
        int fd; memcpy(&fd, ancillary.bytes + at + CMSG_LEN(0) + j, sizeof(fd));
        if (fd < 0 || u->received_count == 8) { valid_control = 0; break; }
        u->received_rights[u->received_count++] = fd;
      }
      if (payload != sizeof(int)) valid_control = 0;
    } else valid_control = 0;
    messages++;
    size_t step = CMSG_ALIGN(c.cmsg_len);
    if (step > message.msg_controllen - at) { valid_control = 0; break; }
    at += step;
  }
  if (n != (ssize_t)sizeof(fact) || (message.msg_flags & ~(MSG_CMSG_CLOEXEC | MSG_EOR)) ||
      !valid_control || messages != 1 || u->received_count != 1 ||
      message.msg_controllen != CMSG_SPACE(sizeof(int)) ||
      fact.device != u->identity.device || fact.inode != u->identity.inode || fact.cookie != u->cookie) {
    errno = EPROTO; return -1;
  }
  u->guest = u->received_rights[0]; u->received_rights[0] = -1; u->received_count = 0;
  if (oci_uplink_socket_identity(u->guest, u->cookie, &u->guest_port) < 0) { errno = EPROTO; return -1; }
  left = oci_egress_left(deadline);
  if (left < 0 || oci_uplink_join(u, left) < 0 || !u->child_ok ||
      oci_uplink_close_fd(u, &u->channel) < 0 || oci_uplink_original(u) < 0) return -1;
  return 0;
}

static int oci_uplink_dump_side(struct oci_uplink_owner *u, int guest, uint16_t type, struct oci_uplink_dump *out) {
  if (!out || oci_uplink_original(u) < 0 || !u->child_joined || !u->child_ok ||
      (guest ? u->guest : u->host) < 0 || u->sequence == UINT32_MAX) return -1;
  struct { struct nlmsghdr h; union {struct ifinfomsg link; struct ifaddrmsg addr; struct rtmsg route; struct fib_rule_hdr rule;} p; } request;
  memset(&request, 0, sizeof(request)); request.h.nlmsg_type = type;
  size_t fixed = type == RTM_GETLINK ? sizeof(request.p.link) : type == RTM_GETADDR ? sizeof(request.p.addr) :
    type == RTM_GETROUTE ? sizeof(request.p.route) : type == RTM_GETRULE ? sizeof(request.p.rule) : 0;
  if (!fixed) { errno = EINVAL; return -1; }
  request.h.nlmsg_len = (uint32_t)NLMSG_LENGTH(fixed); request.h.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
  request.h.nlmsg_seq = ++u->sequence;
  struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
  struct iovec iov = {&request, request.h.nlmsg_len};
  struct msghdr message = {.msg_name = &kernel, .msg_namelen = sizeof(kernel), .msg_iov = &iov, .msg_iovlen = 1};
  int64_t now = oci_now(); if (now < 0) return -1; int64_t deadline = now + 2500;
  int fd = guest ? u->guest : u->host;
  if (sendmsg(fd, &message, MSG_NOSIGNAL) != (ssize_t)request.h.nlmsg_len) goto fail;
  memset(out, 0, sizeof(*out)); out->sequence = request.h.nlmsg_seq; out->port = guest ? u->guest_port : u->host_port;
  out->type = type == RTM_GETLINK ? RTM_NEWLINK : type == RTM_GETADDR ? RTM_NEWADDR : type == RTM_GETROUTE ? RTM_NEWROUTE : RTM_NEWRULE;
  while (!out->done) {
    int left = oci_egress_left(deadline); if (left < 0 || (!u->cleaning && oci_not_canceled() < 0)) goto fail;
    struct pollfd p = {.fd = fd, .events = POLLIN};
    if (poll(&p, 1, left) != 1 || p.revents != POLLIN) goto fail;
    union {struct nlmsghdr align; unsigned char bytes[OCI_UPLINK_PACKET_MAX];} packet;
    struct sockaddr_nl source; memset(&source, 0, sizeof(source));
    struct iovec received = {packet.bytes, sizeof(packet.bytes)};
    struct msghdr actual = {.msg_name = &source, .msg_namelen = sizeof(source), .msg_iov = &received, .msg_iovlen = 1};
    ssize_t n = recvmsg(fd, &actual, MSG_DONTWAIT);
    if (n <= 0 || actual.msg_flags || actual.msg_namelen != sizeof(source) ||
        source.nl_family != AF_NETLINK || source.nl_pid || source.nl_groups || actual.msg_controllen ||
        oci_uplink_dump_feed(out, packet.bytes, (size_t)n) < 0) goto fail;
  }
  uint32_t port;
  if (oci_uplink_socket_identity(fd, guest ? u->cookie : u->host_cookie, &port) < 0 ||
      port != (guest ? u->guest_port : u->host_port) || oci_uplink_original(u) < 0) goto fail;
  return 0;
fail:
  u->broken = 1; if (!errno) errno = EPROTO; return -1;
}
static int oci_uplink_file_current(struct oci_uplink_owner *u) {
  if (!u->file_selected) return 0;
  struct stat held, named;
  if (fstat(u->file, &held) < 0 || fstatat(u->original->root, OCI_UPLINK_FILE, &named, AT_SYMLINK_NOFOLLOW) < 0 ||
      !S_ISREG(held.st_mode) || held.st_uid || (held.st_mode & 07777) != 0600 || held.st_nlink != 1 ||
      !oci_egress_same_stat(&held, &u->file_identity) || !oci_same(&held, &named)) { errno = ESTALE; return -1; }
  char bytes[4096]; size_t at = 0;
  while (at < u->file_size) {
    size_t n = u->file_size - at; if (n > sizeof(bytes)) n = sizeof(bytes);
    if (pread(u->file, bytes, n, (off_t)at) != (ssize_t)n || memcmp(bytes, u->file_bytes + at, n)) { errno = ESTALE; return -1; }
    at += n;
  }
  if (pread(u->file, bytes, 1, (off_t)at) != 0 || fstat(u->file, &held) < 0 ||
      !oci_egress_same_stat(&held, &u->file_identity)) { errno = ESTALE; return -1; }
  return 0;
}
static int oci_uplink_current(struct tns_oci_owner *o) {
  return o->uplink ? oci_uplink_file_current(o->uplink) : 0;
}
static int oci_uplink_select(struct tns_oci_owner *o, struct oci_uplink_owner **slot) {
  if (!o || !slot || *slot) { errno = EALREADY; return -1; }
  struct oci_uplink_owner *u = calloc(1, sizeof(*u));
  if (!u) return -1;
  int fd = openat(o->root, OCI_UPLINK_FILE, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) { int saved = errno; free(u); errno = saved; return saved == ENOENT ? 0 : -1; }
  *slot = u; u->original = o; u->controller = getpid(); u->file = fd;
  u->guest = u->host = u->channel = u->child_pidfd = u->netfd = u->lock_root = u->lock = -1;
  if (!o->egress_selected || o->controller_pid != u->controller || oci_inputs(o) < 0 ||
      fstat(fd, &u->file_identity) < 0 || !S_ISREG(u->file_identity.st_mode) || u->file_identity.st_uid ||
      (u->file_identity.st_mode & 07777) != 0600 || u->file_identity.st_nlink != 1 ||
      u->file_identity.st_size < 1 || u->file_identity.st_size > 32768) { errno = EPROTO; return -1; }
  u->file_size = (size_t)u->file_identity.st_size; u->file_selected = 1;
  if (pread(fd, u->file_bytes, u->file_size, 0) != (ssize_t)u->file_size ||
      oci_uplink_topology(u->file_bytes, u->file_size, o->receipt_bytes, o->receipt_size, &u->expected) < 0 ||
      oci_uplink_file_current(u) < 0) { errno = EPROTO; return -1; }
  memcpy(u->host_name, "tkh", 3); memcpy(u->host_name + 3, o->id, 12);
  memcpy(u->guest_name, "tkg", 3); memcpy(u->guest_name + 3, o->id, 12);
  return oci_not_canceled();
}
static int oci_uplink_host_current(struct oci_uplink_owner *u) {
  struct tns_identity before, held, after; struct stat st; struct statfs fs;
  if (tns_owner_observe_creator(u->original->birth, &before) < 0 ||
      !tns_identity_equal(&before, &u->creator) || fstat(u->netfd, &st) < 0 || fstatfs(u->netfd, &fs) < 0 ||
      (unsigned long)fs.f_type != (unsigned long)NSFS_MAGIC || ioctl(u->netfd, NS_GET_NSTYPE) != CLONE_NEWNET) return -1;
  held = (struct tns_identity){(uint64_t)st.st_dev, (uint64_t)st.st_ino};
  if (!tns_identity_equal(&held, &before) || tns_owner_observe_creator(u->original->birth, &after) < 0 ||
      !tns_identity_equal(&before, &after)) { errno = ESTALE; return -1; }
  return 0;
}
static int oci_uplink_host_channel(struct oci_uplink_owner *u) {
  if (!u || !u->child_joined || !u->child_ok || u->guest < 0 || u->host >= 0 || oci_uplink_original(u) < 0 ||
      tns_owner_observe_creator(u->original->birth, &u->creator) < 0) return -1;
  u->netfd = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
  if (u->netfd < 0 || oci_uplink_host_current(u) < 0) return -1;
  u->host = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC | SOCK_NONBLOCK, NETLINK_ROUTE);
  int one = 1; struct sockaddr_nl local = {.nl_family = AF_NETLINK}; socklen_t size = sizeof(u->host_cookie);
  if (u->host < 0 || setsockopt(u->host, SOL_NETLINK, NETLINK_GET_STRICT_CHK, &one, sizeof(one)) < 0 ||
      setsockopt(u->host, SOL_NETLINK, NETLINK_EXT_ACK, &one, sizeof(one)) < 0 ||
      setsockopt(u->host, SOL_NETLINK, NETLINK_CAP_ACK, &one, sizeof(one)) < 0 ||
      bind(u->host, (struct sockaddr *)&local, sizeof(local)) < 0 ||
      getsockopt(u->host, SOL_SOCKET, SO_NETNS_COOKIE, &u->host_cookie, &size) < 0 ||
      size != sizeof(u->host_cookie) || !u->host_cookie || u->host_cookie == u->cookie ||
      oci_uplink_socket_identity(u->host, u->host_cookie, &u->host_port) < 0 || oci_uplink_original(u) < 0) return -1;
  return 0;
}
/* These GETs use the original Host socket namespace. The ifr_name lookup is
 * bookended by actual name/index/MAC and socket-cookie observations. Matching
 * facts do not establish an immutable hardware incarnation or onward path. */
static int oci_uplink_driver_link(struct oci_uplink_owner *u) {
  struct ifreq request; uint32_t port = 0;
  if (u->host < 0 || !u->host_port || !u->host_cookie || !u->child_joined || !u->child_ok ||
      oci_uplink_original(u) < 0 || oci_uplink_socket_identity(u->host, u->host_cookie, &port) < 0 ||
      port != u->host_port) { if (!errno) errno = ESTALE; return -1; }
  memset(&request, 0, sizeof(request)); memcpy(request.ifr_name, u->expected.name, sizeof(request.ifr_name));
  if (ioctl(u->host, SIOCGIFINDEX, &request) != 0 ||
      memcmp(request.ifr_name, u->expected.name, sizeof(request.ifr_name)) ||
      request.ifr_ifindex <= 0 || (uint32_t)request.ifr_ifindex != u->expected.index) { if (!errno) errno = ESTALE; return -1; }
  memset(&request, 0, sizeof(request)); memcpy(request.ifr_name, u->expected.name, sizeof(request.ifr_name));
  if (ioctl(u->host, SIOCGIFHWADDR, &request) != 0 ||
      memcmp(request.ifr_name, u->expected.name, sizeof(request.ifr_name)) ||
      request.ifr_hwaddr.sa_family != ARPHRD_ETHER || memcmp(request.ifr_hwaddr.sa_data, u->expected.mac, 6)) {
    if (!errno) errno = ESTALE;
    return -1;
  }
  if (oci_uplink_socket_identity(u->host, u->host_cookie, &port) < 0 || port != u->host_port ||
      oci_uplink_original(u) < 0) { if (!errno) errno = ESTALE; return -1; }
  return 0;
}
static int oci_uplink_driver_string(char *bytes, size_t size, int required) {
  char *end = memchr(bytes, 0, size);
  if (!end || (required && end == bytes)) { errno = EPROTO; return -1; }
  /* Padding is not a driver fact. Preserve every bounded string byte. */
  memset(end, 0, size - (size_t)(end - bytes)); return 0;
}
static int oci_uplink_driver_current(struct oci_uplink_owner *u) {
  struct oci_uplink_driver_facts fresh; struct ifreq request;
  if (!u || u->cleaning || oci_uplink_original(u) < 0) return -1;
  if (!u->driver_captured) {
    /* A failed first observation cannot be adopted later after pair effects. */
    if (u->create_sent || tns_oci_once(&u->driver_attempted) < 0) { errno = EALREADY; return -1; }
  }
  if (oci_uplink_driver_link(u) < 0) return -1;
  memset(&fresh, 0, sizeof(fresh)); fresh.driver.cmd = ETHTOOL_GDRVINFO;
  memset(&request, 0, sizeof(request)); memcpy(request.ifr_name, u->expected.name, sizeof(request.ifr_name));
  request.ifr_data = (char *)&fresh.driver;
  if (ioctl(u->host, SIOCETHTOOL, &request) != 0 || fresh.driver.cmd != ETHTOOL_GDRVINFO ||
      memcmp(request.ifr_name, u->expected.name, sizeof(request.ifr_name)) || request.ifr_data != (char *)&fresh.driver ||
      oci_uplink_driver_string(fresh.driver.driver, sizeof(fresh.driver.driver), 1) < 0 ||
      oci_uplink_driver_string(fresh.driver.version, sizeof(fresh.driver.version), 0) < 0 ||
      oci_uplink_driver_string(fresh.driver.fw_version, sizeof(fresh.driver.fw_version), 0) < 0 ||
      oci_uplink_driver_string(fresh.driver.bus_info, sizeof(fresh.driver.bus_info), 0) < 0 ||
      oci_uplink_driver_string(fresh.driver.erom_version, sizeof(fresh.driver.erom_version), 0) < 0) {
    if (!errno) errno = EPROTO;
    return -1;
  }
  for (size_t i = 0; i < sizeof(fresh.driver.reserved2); ++i)
    if (fresh.driver.reserved2[i]) { errno = EPROTO; return -1; }
  fresh.features.cmd = ETHTOOL_GFEATURES; fresh.features.size = OCI_UPLINK_FEATURE_WORDS;
  memset(&request, 0, sizeof(request)); memcpy(request.ifr_name, u->expected.name, sizeof(request.ifr_name));
  request.ifr_data = (char *)&fresh.features;
  if (oci_uplink_original(u) < 0 || ioctl(u->host, SIOCETHTOOL, &request) != 0 ||
      fresh.features.cmd != ETHTOOL_GFEATURES || !fresh.features.size || fresh.features.size > OCI_UPLINK_FEATURE_WORDS ||
      memcmp(request.ifr_name, u->expected.name, sizeof(request.ifr_name)) || request.ifr_data != (char *)&fresh.features ||
      oci_uplink_driver_link(u) < 0 || oci_uplink_original(u) < 0) { if (!errno) errno = EPROTO; return -1; }
  /* Linux copies exactly min(input capacity, returned size) complete blocks on
   * zero. EFAULT, positive returns and a size exceeding capacity all refuse. */
  for (size_t i = fresh.features.size; i < OCI_UPLINK_FEATURE_WORDS; ++i)
    if (memcmp(&fresh.features.blocks[i], &(struct ethtool_get_features_block){0}, sizeof(fresh.features.blocks[i]))) {
      errno = EPROTO; return -1;
    }
  if (u->driver_captured) {
    if (memcmp(&u->driver_facts, &fresh, sizeof(fresh))) { errno = ESTALE; return -1; }
  } else {
    u->driver_facts = fresh; u->driver_captured = 1;
  }
  return 0;
}
/* Cooperating allocation exclusion, not traffic or namespace authority. A
 * single fixed Host-local lock also serializes distinct original namespaces. */
static int oci_uplink_lock_current(struct oci_uplink_owner *u) {
  struct stat held, named;
  if (u->lock_root < 0 || u->lock < 0 || oci_owned(u->lock_root, 1, 0) < 0 ||
      fstat(u->lock, &held) < 0 || fstatat(u->lock_root, "tako-terminal-uplink.lock", &named, AT_SYMLINK_NOFOLLOW) < 0 ||
      !S_ISREG(held.st_mode) || held.st_uid || (held.st_mode & 07777) != 0600 || held.st_nlink != 1 ||
      !oci_same(&held, &named) || !oci_same(&held, &u->lock_identity)) { errno = ESTALE; return -1; }
  return 0;
}
static int oci_uplink_lock(struct oci_uplink_owner *u) {
  if (u->lock_held) return oci_uplink_lock_current(u);
  if (oci_uplink_original(u) < 0) return -1;
  if (u->lock < 0) {
    u->lock_root = oci_open_absolute("/run", 1);
    if (u->lock_root < 0 || oci_owned(u->lock_root, 1, 0) < 0 || oci_uplink_host_current(u) < 0) return -1;
    u->lock = openat(u->lock_root, "tako-terminal-uplink.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600);
    if (u->lock < 0 || fstat(u->lock, &u->lock_identity) < 0 || oci_uplink_lock_current(u) < 0) return -1;
  }
  struct flock lock = {.l_type = F_WRLCK, .l_whence = SEEK_SET};
  if (fcntl(u->lock, F_OFD_SETLK, &lock) < 0) return -1;
  u->lock_held = 1;
  return oci_uplink_lock_current(u);
}
static int oci_uplink_unlock(struct oci_uplink_owner *u) {
  if (!u->lock_held) return 0;
  if (oci_uplink_lock_current(u) < 0) return -1;
  struct flock lock = {.l_type = F_UNLCK, .l_whence = SEEK_SET};
  if (fcntl(u->lock, F_OFD_SETLK, &lock) < 0) { u->broken = 1; return -1; }
  u->lock_held = 0; return 0;
}
/* All attributes are structurally decoded. Duplicate types, unknown flags and
 * unrecognized semantic attributes in the narrow selectors refuse. */
struct oci_uplink_attrs { const unsigned char *p[128]; size_t size[128]; };
static int oci_uplink_attrs(const unsigned char *bytes, size_t size, struct oci_uplink_attrs *out) {
  memset(out, 0, sizeof(*out)); size_t at = 0;
  while (at < size) {
    struct rtattr h; if (size - at < sizeof(h)) return -1; memcpy(&h, bytes + at, sizeof(h));
    unsigned int type = (unsigned int)h.rta_type & (unsigned int)(uint16_t)NLA_TYPE_MASK;
    if (!type || type >= 128 || (h.rta_type & NLA_F_NET_BYTEORDER) || out->p[type] ||
        h.rta_len < sizeof(h) || h.rta_len > size - at || RTA_ALIGN((size_t)h.rta_len) > size - at) return -1;
    out->p[type] = bytes + at + sizeof(h); out->size[type] = h.rta_len - sizeof(h); at += RTA_ALIGN((size_t)h.rta_len);
  }
  return 0;
}
static int oci_uplink_u32(const struct oci_uplink_attrs *a, unsigned int type, uint32_t *out) {
  if (!a->p[type] || a->size[type] != sizeof(*out)) return -1;
  memcpy(out, a->p[type], sizeof(*out)); return 0;
}
static int oci_uplink_text(const struct oci_uplink_attrs *a, unsigned int type, const char *expected) {
  size_t n = strlen(expected) + 1; return a->p[type] && a->size[type] == n && !memcmp(a->p[type], expected, n) ? 0 : -1;
}
static int oci_uplink_records(const struct oci_uplink_dump *d) {
  return d && d->done && !d->failed && d->records && d->used ? 0 : -1;
}
/* The fixed v6.12 RTM_NEWLINK producer always reports this subtree,
 * including a no-program NONE. Missing state is not a NONE observation.
 * a comes only from the complete validated parent attribute span above.
 * This snapshot refuses XDP; it does not lock later attachment or offloads.
 */
static int oci_uplink_xdp(const struct oci_uplink_attrs *a) {
  const unsigned char *p = a->p[IFLA_XDP];
  struct rtattr outer, attached;
  if (!p || a->size[IFLA_XDP] != RTA_ALIGN(RTA_LENGTH(sizeof(uint8_t)))) return -1;
  memcpy(&outer, p - sizeof(outer), sizeof(outer));
  memcpy(&attached, p, sizeof(attached));
  if (outer.rta_type != IFLA_XDP || attached.rta_type != IFLA_XDP_ATTACHED ||
      attached.rta_len != RTA_LENGTH(sizeof(uint8_t)) || p[sizeof(attached)] != XDP_ATTACHED_NONE) return -1;
  return 0;
}
static int oci_uplink_link(const unsigned char *bytes, size_t size, const char *name,
                             uint32_t index, unsigned char mac[6], uint32_t *peer, int uplink) {
  struct ifinfomsg h; if (size < sizeof(h)) return -1; memcpy(&h, bytes, sizeof(h));
  struct oci_uplink_attrs a;
  if (h.ifi_index <= 0 || (index && (uint32_t)h.ifi_index != index) || h.ifi_type != ARPHRD_ETHER ||
      (h.ifi_flags & (IFF_LOOPBACK | IFF_POINTOPOINT)) || (uplink && !(h.ifi_flags & IFF_UP)) ||
      oci_uplink_attrs(bytes + NLMSG_ALIGN(sizeof(h)), size - NLMSG_ALIGN(sizeof(h)), &a) < 0 ||
      oci_uplink_xdp(&a) < 0 || oci_uplink_text(&a, IFLA_IFNAME, name) < 0 || !a.p[IFLA_ADDRESS] || a.size[IFLA_ADDRESS] != 6 ||
      (a.p[IFLA_ADDRESS][0] & 1)) return -1;
  static const unsigned char zero[6] = {0}; if (!memcmp(a.p[IFLA_ADDRESS], zero, 6)) return -1;
  uint32_t master = 0; if (a.p[IFLA_MASTER] && (oci_uplink_u32(&a, IFLA_MASTER, &master) < 0 || master)) return -1;
  if (!uplink) {
    struct oci_uplink_attrs info;
    if (!a.p[IFLA_LINKINFO] || oci_uplink_attrs(a.p[IFLA_LINKINFO], a.size[IFLA_LINKINFO], &info) < 0 ||
        oci_uplink_text(&info, IFLA_INFO_KIND, "veth") < 0 || oci_uplink_u32(&a, IFLA_LINK, peer) < 0 || !*peer) return -1;
  }
  memcpy(mac, a.p[IFLA_ADDRESS], 6); return h.ifi_index;
}
static int oci_uplink_host_links(struct oci_uplink_owner *u, const struct oci_uplink_dump *d) {
  if (oci_uplink_records(d) < 0 || d->type != RTM_NEWLINK) return -1;
  unsigned int matches = 0; size_t at = 0;
  while (at < d->used) {
    struct nlmsghdr n; memcpy(&n, d->bytes + at, sizeof(n)); const unsigned char *body = d->bytes + at + NLMSG_HDRLEN;
    struct ifinfomsg h; memcpy(&h, body, sizeof(h)); struct oci_uplink_attrs a;
    if (h.ifi_index <= 0 || oci_uplink_attrs(body + NLMSG_ALIGN(sizeof(h)), n.nlmsg_len - NLMSG_LENGTH(sizeof(h)), &a) < 0) return -1;
    if (!u->create_sent && (oci_uplink_text(&a, IFLA_IFNAME, u->host_name) == 0 || oci_uplink_text(&a, IFLA_IFNAME, u->guest_name) == 0)) return -1;
    if ((uint32_t)h.ifi_index == u->expected.index || oci_uplink_text(&a, IFLA_IFNAME, u->expected.name) == 0) {
      unsigned char mac[6]; uint32_t peer = 0;
      if (++matches != 1 || oci_uplink_link(body, n.nlmsg_len - NLMSG_HDRLEN, u->expected.name, u->expected.index, mac, &peer, 1) < 0 ||
          memcmp(mac, u->expected.mac, 6)) return -1;
    }
    at += NLMSG_ALIGN((size_t)n.nlmsg_len);
  }
  return matches == 1 ? 0 : -1;
}
static int oci_uplink_host_addresses(struct oci_uplink_owner *u, const struct oci_uplink_dump *d) {
  if (oci_uplink_records(d) < 0 || d->type != RTM_NEWADDR) return -1;
  unsigned int found4 = 0, found6 = 0; size_t at = 0;
  while (at < d->used) {
    struct nlmsghdr n; memcpy(&n, d->bytes + at, sizeof(n)); const unsigned char *body = d->bytes + at + NLMSG_HDRLEN;
    struct ifaddrmsg h; memcpy(&h, body, sizeof(h)); struct oci_uplink_attrs a;
    if ((h.ifa_family != AF_INET && h.ifa_family != AF_INET6) || !h.ifa_index ||
        oci_uplink_attrs(body + NLMSG_ALIGN(sizeof(h)), n.nlmsg_len - NLMSG_LENGTH(sizeof(h)), &a) < 0) return -1;
    size_t width = h.ifa_family == AF_INET ? 4u : 16u; unsigned int bits = (unsigned int)(width * 8);
    if (h.ifa_prefixlen > bits || !a.p[IFA_ADDRESS] || a.size[IFA_ADDRESS] != width ||
        (a.p[IFA_LOCAL] && (a.size[IFA_LOCAL] != width || memcmp(a.p[IFA_LOCAL], a.p[IFA_ADDRESS], width)))) return -1;
    const unsigned char *ip = a.p[IFA_LOCAL] ? a.p[IFA_LOCAL] : a.p[IFA_ADDRESS];
    uint32_t flags = h.ifa_flags; if (a.p[IFA_FLAGS] && oci_uplink_u32(&a, IFA_FLAGS, &flags) < 0) return -1;
    if (!(u->create_known && h.ifa_index == u->host_index)) {
      const unsigned char *peer = width == 4 ? u->expected.host4 : u->expected.host6;
      unsigned int prefix = width == 4 ? 31u : 127u;
      if (h.ifa_prefixlen < prefix) prefix = h.ifa_prefixlen;
      if (oci_uplink_prefix(ip, peer, prefix)) return -1;
    }
    if (h.ifa_index == u->expected.index) {
      const unsigned char *expected = width == 4 ? u->expected.local4 : u->expected.local6;
      unsigned int prefix = width == 4 ? u->expected.prefix4 : u->expected.prefix6;
      if (!memcmp(ip, expected, width) && h.ifa_prefixlen == prefix) {
        if (flags & (IFA_F_TENTATIVE | IFA_F_DADFAILED | IFA_F_DEPRECATED | IFA_F_OPTIMISTIC | IFA_F_TEMPORARY)) return -1;
        if (width == 4) found4++; else found6++;
      }
    }
    at += NLMSG_ALIGN((size_t)n.nlmsg_len);
  }
  return found4 == 1 && found6 == 1 ? 0 : -1;
}
static int oci_uplink_host_rules(const struct oci_uplink_dump *d) {
  if (oci_uplink_records(d) < 0 || d->type != RTM_NEWRULE) return -1;
  unsigned int found = 0; size_t at = 0;
  while (at < d->used) {
    struct nlmsghdr n; memcpy(&n, d->bytes + at, sizeof(n)); const unsigned char *body = d->bytes + at + NLMSG_HDRLEN;
    struct fib_rule_hdr h; memcpy(&h, body, sizeof(h)); struct oci_uplink_attrs a;
    if ((h.family != AF_INET && h.family != AF_INET6) || h.dst_len || h.src_len || h.tos || h.res1 || h.res2 ||
        h.action != FR_ACT_TO_TBL || h.flags || oci_uplink_attrs(body + NLMSG_ALIGN(sizeof(h)), n.nlmsg_len - NLMSG_LENGTH(sizeof(h)), &a) < 0) return -1;
    uint32_t table = h.table, priority = 0;
    if ((a.p[FRA_TABLE] && oci_uplink_u32(&a, FRA_TABLE, &table) < 0) ||
        (a.p[FRA_PRIORITY] && oci_uplink_u32(&a, FRA_PRIORITY, &priority) < 0)) return -1;
    for (unsigned int i = 1; i < 128; ++i)
      if (a.p[i] && i != FRA_TABLE && i != FRA_PRIORITY && i != FRA_PROTOCOL && i != FRA_SUPPRESS_PREFIXLEN) return -1;
    if ((a.p[FRA_PROTOCOL] && a.size[FRA_PROTOCOL] != 1) ||
        (a.p[FRA_SUPPRESS_PREFIXLEN] && (a.size[FRA_SUPPRESS_PREFIXLEN] != 4 || memcmp(a.p[FRA_SUPPRESS_PREFIXLEN], &(uint32_t){UINT32_MAX}, 4)))) return -1;
    unsigned int bit = table == RT_TABLE_LOCAL && priority == 0 ? 1u : table == RT_TABLE_MAIN && priority == 32766 ? 2u :
      table == RT_TABLE_DEFAULT && priority == 32767 && h.family == AF_INET ? 4u : 0u;
    if (h.family == AF_INET6) bit <<= 3;
    if (!bit || (found & bit)) return -1;
    found |= bit; at += NLMSG_ALIGN((size_t)n.nlmsg_len);
  }
  return found == 31u ? 0 : -1;
}
static int oci_uplink_host_routes(struct oci_uplink_owner *u, const struct oci_uplink_dump *d) {
  if (oci_uplink_records(d) < 0 || d->type != RTM_NEWROUTE) return -1;
  unsigned int found4 = 0, found6 = 0; size_t at = 0;
  while (at < d->used) {
    struct nlmsghdr n; memcpy(&n, d->bytes + at, sizeof(n)); const unsigned char *body = d->bytes + at + NLMSG_HDRLEN;
    struct rtmsg h; memcpy(&h, body, sizeof(h)); struct oci_uplink_attrs a;
    if ((h.rtm_family != AF_INET && h.rtm_family != AF_INET6) || h.rtm_src_len || h.rtm_tos ||
        oci_uplink_attrs(body + NLMSG_ALIGN(sizeof(h)), n.nlmsg_len - NLMSG_LENGTH(sizeof(h)), &a) < 0) return -1;
    size_t width = h.rtm_family == AF_INET ? 4u : 16u; uint32_t table = h.rtm_table, index = 0;
    if (h.rtm_dst_len > width * 8 || (a.p[RTA_TABLE] && oci_uplink_u32(&a, RTA_TABLE, &table) < 0) ||
        (a.p[RTA_OIF] && oci_uplink_u32(&a, RTA_OIF, &index) < 0) || a.p[RTA_MULTIPATH] || a.p[RTA_NH_ID] ||
        a.p[RTA_VIA] || a.p[RTA_ENCAP] || a.p[RTA_ENCAP_TYPE] || a.p[RTA_NEWDST] || a.p[RTA_SRC]) return -1;
    if (h.rtm_dst_len) {
      if (!a.p[RTA_DST] || a.size[RTA_DST] != width) return -1;
      if (!(u->create_known && index == u->host_index)) {
        const unsigned char *peer = width == 4 ? u->expected.host4 : u->expected.host6;
        unsigned int prefix = width == 4 ? 31u : 127u; if (h.rtm_dst_len < prefix) prefix = h.rtm_dst_len;
        if (oci_uplink_prefix(a.p[RTA_DST], peer, prefix)) return -1;
      }
    } else if (table == RT_TABLE_MAIN) {
      const unsigned char *expected = width == 4 ? u->expected.gateway4 : u->expected.gateway6;
      if (h.rtm_type != RTN_UNICAST || h.rtm_scope != RT_SCOPE_UNIVERSE || h.rtm_flags ||
          index != u->expected.index || !a.p[RTA_GATEWAY] || a.size[RTA_GATEWAY] != width ||
          memcmp(a.p[RTA_GATEWAY], expected, width)) return -1;
      if (width == 4) found4++; else found6++;
    }
    at += NLMSG_ALIGN((size_t)n.nlmsg_len);
  }
  return found4 == 1 && found6 == 1 ? 0 : -1;
}
static int oci_uplink_preflight(struct oci_uplink_owner *u) {
  struct oci_uplink_dump *d = malloc(sizeof(*d)); if (!d) return -1;
  int result = -1;
  for (unsigned int i = 0; i < 4; ++i) {
    uint16_t type = i == 0 ? RTM_GETLINK : i == 1 ? RTM_GETADDR : i == 2 ? RTM_GETROUTE : RTM_GETRULE;
    if (oci_uplink_dump_side(u, 0, type, d) < 0) goto done;
    int valid = i == 0 ? oci_uplink_host_links(u, d) : i == 1 ? oci_uplink_host_addresses(u, d) :
      i == 2 ? oci_uplink_host_routes(u, d) : oci_uplink_host_rules(d);
    if (valid < 0) { errno = ESTALE; goto done; }
  }
  if (oci_uplink_driver_current(u) < 0) goto done;
  result = oci_uplink_original(u);
done:
  free(d); return result;
}
/* Fixed builders: no caller script, raw locator, target FD or replace/adopt. */
struct oci_uplink_request { struct nlmsghdr h; unsigned char body[2048]; };
static int oci_uplink_attr(struct oci_uplink_request *r, unsigned int type, const void *bytes, size_t size) {
  size_t at = NLMSG_ALIGN((size_t)r->h.nlmsg_len), n = RTA_LENGTH(size);
  if (n > UINT16_MAX || at > sizeof(*r) || RTA_ALIGN(n) > sizeof(*r) - at) return -1;
  struct rtattr a = {(unsigned short)n, (unsigned short)type};
  memcpy((unsigned char *)r + at, &a, sizeof(a));
  memcpy((unsigned char *)r + at + sizeof(a), bytes, size);
  r->h.nlmsg_len = (uint32_t)(at + RTA_ALIGN(n)); return 0;
}
static size_t oci_uplink_nest(struct oci_uplink_request *r, unsigned int type) {
  size_t at = NLMSG_ALIGN((size_t)r->h.nlmsg_len);
  if (oci_uplink_attr(r, type | NLA_F_NESTED, "", 0) < 0) return 0;
  return at;
}
static int oci_uplink_end(struct oci_uplink_request *r, size_t at) {
  if (!at || at >= r->h.nlmsg_len || r->h.nlmsg_len - at > UINT16_MAX) return -1;
  struct rtattr *a = (struct rtattr *)((unsigned char *)r + at);
  a->rta_len = (uint16_t)(r->h.nlmsg_len - at); return 0;
}
static void oci_uplink_request(struct oci_uplink_request *r, uint16_t type, uint16_t flags, const void *body, size_t size) {
  memset(r, 0, sizeof(*r)); r->h.nlmsg_len = (uint32_t)NLMSG_LENGTH(size);
  r->h.nlmsg_type = type; r->h.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | flags;
  memcpy(r->body, body, size);
}
/* CAP_ACK makes the exact successful ACK bounded. Negative/extended/error
 * replies are refusals, never zero observations. Send is one-use even on loss. */
static int oci_uplink_ack(const void *bytes, size_t size, const struct nlmsghdr *request, uint32_t port) {
  struct nlmsghdr h; struct nlmsgerr e;
  if (size != NLMSG_LENGTH(sizeof(e))) return -1;
  memcpy(&h, bytes, sizeof(h)); memcpy(&e, (const unsigned char *)bytes + NLMSG_HDRLEN, sizeof(e));
  if (h.nlmsg_len != size || h.nlmsg_type != NLMSG_ERROR || h.nlmsg_flags != NLM_F_CAPPED ||
      h.nlmsg_seq != request->nlmsg_seq || h.nlmsg_pid != port || e.error > 0 || e.error < -4095 ||
      memcmp(&e.msg, request, sizeof(*request))) return -1;
  if (e.error) { errno = -e.error; return 1; }
  return 0;
}
static int oci_uplink_mutate(struct oci_uplink_owner *u, int guest, struct oci_uplink_request *r) {
  if (!u->lock_held || oci_uplink_original(u) < 0 || u->sequence == UINT32_MAX) return -1;
  int fd = guest ? u->guest : u->host; uint32_t port = guest ? u->guest_port : u->host_port;
  if (fd < 0 || !port) { errno = EBADF; return -1; }
  r->h.nlmsg_seq = ++u->sequence;
  struct sockaddr_nl kernel = {.nl_family = AF_NETLINK}; struct iovec iov = {r, r->h.nlmsg_len};
  struct msghdr message = {.msg_name = &kernel, .msg_namelen = sizeof(kernel), .msg_iov = &iov, .msg_iovlen = 1};
  int64_t now = oci_now(); if (now < 0) return -1; int64_t deadline = now + 2500;
  if (sendmsg(fd, &message, MSG_NOSIGNAL) != (ssize_t)r->h.nlmsg_len) goto fail;
  int left = oci_egress_left(deadline); struct pollfd p = {.fd = fd, .events = POLLIN};
  if (left < 0 || poll(&p, 1, left) != 1 || p.revents != POLLIN) goto fail;
  union { struct nlmsghdr align; unsigned char bytes[4096]; } packet;
  struct sockaddr_nl source; memset(&source, 0, sizeof(source));
  struct iovec received = {packet.bytes, sizeof(packet.bytes)};
  struct msghdr actual = {.msg_name = &source, .msg_namelen = sizeof(source), .msg_iov = &received, .msg_iovlen = 1};
  ssize_t n = recvmsg(fd, &actual, MSG_DONTWAIT);
  if (n <= 0 || actual.msg_flags || actual.msg_namelen != sizeof(source) || source.nl_family != AF_NETLINK ||
      source.nl_pid || source.nl_groups || actual.msg_controllen) goto fail;
  int acknowledged = oci_uplink_ack(packet.bytes, (size_t)n, &r->h, port);
  if (acknowledged < 0) goto fail;
  if (acknowledged > 0) return -1; /* Exact rejected request, no socket resync. */
  if (oci_uplink_original(u) < 0) goto fail;
  return 0;
fail:
  u->broken = 1; if (!errno) errno = EPROTO; return -1;
}
static int oci_uplink_pair(struct oci_uplink_owner *u) {
  struct oci_uplink_dump *d = malloc(sizeof(*d)); if (!d) return -1;
  int result = -1; uint32_t indices[2] = {0}, peers[2] = {0};
  for (unsigned int side = 0; side < 2; ++side) {
    if (oci_uplink_dump_side(u, (int)side, RTM_GETLINK, d) < 0) goto done;
    unsigned int found = 0; size_t at = 0;
    while (at < d->used) {
      struct nlmsghdr n; memcpy(&n, d->bytes + at, sizeof(n));
      const unsigned char *body = d->bytes + at + NLMSG_HDRLEN; struct ifinfomsg h; memcpy(&h, body, sizeof(h));
      struct oci_uplink_attrs a;
      if (oci_uplink_attrs(body + NLMSG_ALIGN(sizeof(h)), n.nlmsg_len - NLMSG_LENGTH(sizeof(h)), &a) < 0) goto done;
      const char *name = side ? u->guest_name : u->host_name;
      uint32_t expected = side ? u->guest_index : u->host_index;
      if (oci_uplink_text(&a, IFLA_IFNAME, name) == 0 || (expected && (uint32_t)h.ifi_index == expected)) {
        unsigned char mac[6]; unsigned char *saved = side ? u->guest_mac : u->host_mac;
        int index = oci_uplink_link(body, n.nlmsg_len - NLMSG_HDRLEN, name, expected, mac, &peers[side], 0);
        if (++found != 1 || index < 0 || memcmp(mac, saved, 6) ||
            (u->configured && !(h.ifi_flags & IFF_UP))) goto done;
        indices[side] = (uint32_t)index;
      }
      at += NLMSG_ALIGN((size_t)n.nlmsg_len);
    }
    if (found != 1) goto done;
  }
  if (peers[0] != indices[1] || peers[1] != indices[0]) goto done;
  u->host_index = indices[0]; u->guest_index = indices[1]; result = oci_uplink_original(u);
done:
  free(d); if (result < 0 && !errno) errno = ESTALE; return result;
}
static int oci_uplink_fresh_guest(struct oci_uplink_owner *u) {
  struct oci_uplink_dump *d = malloc(sizeof(*d)); if (!d) return -1; int result = -1;
  if (oci_uplink_dump_side(u, 1, RTM_GETLINK, d) < 0 || d->records != 1) goto done;
  struct nlmsghdr n; memcpy(&n, d->bytes, sizeof(n)); struct ifinfomsg h;
  memcpy(&h, d->bytes + NLMSG_HDRLEN, sizeof(h)); struct oci_uplink_attrs a;
  if (h.ifi_type != ARPHRD_LOOPBACK || !(h.ifi_flags & IFF_LOOPBACK) || (h.ifi_flags & IFF_UP) ||
      oci_uplink_attrs(d->bytes + NLMSG_HDRLEN + NLMSG_ALIGN(sizeof(h)), n.nlmsg_len - NLMSG_LENGTH(sizeof(h)), &a) < 0 ||
      oci_uplink_text(&a, IFLA_IFNAME, "lo") < 0) goto done;
  for (unsigned int i = 0; i < 2; ++i)
    if (oci_uplink_dump_side(u, 1, i ? RTM_GETROUTE : RTM_GETADDR, d) < 0 || d->records) goto done;
  if (oci_uplink_dump_side(u, 1, RTM_GETRULE, d) < 0 || oci_uplink_host_rules(d) < 0) goto done;
  result = oci_uplink_original(u);
done:
  free(d); if (result < 0 && !errno) errno = ESTALE; return result;
}
static int oci_uplink_new_pair(struct oci_uplink_owner *u) {
  if (u->create_sent || oci_uplink_preflight(u) < 0 || oci_uplink_fresh_guest(u) < 0) return -1;
  /* Original claim determines names/MACs; EXCL and both-namespace readback are
   * mandatory. No positive lookup/adoption if this send's ACK is missing. */
  for (unsigned int i = 0; i < 6; ++i) {
    char a = u->original->id[i * 2], b = u->original->id[i * 2 + 1];
    u->host_mac[i] = (unsigned char)((a <= '9' ? a-'0' : a-'a'+10) * 16 + (b <= '9' ? b-'0' : b-'a'+10));
  }
  u->host_mac[0] = (u->host_mac[0] & 0xfcu) | 2u; memcpy(u->guest_mac, u->host_mac, 6); u->guest_mac[5] ^= 1u;
  struct ifinfomsg h = {.ifi_family = AF_UNSPEC}; struct oci_uplink_request r;
  oci_uplink_request(&r, RTM_NEWLINK, NLM_F_CREATE | NLM_F_EXCL, &h, sizeof(h));
  if (oci_uplink_attr(&r, IFLA_IFNAME, u->host_name, strlen(u->host_name) + 1) < 0 ||
      oci_uplink_attr(&r, IFLA_ADDRESS, u->host_mac, 6) < 0) return -1;
  size_t info = oci_uplink_nest(&r, IFLA_LINKINFO);
  if (!info || oci_uplink_attr(&r, IFLA_INFO_KIND, "veth", 5) < 0) return -1;
  size_t data = oci_uplink_nest(&r, IFLA_INFO_DATA), peer = oci_uplink_nest(&r, VETH_INFO_PEER);
  if (!data || !peer || r.h.nlmsg_len + sizeof(h) > sizeof(r)) return -1;
  memcpy((unsigned char *)&r + r.h.nlmsg_len, &h, sizeof(h)); r.h.nlmsg_len += sizeof(h);
  if (oci_uplink_attr(&r, IFLA_IFNAME, u->guest_name, strlen(u->guest_name) + 1) < 0 ||
      oci_uplink_attr(&r, IFLA_ADDRESS, u->guest_mac, 6) < 0 ||
      oci_uplink_attr(&r, IFLA_NET_NS_FD, &u->original->network, sizeof(int)) < 0 ||
      oci_uplink_end(&r, peer) < 0 || oci_uplink_end(&r, data) < 0 || oci_uplink_end(&r, info) < 0 ||
      oci_uplink_original(u) < 0) return -1;
  u->create_sent = 1; /* Consumed BEFORE send; every ambiguity is retained. */
  if (oci_uplink_mutate(u, 0, &r) < 0) return -1;
  u->create_known = 1;
  if (oci_uplink_pair(u) < 0) return -1;
  u->pair_known = 1; return 0;
}
static int oci_uplink_address(struct oci_uplink_owner *u, int guest, int family) {
  uint32_t index = guest ? u->guest_index : u->host_index, flags = family == AF_INET6 ? IFA_F_NODAD : 0;
  struct ifaddrmsg h = {.ifa_family = (unsigned char)family, .ifa_prefixlen = family == AF_INET ? 31 : 127,
    .ifa_flags = (unsigned char)flags, .ifa_scope = RT_SCOPE_UNIVERSE, .ifa_index = index};
  const void *ip = family == AF_INET ? (guest ? u->expected.guest4 : u->expected.host4) : (guest ? u->expected.guest6 : u->expected.host6);
  size_t size = family == AF_INET ? 4u : 16u; struct oci_uplink_request r;
  oci_uplink_request(&r, RTM_NEWADDR, NLM_F_CREATE | NLM_F_EXCL, &h, sizeof(h));
  if (oci_uplink_attr(&r, IFA_LOCAL, ip, size) < 0 || oci_uplink_attr(&r, IFA_ADDRESS, ip, size) < 0 ||
      oci_uplink_attr(&r, IFA_FLAGS, &flags, sizeof(flags)) < 0) return -1;
  return oci_uplink_mutate(u, guest, &r);
}
static int oci_uplink_route(struct oci_uplink_owner *u, int family) {
  struct rtmsg h = {.rtm_family = (unsigned char)family, .rtm_table = RT_TABLE_MAIN, .rtm_protocol = RTPROT_STATIC,
    .rtm_scope = RT_SCOPE_UNIVERSE, .rtm_type = RTN_UNICAST}; struct oci_uplink_request r;
  oci_uplink_request(&r, RTM_NEWROUTE, NLM_F_CREATE | NLM_F_EXCL, &h, sizeof(h));
  const void *ip = family == AF_INET ? (const void *)u->expected.host4 : (const void *)u->expected.host6;
  if (oci_uplink_attr(&r, RTA_GATEWAY, ip, family == AF_INET ? 4u : 16u) < 0 ||
      oci_uplink_attr(&r, RTA_OIF, &u->guest_index, sizeof(u->guest_index)) < 0) return -1;
  return oci_uplink_mutate(u, 1, &r);
}
static int oci_uplink_config_readback(struct oci_uplink_owner *u) {
  struct oci_uplink_dump *d = malloc(sizeof(*d)); if (!d) return -1; int result = -1;
  for (unsigned int side = 0; side < 2; ++side) {
    if (oci_uplink_dump_side(u, (int)side, RTM_GETADDR, d) < 0) goto done;
    unsigned int found4 = 0, found6 = 0; size_t at = 0;
    while (at < d->used) {
      struct nlmsghdr n; memcpy(&n, d->bytes + at, sizeof(n)); struct ifaddrmsg h;
      const unsigned char *body = d->bytes + at + NLMSG_HDRLEN; memcpy(&h, body, sizeof(h)); struct oci_uplink_attrs a;
      if (oci_uplink_attrs(body + NLMSG_ALIGN(sizeof(h)), n.nlmsg_len - NLMSG_LENGTH(sizeof(h)), &a) < 0) goto done;
      if (h.ifa_index == (side ? u->guest_index : u->host_index)) {
        size_t width = h.ifa_family == AF_INET ? 4u : h.ifa_family == AF_INET6 ? 16u : 0;
        if (!width || !a.p[IFA_ADDRESS] || a.size[IFA_ADDRESS] != width) goto done;
        const void *ip = width == 4 ? (const void *)(side ? u->expected.guest4 : u->expected.host4) : (const void *)(side ? u->expected.guest6 : u->expected.host6);
        if (!memcmp(a.p[IFA_ADDRESS], ip, width)) {
          uint32_t flags = h.ifa_flags;
          if (h.ifa_prefixlen != (width == 4 ? 31 : 127) || (a.p[IFA_FLAGS] && oci_uplink_u32(&a, IFA_FLAGS, &flags) < 0) ||
              (flags & (IFA_F_TENTATIVE | IFA_F_DADFAILED | IFA_F_DEPRECATED | IFA_F_OPTIMISTIC))) goto done;
          if (width == 4) found4++; else found6++;
        } else if (!(width == 16 && a.p[IFA_ADDRESS][0] == 0xfe && (a.p[IFA_ADDRESS][1] & 0xc0) == 0x80)) goto done;
      }
      at += NLMSG_ALIGN((size_t)n.nlmsg_len);
    }
    if (found4 != 1 || found6 != 1) goto done;
  }
  if (oci_uplink_dump_side(u, 1, RTM_GETROUTE, d) < 0) goto done;
  unsigned int defaults = 0; size_t at = 0;
  while (at < d->used) {
    struct nlmsghdr n; memcpy(&n, d->bytes + at, sizeof(n)); struct rtmsg h;
    const unsigned char *body = d->bytes + at + NLMSG_HDRLEN; memcpy(&h, body, sizeof(h)); struct oci_uplink_attrs a;
    if (oci_uplink_attrs(body + NLMSG_ALIGN(sizeof(h)), n.nlmsg_len - NLMSG_LENGTH(sizeof(h)), &a) < 0) goto done;
    uint32_t table = h.rtm_table;
    if (a.p[RTA_TABLE] && oci_uplink_u32(&a, RTA_TABLE, &table) < 0) goto done;
    if (table == RT_TABLE_MAIN && !h.rtm_dst_len) {
      uint32_t index; size_t width = h.rtm_family == AF_INET ? 4u : h.rtm_family == AF_INET6 ? 16u : 0;
      const void *ip = width == 4 ? (const void *)u->expected.host4 : (const void *)u->expected.host6;
      unsigned int bit = width == 4 ? 1u : 2u;
      if (!width || (defaults & bit) || h.rtm_type != RTN_UNICAST || h.rtm_protocol != RTPROT_STATIC ||
          h.rtm_scope != RT_SCOPE_UNIVERSE || h.rtm_flags || h.rtm_src_len || h.rtm_tos ||
          oci_uplink_u32(&a, RTA_OIF, &index) < 0 || index != u->guest_index || !a.p[RTA_GATEWAY] ||
          a.size[RTA_GATEWAY] != width || memcmp(a.p[RTA_GATEWAY], ip, width)) goto done;
      defaults |= bit;
    }
    at += NLMSG_ALIGN((size_t)n.nlmsg_len);
  }
  if (defaults != 3 || oci_uplink_preflight(u) < 0 || oci_uplink_pair(u) < 0) goto done;
  result = oci_uplink_original(u);
done:
  free(d); if (result < 0 && !errno) errno = ESTALE; return result;
}
static int oci_uplink_install(struct tns_oci_owner *o, struct oci_uplink_owner *u) {
  if (!u) return 0;
  if (tns_oci_once(&u->phase) < 0) { errno = EALREADY; return -1; }
  if (oci_uplink_guest_channel(o, u) < 0 || oci_uplink_host_channel(u) < 0 || oci_uplink_lock(u) < 0 || oci_uplink_new_pair(u) < 0) goto fail;
  for (unsigned int side = 0; side < 2; ++side) {
    if (oci_uplink_address(u, (int)side, AF_INET) < 0 || oci_uplink_address(u, (int)side, AF_INET6) < 0) goto fail;
    struct ifinfomsg h = {.ifi_family = AF_UNSPEC, .ifi_index = (int)(side ? u->guest_index : u->host_index), .ifi_flags = IFF_UP, .ifi_change = IFF_UP};
    struct oci_uplink_request r; oci_uplink_request(&r, RTM_NEWLINK, 0, &h, sizeof(h));
    if (oci_uplink_mutate(u, (int)side, &r) < 0) goto fail;
  }
  if (oci_uplink_route(u, AF_INET) < 0 || oci_uplink_route(u, AF_INET6) < 0) goto fail;
  u->configured = 1;
  if (oci_uplink_config_readback(u) < 0 || oci_uplink_unlock(u) < 0) goto fail;
  return 0;
fail:
  if (!errno) errno = EPROTO;
  return -1;
}
/* Cancel-independent currentness is confined to actual original cleanup sites.
 * No init may be alive: either CREATE never spawned, or original consuming
 * init wait + STOP custody has completed. Lost transport is not repaired here. */
static int oci_uplink_cleanup_current(struct oci_uplink_owner *u) {
  struct tns_oci_owner *o = u ? u->original : NULL; struct tns_identity identity;
  if (!o || u->controller != getpid() || o->controller_pid != getpid() || geteuid() != 0 || u->broken || u->close_unknown ||
      (o->command_pid && (!o->init_joined || !o->init_custody || !o->init_stop_attempt || !o->command_joined || !o->command_ok ||
        (o->start_pid && !o->start_joined))) || oci_inputs(o) < 0 || oci_uplink_file_current(u) < 0 ||
      tns_owner_observe(o->birth, &identity) < 0 || !tns_identity_equal(&identity, &u->identity) ||
      oci_uplink_host_current(u) < 0 || (u->lock >= 0 && oci_uplink_lock_current(u) < 0)) { if (!errno) errno = ESTALE; return -1; }
  return 0;
}
static int oci_uplink_absent(struct oci_uplink_owner *u) {
  struct oci_uplink_dump *d = malloc(sizeof(*d)); if (!d) return -1;
  int result = -1;
  for (unsigned int side = 0; side < 2; ++side) {
    if (oci_uplink_dump_side(u, (int)side, RTM_GETLINK, d) < 0) goto done;
    size_t at = 0;
    while (at < d->used) {
      struct nlmsghdr n; memcpy(&n, d->bytes + at, sizeof(n)); struct ifinfomsg h;
      const unsigned char *body = d->bytes + at + NLMSG_HDRLEN; memcpy(&h, body, sizeof(h));
      struct oci_uplink_attrs a;
      if (oci_uplink_attrs(body + NLMSG_ALIGN(sizeof(h)), n.nlmsg_len - NLMSG_LENGTH(sizeof(h)), &a) < 0 ||
          (uint32_t)h.ifi_index == (side ? u->guest_index : u->host_index) ||
          oci_uplink_text(&a, IFLA_IFNAME, side ? u->guest_name : u->host_name) == 0) goto done;
      at += NLMSG_ALIGN((size_t)n.nlmsg_len);
    }
  }
  result = oci_uplink_original(u);
done:
  free(d); return result;
}
static int oci_uplink_cleanup(struct oci_uplink_owner **slot) {
  if (!slot || !*slot) return 0;
  struct oci_uplink_owner *u = *slot; int saved = 0;
  if (u->controller != getpid()) { errno = EPERM; return -1; }
  if (u->child && !u->child_joined) {
    if (!u->kill_attempt) {
      u->kill_attempt = 1;
      if (syscall(SYS_pidfd_send_signal, u->child_pidfd, SIGKILL, NULL, 0) < 0 && errno != ESRCH) saved = errno;
    }
    if (oci_uplink_join(u, 1000) < 0 && !saved) saved = errno ? errno : EPROTO;
  }
  /* Close each actually received malformed descriptor once, even if another
   * close was uncertain. No guessed descriptor from a CTRUNC tail is touched. */
  for (unsigned int i = 0; i < u->received_count; ++i)
    if (oci_uplink_close_fd(u, &u->received_rights[i]) < 0 && !saved) saved = errno;
  if (oci_uplink_close_fd(u, &u->channel) < 0 && !saved) saved = errno;
  if (saved || (u->child && !u->child_joined)) { if (saved) errno = saved; return -1; }
  if (u->create_sent && !u->delete_known) {
    if (!u->create_known || !u->pair_known || u->delete_sent || u->broken || u->close_unknown) { errno = EUCLEAN; return -1; }
    u->cleaning = 1;
    if (oci_uplink_cleanup_current(u) < 0 || oci_uplink_lock(u) < 0 || oci_uplink_pair(u) < 0) return -1;
    struct ifinfomsg h = {.ifi_family = AF_UNSPEC, .ifi_index = (int)u->host_index}; struct oci_uplink_request r;
    oci_uplink_request(&r, RTM_DELLINK, 0, &h, sizeof(h));
    u->delete_sent = 1;
    if (oci_uplink_mutate(u, 0, &r) < 0) return -1;
    if (oci_uplink_absent(u) < 0) { u->broken = 1; return -1; }
    u->delete_known = 1;
    /* Actual ACK only establishes the requested synchronous veth deletion;
     * it does not certify packet/offload/namespace lifetime or terminal. */
  }
  if (oci_uplink_unlock(u) < 0) return -1;
  int *fds[] = {&u->guest, &u->host, &u->netfd, &u->child_pidfd, &u->file, &u->lock, &u->lock_root};
  for (size_t i = 0; i < sizeof(fds)/sizeof(fds[0]); ++i)
    if (oci_uplink_close_fd(u, fds[i]) < 0 && !saved) saved = errno;
  if (saved || u->close_unknown) { errno = saved ? saved : EUCLEAN; return -1; }
  explicit_bzero(u, sizeof(*u)); free(u); *slot = NULL; return 0;
}
#endif
