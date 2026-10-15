#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

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
static const char *ip_binary, *nft_binary;
static bool native_mode;

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
static bool command(char *operation, char *argument, const char *input, size_t input_length) {
  if (!native_mode || !current()) return refusal("native_command_refused");
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
      argv[i++] = "-j"; argv[i++] = "list"; argv[i++] = "table"; argv[i++] = argument;
      static char bridge_table[80];
      snprintf(bridge_table, sizeof(bridge_table), "%s_bridge", table_name);
      argv[i++] = !strcmp(argument, "inet") ? table_name : bridge_table;
    } else return refusal("protocol_invalid");
  }
  argv[i] = NULL;
  int in[2], out[2]; if (pipe2(in, O_CLOEXEC)) return refusal("native_unavailable");
  if (pipe2(out, O_CLOEXEC)) { close(in[0]); close(in[1]); return refusal("native_unavailable"); }
  pid_t controller = getpid();
  pid_t child = fork();
  if (child == 0) {
    close(in[1]); close(out[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != controller) _exit(125);
    if (setns(netns, CLONE_NEWNET) || dup2(in[0], STDIN_FILENO) < 0 ||
        dup2(out[1], STDOUT_FILENO) < 0) _exit(125);
    int null = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (null < 0 || dup2(null, STDERR_FILENO) < 0) _exit(125);
    clearenv(); execv(binary, argv); _exit(125);
  }
  close(in[0]); close(out[1]);
  if (child < 0) { close(in[1]); close(out[0]); return refusal("native_unavailable"); }
  if (fcntl(in[1], F_SETFL, O_NONBLOCK) < 0) {
    close(in[1]); close(out[0]); kill(child, SIGKILL);
    while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    return refusal("native_unavailable");
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
  ok = ok && WIFEXITED(status) && WEXITSTATUS(status) == 0 && current();
  bool sent = ok ? reply(0, data, used) : refusal("native_unavailable");
  free(data); return sent;
}
int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) < 0 ||
      fcntl(STDOUT_FILENO, F_SETFL, O_NONBLOCK) < 0) return 2;
  if (argc != 6 && argc != 9) return 2;
  unsigned long pid, uid;
  if (argv[1][0] != '/' || strlen(argv[1]) >= sizeof(socket_path) ||
      !decimal(argv[2], &pid) || pid == 0 || !decimal(argv[3], &uid) ||
      strlen(argv[4]) != 64 || !token(argv[4], 64, true) ||
      strncmp(argv[5], "takos_cx_", 9) || !token(argv[5], 49, false)) return 2;
  strcpy(socket_path, argv[1]); strcpy(network_id, argv[4]); strcpy(table_name, argv[5]);
  wanted_pid = (pid_t)pid; wanted_uid = (uid_t)uid;
  if (argc == 9) {
    if (strcmp(argv[6], "--native") || argv[7][0] != '/' || argv[8][0] != '/') return 2;
    native_mode = true; ip_binary = argv[7]; nft_binary = argv[8];
  }
  int result = 1;
  if (!capture()) { refusal("peer_capture_refused"); goto finish; }
  struct stat parent; char hello[512];
  if (stat("/proc/self/ns/net", &parent)) goto finish;
  if (native_mode && parent.st_dev == namespace_stat.st_dev && parent.st_ino == namespace_stat.st_ino) {
    refusal("parent_namespace_refused"); goto finish;
  }
  int n = snprintf(hello, sizeof(hello),
    "{\"kind\":\"docker-physical-session@1\",\"peerPid\":%ld,\"peerUid\":%ld,"
    "\"namespaceDevice\":\"%llu\",\"namespaceInode\":\"%llu\","
    "\"parentDevice\":\"%llu\",\"parentInode\":\"%llu\",\"captureOnly\":%s}",
    (long)wanted_pid, (long)wanted_uid, (unsigned long long)namespace_stat.st_dev,
    (unsigned long long)namespace_stat.st_ino, (unsigned long long)parent.st_dev,
    (unsigned long long)parent.st_ino, native_mode ? "false" : "true");
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
      ok = current() ? reply(0, "{}", 2) : refusal("native_unavailable");
    else if (!strcmp(request, "NETWORK") && !*argument && !length)
      ok = network_read();
    else ok = command(request, argument, input, length);
    free(request); if (!ok) break;
  }
finish:
  if (netns >= 0) close(netns);
  if (peer_pidfd >= 0) close(peer_pidfd);
  if (peer >= 0) close(peer);
  return result;
}
