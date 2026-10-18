#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "docker-container-inspect-projection.h"

#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif

/* Host-internal bounded protocol. No daemon inventory, shell, tenant program,
 * namespace creation or network selection. Native commands require --native;
 * the default capture-only mode never calls setns or exec. Native qualification
 * and owner/installation admission belong to the caller, not this metadata. */
enum { MAX_FRAME = 1048576, MAX_SCRIPT = 65536, IO_MS = 3000 };
static int peer = -1, peer_pidfd = -1, netns = -1;
static pid_t wanted_pid;
static uid_t wanted_uid;
static struct stat namespace_stat;
static char socket_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
static char network_id[65], table_name[64], boot_epoch[80];
static char selected_native_id[65];
static const char *ip_binary, *nft_binary;
static bool native_mode, guest_mode, quarantine_control;
static bool start_attempted, disconnect_attempted, connect_attempted;
static di_capture control_identity;
static bool control_captured;
static int guest_netns = -1, guest_pidfd = -1, daemon_root = -1;
static struct stat guest_namespace_stat;
static di_capture guest_identity;
static const char *guest_namespace_root;
static bool guest_watch_current(void);
static bool host_inventory_current(void);
static bool selected_current(void);

static int64_t clock_ms(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1;
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static bool wait_io(int fd, short events, int64_t until) {
  for (;;) {
    int64_t left = until - clock_ms();
    if (left <= 0) return false;
    struct pollfd p = {.fd = fd, .events = events};
    int n = poll(&p, 1, (int)left);
    if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    return n == 1 && (p.revents & events) != 0;
  }
}
static bool transfer(int fd, void *buffer, size_t length, bool writing) {
  size_t done = 0;
  int64_t until = clock_ms() + IO_MS;
  while (done < length) {
    if (!wait_io(fd, writing ? POLLOUT : POLLIN, until)) return false;
    ssize_t n = writing ? write(fd, (char *)buffer + done, length - done)
                        : read(fd, (char *)buffer + done, length - done);
    if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (n <= 0) return false;
    done += (size_t)n;
  }
  return true;
}
static bool reply(unsigned char status, const void *body, size_t length) {
  if (length > MAX_FRAME - 1) return false;
  uint32_t size = htonl((uint32_t)length + 1);
  return transfer(STDOUT_FILENO, &size, sizeof(size), true) &&
         transfer(STDOUT_FILENO, &status, 1, true) &&
         (!length || transfer(STDOUT_FILENO, (void *)body, length, true));
}
static bool refusal(const char *code) { return reply(1, code, strlen(code)); }
static bool decimal(const char *s, unsigned long *value) {
  if (!*s) return false;
  for (const char *p = s; *p; p++) if (*p < '0' || *p > '9') return false;
  errno = 0; char *end; unsigned long n = strtoul(s, &end, 10);
  if (errno || *end || n > 0x7fffffffUL) return false;
  *value = n; return true;
}
static bool token(const char *s, size_t max, bool hex) {
  size_t n = strlen(s);
  if (!n || n > max) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (hex ? !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))
            : !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
  }
  return true;
}
static bool boot(char out[80]) {
  int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  ssize_t n = read(fd, out, 79); close(fd);
  if (n < 1 || n >= 79) return false;
  out[n] = 0; return true;
}
static bool current(void) {
  struct pollfd p = {.fd = peer_pidfd, .events = POLLIN};
  if (poll(&p, 1, 0) != 0) return false;
  struct ucred credentials; socklen_t size = sizeof(credentials);
  if (getsockopt(peer, SOL_SOCKET, SO_PEERCRED, &credentials, &size) ||
      size != sizeof(credentials) || credentials.pid != wanted_pid ||
      credentials.uid != wanted_uid) return false;
  char path[80], epoch[80]; struct stat s, held;
  snprintf(path, sizeof(path), "/proc/%ld/ns/net", (long)wanted_pid);
  if (stat(path, &s) || fstat(netns, &held) || !boot(epoch)) return false;
  return s.st_dev == namespace_stat.st_dev && s.st_ino == namespace_stat.st_ino &&
         held.st_dev == s.st_dev && held.st_ino == s.st_ino &&
         !strcmp(epoch, boot_epoch) && poll(&p, 1, 0) == 0;
}
static int connect_peer(void) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (fd < 0) return -1;
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address))) {
    if (errno != EINPROGRESS || !wait_io(fd, POLLOUT, clock_ms() + IO_MS)) {
      close(fd); return -1;
    }
    int error; socklen_t length = sizeof(error);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) || error) {
      close(fd); return -1;
    }
  }
  struct ucred credentials; socklen_t length = sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) ||
      length != sizeof(credentials) || credentials.pid != wanted_pid ||
      credentials.uid != wanted_uid) { close(fd); return -1; }
  return fd;
}
static bool capture(void) {
  peer = connect_peer();
  if (peer < 0) return false;
  /* SO_PEERPIDFD pins the original socket peer. pidfd_open(numeric PID) alone
   * could adopt a replacement after peer exit/PID reuse. No such fallback. */
  socklen_t length = sizeof(peer_pidfd);
  if (getsockopt(peer, SOL_SOCKET, SO_PEERPIDFD, &peer_pidfd, &length) ||
      length != sizeof(peer_pidfd) || peer_pidfd < 0) return false;
  if (fcntl(peer_pidfd, F_SETFD, FD_CLOEXEC) < 0) return false;
  char path[80]; struct statfs fs;
  snprintf(path, sizeof(path), "/proc/%ld/ns/net", (long)wanted_pid);
  netns = open(path, O_RDONLY | O_CLOEXEC);
  if (netns < 0 || fstatfs(netns, &fs) || fs.f_type != NSFS_MAGIC ||
      fstat(netns, &namespace_stat) || !boot(boot_epoch)) return false;
  return current();
}
static bool network_read(void) {
  if (!current()) return false;
  int fd = connect_peer(); if (fd < 0) return false;
  char request[256];
  int n = snprintf(request, sizeof(request),
    "GET /v1.51/networks/%s HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n", network_id);
  bool ok = n > 0 && (size_t)n < sizeof(request) && transfer(fd, request, (size_t)n, true);
  unsigned char *body = malloc(MAX_FRAME); size_t used = 0;
  int64_t until = clock_ms() + IO_MS;
  if (!body) ok = false;
  while (ok) {
    struct pollfd p = {.fd = fd, .events = POLLIN};
    int64_t left = until - clock_ms();
    if (left <= 0 || poll(&p, 1, (int)left) != 1) { ok = false; break; }
    ssize_t got = read(fd, body + used, MAX_FRAME - used);
    if (got < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (got < 0) { ok = false; break; }
    if (!got) break;
    used += (size_t)got;
    if (used >= MAX_FRAME - 1) { ok = false; break; }
  }
  close(fd); ok = ok && current();
  if (ok) ok = reply(0, body, used);
  free(body); return ok;
}
/* HTTP/1.0 disables chunked framing for this new bounded read. The original
 * NETWORK protocol remains byte-compatible. Raw inspect data is never replied. */
static bool json_snapshot(const char *path, unsigned char **body, size_t *body_length) {
  if (!current()) return false;
  int fd = connect_peer();
  if (fd < 0) return false;
  char request[256];
  int length = snprintf(request, sizeof(request),
    "GET %s HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n", path);
  bool ok = length > 0 && (size_t)length < sizeof(request) && transfer(fd, request, (size_t)length, true);
  unsigned char *wire = malloc(MAX_FRAME); size_t used = 0;
  int64_t now = clock_ms(), until = now + IO_MS;
  if (!wire || now < 0) ok = false;
  while (ok) {
    int64_t observed = clock_ms();
    if (observed < 0) { ok = false; break; }
    int64_t left = until - observed;
    struct pollfd p = {.fd = fd, .events = POLLIN};
    if (left <= 0 || poll(&p, 1, (int)left) != 1) { ok = false; break; }
    ssize_t got = read(fd, wire + used, MAX_FRAME - 1 - used);
    if (got < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (got < 0) { ok = false; break; }
    if (!got) break;
    used += (size_t)got;
    if (used >= MAX_FRAME - 1) { ok = false; break; }
  }
  close(fd);
  if (ok) {
    wire[used] = 0;
    unsigned char *boundary = memmem(wire, used, "\r\n\r\n", 4);
    size_t header = boundary ? (size_t)(boundary - wire) : 0;
    ok = boundary && header <= 16384 && header >= 12 &&
      (!memcmp(wire, "HTTP/1.0 200 ", 13) || !memcmp(wire, "HTTP/1.1 200 ", 13));
    size_t content_length = 0; bool has_length = false;
    if (ok) {
      unsigned char *line = memmem(wire, header, "\r\n", 2);
      if (!line) ok = false;
      else line += 2;
      while (ok && line < boundary) {
        unsigned char *end = memmem(line, (size_t)(boundary - line), "\r\n", 2);
        if (!end) end = boundary;
        unsigned char *colon = memchr(line, ':', (size_t)(end - line));
        if (!colon || colon == line || *line == ' ' || *line == '\t') { ok = false; break; }
        size_t key = (size_t)(colon - line);
        if ((key == 17 && !strncasecmp((char *)line, "Transfer-Encoding", key)) ||
          (key == 16 && !strncasecmp((char *)line, "Content-Encoding", key))) { ok = false; break; }
        if (key == 14 && !strncasecmp((char *)line, "Content-Length", key)) {
          if (has_length) { ok = false; break; }
          has_length = true; unsigned char *value = colon + 1;
          while (value < end && (*value == ' ' || *value == '\t')) value++;
          if (value == end) { ok = false; break; }
          for (; value < end; value++) {
            if (*value < '0' || *value > '9' || content_length > MAX_FRAME / 10) { ok = false; break; }
            content_length = content_length * 10 + *value - '0';
          }
        }
        line = end + 2;
      }
    }
    size_t body_offset = header + 4;
    if (ok && (body_offset > used || (has_length && content_length != used - body_offset))) ok = false;
    if (ok) {
      *body_length = used - body_offset;
      memmove(wire, wire + body_offset, *body_length);
      *body = wire; wire = NULL;
    }
  }
  if (wire) { explicit_bzero(wire, used); free(wire); }
  ok = ok && current();
  return ok;
}
static bool container_snapshot(char projected[DI_OUTPUT], di_capture *binding) {
  if (!*selected_native_id) return false;
  char path[256]; snprintf(path, sizeof(path), "/v1.51/containers/%s/json", selected_native_id);
  unsigned char *body = NULL; size_t size = 0;
  bool ok = json_snapshot(path, &body, &size) && di_project(body, size, selected_native_id, projected, DI_OUTPUT, binding);
  if (body) { explicit_bzero(body, size); free(body); }
  return ok && current();
}
#include "docker-container-bridge-scope.h"
#include "docker-container-host-inventory.h"
/* The Engine-owned sandbox namespace is checked independently of its numeric
 * init PID. A stale/reused PID cannot select a foreign namespace. Root paths
 * are Host code inputs; traversal is confined to the held original daemon root. */
static bool sandbox_path(const di_capture *binding) {
  size_t n = strlen(guest_namespace_root);
  return strlen(binding->sandbox_id) == 64 && token(binding->sandbox_id, 64, true) &&
    !strncmp(binding->sandbox_key, guest_namespace_root, n) && binding->sandbox_key[n] == '/' &&
    strlen(binding->sandbox_key + n + 1) == 12 &&
    !strncmp(binding->sandbox_key + n + 1, binding->sandbox_id, 12);
}
static int sandbox_open(const di_capture *binding) {
  if (!sandbox_path(binding) || daemon_root < 0) return -1;
  struct open_how how = {.flags = O_RDONLY | O_CLOEXEC,
    .resolve = RESOLVE_IN_ROOT | RESOLVE_NO_MAGICLINKS};
  return (int)syscall(SYS_openat2, daemon_root, binding->sandbox_key, &how, sizeof(how));
}
static bool guest_same(const di_capture *a, const di_capture *b) {
  return a->healthy && b->healthy && a->safe_host_config && b->safe_host_config && a->pid == b->pid &&
    !strcmp(a->sandbox_id, b->sandbox_id) && !strcmp(a->sandbox_key, b->sandbox_key) &&
    !strcmp(a->image_id, b->image_id) && !strcmp(a->identity, b->identity) &&
    !strcmp(a->revision, b->revision) && !strcmp(a->claim, b->claim);
}
/* The actual selected task cannot regain capabilities in the held network
 * namespace through exec: bounding/permitted/effective/inheritable/ambient are
 * all empty and NoNewPrivs is set. Config labels alone do not establish this. */
static bool guest_task_safety(void) {
  char path[80], bytes[65537]; size_t used = 0;
  snprintf(path, sizeof(path), "/proc/%lu/status", (unsigned long)guest_identity.pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  bool ok = true;
  while (used < sizeof(bytes) - 1) {
    ssize_t n = read(fd, bytes + used, sizeof(bytes) - 1 - used);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) { ok = false; break; }
    if (!n) break;
    used += (size_t)n;
  }
  close(fd);
  if (used >= sizeof(bytes) - 1) ok = false;
  bytes[used] = 0;
  const char *names[] = {"CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:", "NoNewPrivs:"};
  bool seen[6] = {false};
  for (char *line = bytes; ok && *line;) {
    char *end = strchr(line, '\n'); if (!end) { ok = false; break; }
    *end = 0;
    for (unsigned i = 0; i < 6; i++) {
      size_t size = strlen(names[i]);
      if (strncmp(line, names[i], size)) continue;
      if (seen[i]) { ok = false; break; }
      seen[i] = true; char *value = line + size;
      while (*value == ' ' || *value == '\t') value++;
      if (i == 5) ok = !strcmp(value, "1");
      else {
        size_t n = strlen(value); if (n < 1 || n > 16) ok = false;
        for (size_t j = 0; j < n; j++) if (value[j] != '0') ok = false;
      }
    }
    line = end + 1;
  }
  for (unsigned i = 0; i < 6; i++) if (!seen[i]) ok = false;
  explicit_bzero(bytes, used);
  return ok;
}
static bool guest_fd_current(void) {
  if (!current() || guest_pidfd < 0 || guest_netns < 0) return false;
  struct pollfd task = {.fd = guest_pidfd, .events = POLLIN};
  if (poll(&task, 1, 0) != 0) return false;
  struct stat held, task_ns, sandbox; struct statfs fs;
  char path[80];
  snprintf(path, sizeof(path), "/proc/%lu/ns/net", (unsigned long)guest_identity.pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  bool ok = !fstatfs(fd, &fs) && fs.f_type == NSFS_MAGIC && !fstat(fd, &task_ns);
  close(fd);
  int selected = sandbox_open(&guest_identity);
  if (selected < 0) return false;
  ok = ok && !fstatfs(selected, &fs) && fs.f_type == NSFS_MAGIC && !fstat(selected, &sandbox);
  close(selected);
  return ok && guest_watch_current() && guest_task_safety() && !fstat(guest_netns, &held) &&
    held.st_dev == guest_namespace_stat.st_dev && held.st_ino == guest_namespace_stat.st_ino &&
    task_ns.st_dev == held.st_dev && task_ns.st_ino == held.st_ino &&
    sandbox.st_dev == held.st_dev && sandbox.st_ino == held.st_ino && poll(&task, 1, 0) == 0;
}
static bool selected_current(void) {
  if (!guest_mode) return current();
  if (!guest_fd_current()) return false;
  char projected[DI_OUTPUT]; di_capture actual;
  return container_snapshot(projected, &actual) && guest_same(&actual, &guest_identity) && guest_fd_current() && host_inventory_current();
}
static bool capture_guest(const struct stat *parent) {
  char projected[DI_OUTPUT], path[80]; di_capture initial, final; struct statfs fs;
  if (!container_snapshot(projected, &initial) || !initial.healthy || !initial.safe_host_config || initial.pid < 1 ||
    strcmp(initial.network_mode, "none") || !sandbox_path(&initial)) return false;
  snprintf(path, sizeof(path), "/proc/%ld/root", (long)wanted_pid);
  daemon_root = open(path, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (daemon_root < 0 || !current()) return false;
  int selected = sandbox_open(&initial);
  if (selected < 0) return false;
  bool ok = !fstatfs(selected, &fs) && fs.f_type == NSFS_MAGIC && !fstat(selected, &guest_namespace_stat);
  close(selected);
  if (!ok || (guest_namespace_stat.st_dev == parent->st_dev && guest_namespace_stat.st_ino == parent->st_ino) ||
    (guest_namespace_stat.st_dev == namespace_stat.st_dev && guest_namespace_stat.st_ino == namespace_stat.st_ino)) return false;
  guest_pidfd = (int)syscall(SYS_pidfd_open, initial.pid, 0);
  if (guest_pidfd < 0 || fcntl(guest_pidfd, F_SETFD, FD_CLOEXEC) < 0) return false;
  snprintf(path, sizeof(path), "/proc/%lu/ns/net", (unsigned long)initial.pid);
  guest_netns = open(path, O_RDONLY | O_CLOEXEC);
  if (guest_netns < 0 || fstatfs(guest_netns, &fs) || fs.f_type != NSFS_MAGIC) return false;
  guest_identity = initial;
  return guest_fd_current() && container_snapshot(projected, &final) && guest_same(&initial, &final) && guest_fd_current();
}
#include "docker-container-guest-lifetime.h"
/* Control mode never executes a Host or guest binary. Each mutation has one
 * fixed selected-ID path/body and consumes its local attempt before any write.
 * Original owner START claim is held by the caller; these are not grants. */
static bool control_same(const di_capture *value) {
  return value->safe_host_config &&
    !strcmp(value->image_id, control_identity.image_id) &&
    !strcmp(value->identity, control_identity.identity) &&
    !strcmp(value->revision, control_identity.revision) &&
    !strcmp(value->claim, control_identity.claim) && !strcmp(value->network_mode, "none");
}
static bool control_post(const char *path, const char *body) {
  if (!current()) return false;
  int fd = connect_peer(); if (fd < 0) return false;
  char request[1024]; size_t body_length = strlen(body);
  int n = snprintf(request, sizeof(request),
    "POST %s HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s", path, body_length, body);
  bool ok = n > 0 && (size_t)n < sizeof(request) && transfer(fd, request, (size_t)n, true);
  char wire[16385]; size_t used = 0; int64_t until = clock_ms() + IO_MS;
  while (ok) {
    if (!wait_io(fd, POLLIN, until)) { ok = false; break; }
    ssize_t got = read(fd, wire + used, sizeof(wire) - 1 - used);
    if (got < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (got < 0) { ok = false; break; }
    if (!got) break;
    used += (size_t)got;
    if (used >= sizeof(wire) - 1) { ok = false; break; }
  }
  close(fd); wire[used] = 0;
  char *end = ok ? memmem(wire, used, "\r\n\r\n", 4) : NULL;
  ok = ok && end && (size_t)(end - wire) + 4 == used && used >= 16 &&
    (!memcmp(wire, "HTTP/1.0 204 ", 13) || !memcmp(wire, "HTTP/1.1 204 ", 13));
  /* No body, transfer coding, duplicate/invalid content length or trailers. */
  if (ok) {
    char *line = strstr(wire, "\r\n"); if (!line) ok = false; else line += 2;
    bool length_seen = false;
    while (ok && line < end) {
      char *next = strstr(line, "\r\n"), *colon = memchr(line, ':', (size_t)((next ? next : end) - line));
      if (!next || next > end || !colon || colon == line || *line == ' ' || *line == '\t') { ok = false; break; }
      size_t key = (size_t)(colon - line);
      if ((key == 17 && !strncasecmp(line, "Transfer-Encoding", key)) ||
        (key == 16 && !strncasecmp(line, "Content-Encoding", key))) { ok = false; break; }
      if (key == 14 && !strncasecmp(line, "Content-Length", key)) {
        char *value = colon + 1; while (value < next && (*value == ' ' || *value == '\t')) value++;
        if (length_seen || next - value != 1 || *value != '0') { ok = false; break; }
        length_seen = true;
      }
      line = next + 2;
    }
  }
  explicit_bzero(wire, used);
  return ok && current();
}
static bool quarantine_mutation(const char *operation) {
  if (!quarantine_control || !control_captured || !current()) return refusal("quarantine_control_refused");
  char projection[DI_OUTPUT], path[256], body[256]; di_capture before, after;
  if (!container_snapshot(projection, &before) || !control_same(&before)) return refusal("quarantine_identity_refused");
  bool *attempt;
  if (!strcmp(operation, "QUARANTINESTART")) {
    attempt = &start_attempted;
    if (before.healthy || before.pid || before.network_count != 1 || strcmp(before.network_name, "none"))
      return refusal("quarantine_state_refused");
    snprintf(path, sizeof(path), "/v1.51/containers/%s/start", selected_native_id); body[0] = 0;
  } else if (!strcmp(operation, "DISCONNECTNONE")) {
    attempt = &disconnect_attempted;
    if (!before.healthy || before.network_count != 1 || strcmp(before.network_name, "none"))
      return refusal("quarantine_state_refused");
    snprintf(path, sizeof(path), "/v1.51/networks/none/disconnect");
    snprintf(body, sizeof(body), "{\"Container\":\"%s\",\"Force\":false}", selected_native_id);
  } else if (!strcmp(operation, "CONNECTOWNED")) {
    attempt = &connect_attempted;
    if (!disconnect_attempted || !before.healthy || before.network_count != 0)
      return refusal("quarantine_state_refused");
    snprintf(path, sizeof(path), "/v1.51/networks/%s/connect", network_id);
    snprintf(body, sizeof(body), "{\"Container\":\"%s\",\"EndpointConfig\":{}}", selected_native_id);
  } else return refusal("protocol_invalid");
  if (*attempt) return refusal("quarantine_attempt_consumed");
  *attempt = true;
  if (!control_post(path, body) || !container_snapshot(projection, &after) || !control_same(&after) ||
    !after.healthy || (before.pid && (after.pid != before.pid || strcmp(after.sandbox_id, before.sandbox_id) ||
      strcmp(after.sandbox_key, before.sandbox_key)))) return refusal("quarantine_outcome_unknown");
  bool expected = !strcmp(operation, "QUARANTINESTART") ?
    after.network_count == 1 && !strcmp(after.network_name, "none") :
    !strcmp(operation, "DISCONNECTNONE") ? after.network_count == 0 :
    after.network_count == 1 && !strcmp(after.network_id, network_id) && strlen(after.endpoint_id) == 64;
  return expected && current() ? reply(0, "{}", 2) : refusal("quarantine_outcome_unknown");
}
static bool container_read(void) {
  char projected[DI_OUTPUT];
  bool ok = selected_current() && container_snapshot(projected, NULL) && selected_current();
  return ok ? reply(0, projected, strlen(projected)) : refusal("native_inspection_unavailable");
}
static bool capture_native(char *const argv[], const char *input, size_t input_length,
  unsigned char **output, size_t *output_length) {
  if (!(bridge_mode ? db_current() : selected_current())) return false;
  const char *binary = argv[0];
  int in[2], out[2]; if (pipe2(in, O_CLOEXEC)) return false;
  if (pipe2(out, O_CLOEXEC)) { close(in[0]); close(in[1]); return false; }
  pid_t controller = getpid();
  pid_t child = fork();
  if (child == 0) {
    close(in[1]); close(out[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != controller) _exit(125);
    if (setns(guest_mode ? guest_netns : netns, CLONE_NEWNET) || dup2(in[0], STDIN_FILENO) < 0 ||
        dup2(out[1], STDOUT_FILENO) < 0) _exit(125);
    int null = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (null < 0 || dup2(null, STDERR_FILENO) < 0) _exit(125);
    clearenv(); execv(binary, argv); _exit(125);
  }
  close(in[0]); close(out[1]);
  if (child < 0) { close(in[1]); close(out[0]); return false; }
  if (fcntl(in[1], F_SETFL, O_NONBLOCK) < 0) {
    close(in[1]); close(out[0]); kill(child, SIGKILL);
    while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    return false;
  }
  bool ok = !input_length || transfer(in[1], (void *)input, input_length, true);
  close(in[1]); unsigned char *data = malloc(MAX_FRAME); size_t used = 0;
  if (!data) ok = false;
  int64_t until = clock_ms() + IO_MS; int status = 0; bool reaped = false;
  while (ok) {
    int64_t left = until - clock_ms();
    if (left <= 0) { ok = false; break; }
    struct pollfd p = {.fd = out[0], .events = POLLIN};
    if (poll(&p, 1, (int)left) != 1) { ok = false; break; }
    ssize_t n = read(out[0], data + used, MAX_FRAME - used);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) { ok = false; break; }
    if (!n) break;
    used += (size_t)n;
    if (used >= MAX_FRAME - 1) { ok = false; break; }
  }
  close(out[0]);
  while (ok) {
    pid_t got = waitpid(child, &status, WNOHANG);
    if (got == child) { reaped = true; break; }
    if (got < 0 || clock_ms() >= until) { ok = false; break; }
    struct timespec pause = {.tv_nsec = 1000000}; nanosleep(&pause, NULL);
  }
  if (!reaped) { kill(child, SIGKILL); while (waitpid(child, &status, 0) < 0 && errno == EINTR) {} }
  ok = ok && WIFEXITED(status) && WEXITSTATUS(status) == 0 && (bridge_mode ? db_current() : selected_current());
  if (ok) { *output = data; *output_length = used; return true; }
  free(data); return false;
}
#include "docker-container-guest-resume.h"
static bool command(char *operation, char *argument, const char *input, size_t input_length) {
  if (!native_mode || quarantine_control || !(bridge_mode ? db_current() : selected_current())) return refusal("native_command_refused");
  if (guest_mode && guest_fail_closed && !strcmp(operation, "NFTAPPLY") && !guest_watch_arm()) return refusal("guest_lifetime_unavailable");
  const char *binary; char *argv[12]; int i = 0;
  if (!strcmp(operation, "LINK") || !strcmp(operation, "ADDR")) {
    if (!token(argument, 15, false)) return refusal("protocol_invalid");
    binary = ip_binary; argv[i++] = (char *)binary; argv[i++] = "-j";
    if (!strcmp(operation, "LINK")) argv[i++] = "-d";
    argv[i++] = !strcmp(operation, "LINK") ? "link" : "address";
    argv[i++] = "show"; argv[i++] = "dev"; argv[i++] = argument;
  } else {
    binary = nft_binary; argv[i++] = (char *)binary;
    if (!strcmp(operation, "NFTCHECK") || !strcmp(operation, "NFTAPPLY")) {
      if (input_length == 0 || input_length > MAX_SCRIPT || *argument) return refusal("protocol_invalid");
      if (!strcmp(operation, "NFTCHECK")) argv[i++] = "--check";
      argv[i++] = "-f"; argv[i++] = "-";
    } else if (!strcmp(operation, "NFTREAD")) {
      if (strcmp(argument, "inet") && strcmp(argument, "bridge")) return refusal("protocol_invalid");
      argv[i++] = "-j"; if (guest_fail_closed) argv[i++] = "-a"; argv[i++] = "list"; argv[i++] = "table"; argv[i++] = argument;
      static char bridge_table[80];
      snprintf(bridge_table, sizeof(bridge_table), "%s_bridge", table_name);
      argv[i++] = !strcmp(argument, "inet") ? table_name : bridge_table;
    } else return refusal("protocol_invalid");
  }
  argv[i] = NULL;
  unsigned char *data = NULL; size_t used = 0;
  bool ok = capture_native(argv, input, input_length, &data, &used);
  bool sent = ok ? reply(0, data, used) : refusal("native_unavailable");
  free(data); return sent;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) < 0 ||
      fcntl(STDOUT_FILENO, F_SETFL, O_NONBLOCK) < 0) return 2;
  if (argc < 6 || argc > 14) return 2;
  unsigned long pid, uid;
  if (argv[1][0] != '/' || strlen(argv[1]) >= sizeof(socket_path) ||
      !decimal(argv[2], &pid) || pid == 0 || !decimal(argv[3], &uid) ||
      strlen(argv[4]) != 64 || !token(argv[4], 64, true) ||
      strncmp(argv[5], "takos_cx_", 9) || !token(argv[5], 49, false)) return 2;
  strcpy(socket_path, argv[1]); strcpy(network_id, argv[4]); strcpy(table_name, argv[5]);
  wanted_pid = (pid_t)pid; wanted_uid = (uid_t)uid;
  int option = 6;
  if (option < argc && !strcmp(argv[option], "--native")) {
    if (argc - option < 3 || argv[option + 1][0] != '/' || argv[option + 2][0] != '/') return 2;
    native_mode = true; ip_binary = argv[option + 1]; nft_binary = argv[option + 2]; option += 3;
  }
  if (option < argc && !strcmp(argv[option], "--container")) {
    if (argc - option < 2 || strcmp(argv[option], "--container") ||
      strlen(argv[option + 1]) != 64 || !token(argv[option + 1], 64, true)) return 2;
    strcpy(selected_native_id, argv[option + 1]); option += 2;
  }
  if (option < argc && !strcmp(argv[option], "--host-bridge")) {
    if (!native_mode || *selected_native_id || argc - option != 1) return 2;
    bridge_mode = true; option++;
  }
  if (option < argc && !strcmp(argv[option], "--quarantine-control")) {
    if (!native_mode || !*selected_native_id || argc - option != 1) return 2;
    quarantine_control = true; option++;
  }
  if (option < argc) {
    if (argc - option < 2 || strcmp(argv[option], "--guest-netns-root") || !native_mode ||
      !*selected_native_id || argv[option + 1][0] != '/' || strlen(argv[option + 1]) > 384) return 2;
    guest_namespace_root = argv[option + 1];
    size_t n = strlen(guest_namespace_root);
    if (n < 2 || guest_namespace_root[n - 1] == '/' || strstr(guest_namespace_root, "..") ||
      strstr(guest_namespace_root, "//")) return 2;
    for (size_t i = 0; i < n; i++) {
      unsigned char c = (unsigned char)guest_namespace_root[i];
      if (c < 33 || c > 126 || c == '\\') return 2;
    }
    guest_mode = true; option += 2;
  }
  if (option < argc && !strcmp(argv[option], "--guest-failclosed")) {
    if (!guest_mode || argc - option != 1) return 2;
    guest_fail_closed = true; option++;
  }
  if (option != argc) return 2;
  int result = 1;
  if (!capture()) { refusal("peer_capture_refused"); goto finish; }
  struct stat parent; char hello[512];
  if (stat("/proc/self/ns/net", &parent)) goto finish;
  if (native_mode && !guest_mode && !quarantine_control && !bridge_mode && parent.st_dev == namespace_stat.st_dev && parent.st_ino == namespace_stat.st_ino) {
    refusal("parent_namespace_refused"); goto finish;
  }
  if (guest_mode && !capture_guest(&parent)) {
    refusal("guest_namespace_refused"); goto finish;
  }
  if (quarantine_control) {
    char projection[DI_OUTPUT];
    if (!container_snapshot(projection, &control_identity) || !control_identity.safe_host_config ||
      strcmp(control_identity.network_mode, "none")) {
      refusal("quarantine_identity_refused"); goto finish;
    }
    control_captured = true;
  }
  if (!guest_watch_start()) { refusal("guest_lifetime_unavailable"); goto finish; }
  if (bridge_mode && !db_capture()) { refusal("bridge_scope_refused"); goto finish; }
  const struct stat *active = guest_mode ? &guest_namespace_stat : &namespace_stat;
  char selected[256] = "";
  if (*selected_native_id) snprintf(selected, sizeof(selected),
    ",\"nativeId\":\"%s\"%s", selected_native_id, guest_mode ? ",\"namespaceKind\":\"container\"" : quarantine_control ? ",\"namespaceKind\":\"control\"" : "");
  if (bridge_mode) strcpy(selected, ",\"namespaceKind\":\"bridge\"");
  int n = snprintf(hello, sizeof(hello),
    "{\"kind\":\"docker-physical-session@1\",\"peerPid\":%ld,\"peerUid\":%ld,"
    "\"namespaceDevice\":\"%llu\",\"namespaceInode\":\"%llu\","
    "\"parentDevice\":\"%llu\",\"parentInode\":\"%llu\",\"captureOnly\":%s%s}",
    (long)wanted_pid, (long)wanted_uid, (unsigned long long)active->st_dev,
    (unsigned long long)active->st_ino, (unsigned long long)parent.st_dev,
    (unsigned long long)parent.st_ino, native_mode ? "false" : "true", selected);
  if (n < 0 || (size_t)n >= sizeof(hello) || !reply(0, hello, (size_t)n)) goto finish;
  for (;;) {
    /* The owner controls session lifetime; idle time is not a replacement lease
     * TTL. Individual requests and native commands remain deadline-bounded. */
    struct pollfd pending = {.fd = STDIN_FILENO, .events = POLLIN};
    int available;
    do { available = poll(&pending, 1, -1); } while (available < 0 && errno == EINTR);
    if (available != 1 || !(pending.revents & POLLIN)) { result = 0; break; }
    uint32_t size; if (!transfer(STDIN_FILENO, &size, sizeof(size), false)) { result = 0; break; }
    size = ntohl(size);
    if (size == 0 || size > MAX_SCRIPT + 128) { refusal("protocol_invalid"); break; }
    char *request = calloc((size_t)size + 1, 1);
    if (!request || !transfer(STDIN_FILENO, request, size, false)) { free(request); break; }
    if (memchr(request, 0, size)) { refusal("protocol_invalid"); free(request); break; }
    char *input = strchr(request, '\n'); size_t length = 0;
    if (input) { *input++ = 0; length = size - (size_t)(input - request); }
    char *argument = strchr(request, ' ');
    if (argument) *argument++ = 0; else argument = request + strlen(request);
    bool ok;
    if (!strcmp(request, "CLOSE") && !*argument && !length) {
      ok = reply(0, "{}", 2); free(request); result = ok ? 0 : 1; break;
    } else if (!strcmp(request, "CURRENT") && !*argument && !length)
      ok = (bridge_mode ? db_current() : selected_current()) ? reply(0, "{}", 2) : refusal("native_unavailable");
    else if (!strcmp(request, "NETWORK") && !*argument && !length)
      ok = network_read();
    else if (!strcmp(request, "INSPECT") && !*argument && !length)
      ok = container_read();
    else if ((!strcmp(request, "QUARANTINESTART") || !strcmp(request, "DISCONNECTNONE") ||
      !strcmp(request, "CONNECTOWNED")) && !*argument && !length)
      ok = quarantine_mutation(request);
    else if (!strcmp(request, "RESUMEGUEST") && !*argument && !length)
      ok = guest_resume();
    else if (!strcmp(request, "HOSTINVENTORY") && !*argument && !length)
      ok = host_inventory_reply();
    else if (!strcmp(request, "KEEPGUEST") && !*argument && !length)
      ok = guest_mode && selected_current() && guest_watch_keep() ? reply(0, "{}", 2) : refusal("guest_authority_expired");
    else if (!strcmp(request, "ARMGUEST") && !*argument && !length)
      ok = guest_mode && selected_current() && guest_watch_arm() ? reply(0, "{}", 2) : refusal("guest_lifetime_unavailable");
    else if (bridge_mode) {
      if (*argument || length) ok = refusal("protocol_invalid");
      else if (!strcmp(request, "BRIDGEBINDING")) ok = db_projection();
      else if (!strcmp(request, "BRIDGECHECK")) ok = command("NFTCHECK", "", bridge_script, bridge_script_size);
      else if (!strcmp(request, "BRIDGEINSTALL")) {
        if (bridge_install_attempted) ok = refusal("bridge_attempt_consumed");
        else { bridge_install_attempted = true; ok = command("NFTAPPLY", "", bridge_script, bridge_script_size); }
      } else if (!strcmp(request, "BRIDGEREAD")) ok = command("NFTREAD", "bridge", NULL, 0);
      else ok = refusal("native_command_refused");
    } else ok = command(request, argument, input, length);
    free(request); if (!ok) break;
  }
finish:
  if (!guest_watch_join()) result = 1;
  if (guest_netns >= 0) close(guest_netns);
  if (guest_pidfd >= 0) close(guest_pidfd);
  if (daemon_root >= 0) close(daemon_root);
  if (netns >= 0) close(netns);
  if (peer_pidfd >= 0) close(peer_pidfd);
  if (peer >= 0) close(peer);
  return result;
}
