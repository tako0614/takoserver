#ifndef DOCKER_CONTAINER_TERMINAL_OCI_EGRESS_H
#define DOCKER_CONTAINER_TERMINAL_OCI_EGRESS_H

/* Private implementation included after original OCI custody helpers. The
 * optional policy is closed input data. This unit installs ONLY a real DROP
 * guard; it never compiles permissive policy, creates an uplink, or opens the
 * kernel birth gate. No caller FD/path/namespace/script/callback is accepted. */
#define OCI_EGRESS_TABLE "tako_terminal_policy"
#define OCI_EGRESS_FILE ".tako-oci-egress.json"
#define OCI_EGRESS_JSON_MAX 32768u
#define OCI_EGRESS_READ_MAX 65536u
static const char oci_egress_script[] =
  "create table inet " OCI_EGRESS_TABLE "\n"
  "add chain inet " OCI_EGRESS_TABLE " input { type filter hook input priority -310; policy drop; }\n"
  "add chain inet " OCI_EGRESS_TABLE " output { type filter hook output priority -310; policy drop; }\n"
  "add chain inet " OCI_EGRESS_TABLE " forward { type filter hook forward priority -310; policy drop; }\n";

struct oci_egress_cursor { const unsigned char *p; size_t size, at; };
static void oci_egress_space(struct oci_egress_cursor *c) {
  while (c->at < c->size && (c->p[c->at] == ' ' || c->p[c->at] == '\t' ||
         c->p[c->at] == '\r' || c->p[c->at] == '\n')) ++c->at;
}
static int oci_egress_take(struct oci_egress_cursor *c, const char *s) {
  size_t n = strlen(s);
  if (n > c->size - c->at || memcmp(c->p + c->at, s, n)) return -1;
  c->at += n; return 0;
}
static int oci_egress_token(struct oci_egress_cursor *c, const char *s) {
  oci_egress_space(c); return oci_egress_take(c, s);
}
static int oci_egress_number(struct oci_egress_cursor *c, uint64_t *out) {
  size_t start = c->at; uint64_t n = 0;
  while (c->at < c->size && c->p[c->at] >= '0' && c->p[c->at] <= '9') {
    unsigned int digit = c->p[c->at++] - '0';
    if (n > (UINT64_MAX - digit) / 10) return -1;
    n = n * 10 + digit;
  }
  if (c->at == start || (c->at - start > 1 && c->p[start] == '0')) return -1;
  *out = n; return 0;
}
/* Canonical JSON.stringify string subset: original valid UTF8/no NUL,
 * controls escaped canonically. No alternate Unicode/solidus escape aliases. */
static int oci_egress_string(struct oci_egress_cursor *c, char *out, size_t size) {
  if (oci_egress_take(c, "\"") < 0) return -1;
  size_t used = 0;
  while (c->at < c->size) {
    unsigned int ch = c->p[c->at++];
    if (ch == '"') {
      if (used >= size) return -1;
      out[used] = 0; return tns_oci_utf8((struct tns_oci_text){(unsigned char *)out, used});
    }
    if (ch < 32) return -1;
    if (ch == '\\') {
      if (c->at == c->size) return -1;
      ch = c->p[c->at++];
      if (ch == 'b') ch = 8; else if (ch == 'f') ch = 12;
      else if (ch == 'n') ch = 10; else if (ch == 'r') ch = 13;
      else if (ch == 't') ch = 9;
      else if (ch == 'u') {
        if (c->size - c->at < 4 || c->p[c->at] != '0' || c->p[c->at + 1] != '0') return -1;
        ch = 0;
        for (size_t i = 2; i < 4; ++i) {
          unsigned int h = c->p[c->at + i];
          if (h >= '0' && h <= '9') h -= '0';
          else if (h >= 'a' && h <= 'f') h = h - 'a' + 10;
          else return -1;
          ch = ch * 16 + h;
        }
        c->at += 4;
        if (!ch || ch >= 32 || ch == 8 || ch == 9 || ch == 10 || ch == 12 || ch == 13) return -1;
      } else if (ch != '"' && ch != '\\') return -1;
    }
    if (used + 1 >= size) return -1;
    out[used++] = (char)ch;
  }
  return -1;
}

static int oci_egress_policy(const char *bytes, size_t size, const char *artifact,
                              size_t artifact_size, uint64_t generation) {
  if (!bytes || !artifact || !size || size > OCI_EGRESS_JSON_MAX || !artifact_size) return -1;
  struct oci_egress_cursor c = {(const unsigned char *)bytes, size, 0};
  if (oci_egress_take(&c, "{\"kind\":\"linux-oci-owned-egress@1\",\"artifact\":") < 0 ||
      artifact_size > c.size - c.at || memcmp(c.p + c.at, artifact, artifact_size)) return -1;
  c.at += artifact_size;
  char text[1025]; uint64_t n;
  if (oci_egress_take(&c, ",\"policy\":{\"tenantRef\":") < 0 ||
      oci_egress_string(&c, text, sizeof(text)) < 0 || !*text ||
      oci_egress_take(&c, ",\"generation\":") < 0 || oci_egress_number(&c, &n) < 0 ||
      n != generation || !n || n > UINT64_C(9007199254740991) ||
      oci_egress_take(&c, ",\"policyDigest\":") < 0 ||
      oci_egress_string(&c, text, sizeof(text)) < 0 || tns_oci_digest(text) < 0 ||
      oci_egress_take(&c, ",\"outboundInternet\":") < 0) return -1;
  if (oci_egress_take(&c, "true") < 0 && oci_egress_take(&c, "false") < 0) return -1;
  if (oci_egress_take(&c, "},\"limits\":{\"maxConnections\":") < 0 ||
      oci_egress_number(&c, &n) < 0 || n > 65535 ||
      oci_egress_take(&c, ",\"packetLimitBytes\":") < 0 ||
      oci_egress_number(&c, &n) < 0 || n > UINT64_C(9007199254740991) ||
      oci_egress_take(&c, "}}") < 0 || c.at != c.size) return -1;
  return 0;
}

/* Only exact table/base-chain objects, plus bounded normal nft metainfo and
 * inert handles, are accepted. Any rule/set/unknown field or duplicate refuses. */
static int oci_egress_object(struct oci_egress_cursor *c, int kind, unsigned int *chain) {
  if (oci_egress_token(c, "{") < 0) return -1;
  unsigned int seen = 0; char key[64], value[257];
  for (;;) {
    oci_egress_space(c);
    if (oci_egress_string(c, key, sizeof(key)) < 0 || oci_egress_token(c, ":") < 0) return -1;
    const char *const keys[] = {"family", "name", "table", "type", "hook", "prio", "policy", "handle", "flags", "version", "release_name", "json_schema_version"};
    size_t k = 0; while (k < 12 && strcmp(key, keys[k])) ++k;
    if (k == 12 || (seen & (1u << k))) return -1;
    seen |= 1u << k; oci_egress_space(c);
    if (k == 7 || k == 11) {
      uint64_t n; if (oci_egress_number(c, &n) < 0 || (k == 7 ? !n : n != 1)) return -1;
    } else if (k == 5) {
      if (oci_egress_take(c, "-310") < 0) return -1;
    } else if (k == 8) {
      if (oci_egress_token(c, "[") < 0 || oci_egress_token(c, "]") < 0) return -1;
    } else {
      if (oci_egress_string(c, value, sizeof(value)) < 0) return -1;
      if (k == 0 && strcmp(value, "inet")) return -1;
      if ((k == 2 || (kind == 1 && k == 1)) && strcmp(value, OCI_EGRESS_TABLE)) return -1;
      if (k == 3 && strcmp(value, "filter")) return -1;
      if (k == 6 && strcmp(value, "drop")) return -1;
      if (kind == 2 && (k == 1 || k == 4)) {
        unsigned int n = !strcmp(value, "input") ? 1u : !strcmp(value, "output") ? 2u : !strcmp(value, "forward") ? 4u : 0u;
        if (!n || (*chain && *chain != n)) return -1;
        *chain = n;
      }
      if ((k == 9 || k == 10) && !*value) return -1;
    }
    oci_egress_space(c);
    if (oci_egress_take(c, "}") == 0) break;
    if (oci_egress_take(c, ",") < 0) return -1;
  }
  unsigned int required = kind == 0 ? (1u << 9) | (1u << 10) | (1u << 11) :
    kind == 1 ? 3u : 127u;
  unsigned int allowed = kind == 0 ? required : kind == 1 ? required | (1u << 7) | (1u << 8) : required | (1u << 7);
  return (seen & required) == required && !(seen & ~allowed) ? 0 : -1;
}
static int oci_egress_readback(const char *bytes, size_t size) {
  if (!bytes || !size || size > OCI_EGRESS_READ_MAX) return -1;
  struct oci_egress_cursor c = {(const unsigned char *)bytes, size, 0};
  if (oci_egress_token(&c, "{") < 0 || oci_egress_token(&c, "\"nftables\"") < 0 ||
      oci_egress_token(&c, ":") < 0 || oci_egress_token(&c, "[") < 0) return -1;
  unsigned int objects = 0, chains = 0;
  for (;;) {
    char key[32]; if (oci_egress_token(&c, "{") < 0) return -1;
    oci_egress_space(&c);
    if (oci_egress_string(&c, key, sizeof(key)) < 0 || oci_egress_token(&c, ":") < 0) return -1;
    int kind = !strcmp(key, "metainfo") ? 0 : !strcmp(key, "table") ? 1 : !strcmp(key, "chain") ? 2 : -1;
    unsigned int chain = 0;
    if (kind < 0 || (kind < 2 && (objects & (1u << (unsigned int)kind))) ||
        oci_egress_object(&c, kind, &chain) < 0 || oci_egress_token(&c, "}") < 0) return -1;
    objects |= 1u << (unsigned int)kind;
    if (kind == 2) { if (chains & chain) return -1; chains |= chain; }
    if (oci_egress_token(&c, "]") == 0) break;
    if (oci_egress_token(&c, ",") < 0) return -1;
  }
  if (oci_egress_token(&c, "}") < 0) return -1;
  oci_egress_space(&c); return c.at == c.size && (objects & 6u) == 6u && chains == 7u ? 0 : -1;
}

static int oci_egress_same_stat(const struct stat *a, const struct stat *b) {
  return oci_same(a, b) && a->st_size == b->st_size &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static int oci_egress_current(struct tns_oci_owner *o) {
  if (!o->egress_selected) return 0;
  struct stat held, named;
  if (o->controller_pid != getpid() || geteuid() != 0 ||
      fstat(o->egress_file, &held) < 0 || fstatat(o->root, OCI_EGRESS_FILE, &named, AT_SYMLINK_NOFOLLOW) < 0 ||
      !S_ISREG(held.st_mode) || held.st_uid || (held.st_mode & 07777) != 0600 || held.st_nlink != 1 ||
      !oci_egress_same_stat(&held, &o->egress_file_identity) || !oci_same(&held, &named) ||
      fstat(o->egress_binary, &held) < 0 || !S_ISREG(held.st_mode) || held.st_uid ||
      (held.st_mode & 06022) || !(held.st_mode & 0100) ||
      !oci_egress_same_stat(&held, &o->egress_binary_identity)) { errno = ESTALE; return -1; }
  char bytes[4096]; size_t used = 0;
  while (used < o->egress_size) {
    size_t n = o->egress_size - used; if (n > sizeof(bytes)) n = sizeof(bytes);
    ssize_t count = pread(o->egress_file, bytes, n, (off_t)used);
    if (count != (ssize_t)n || memcmp(bytes, o->egress_bytes + used, n)) { errno = ESTALE; return -1; }
    used += n;
  }
  if (pread(o->egress_file, bytes, 1, (off_t)used) != 0 || fstat(o->egress_file, &held) < 0 ||
      !oci_egress_same_stat(&held, &o->egress_file_identity)) { errno = ESTALE; return -1; }
  return 0;
}
static int oci_egress_select(struct tns_oci_owner *o, uint64_t generation) {
  o->egress_file_attempt = 1;
  o->egress_file = openat(o->root, OCI_EGRESS_FILE, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (o->egress_file < 0) return errno == ENOENT ? 0 : -1;
  struct stat st; struct sigaction action;
  if (fstat(o->egress_file, &st) < 0 || !S_ISREG(st.st_mode) || st.st_uid ||
      (st.st_mode & 07777) != 0600 || st.st_nlink != 1 || st.st_size < 1 ||
      st.st_size > OCI_EGRESS_JSON_MAX) { errno = EPROTO; return -1; }
  o->egress_size = (size_t)st.st_size; o->egress_file_identity = st;
  if (pread(o->egress_file, o->egress_bytes, o->egress_size, 0) != (ssize_t)o->egress_size ||
      oci_egress_policy(o->egress_bytes, o->egress_size, o->receipt_bytes, o->receipt_size, generation) < 0 ||
      sigaction(SIGPIPE, NULL, &action) < 0 || action.sa_handler != SIG_IGN) { errno = EPROTO; return -1; }
  o->egress_binary_attempt = 1;
  o->egress_binary = oci_open_absolute("/usr/sbin/nft", 0);
  unsigned char magic[4];
  if (o->egress_binary < 0 || fstat(o->egress_binary, &o->egress_binary_identity) < 0 ||
      pread(o->egress_binary, magic, sizeof(magic), 0) != (ssize_t)sizeof(magic) ||
      memcmp(magic, "\177ELF", sizeof(magic))) return -1;
  o->egress_selected = 1;
  return oci_egress_current(o);
}

static int oci_egress_join(struct tns_oci_owner *o, size_t stage, int timeout) {
  if (!o->egress_pid[stage] || o->egress_joined[stage]) return 0;
  struct pollfd p = {.fd = o->egress_pidfd[stage], .events = POLLIN};
  int n = poll(&p, 1, timeout);
  if (n < 0) return -1;
  if (!n) { errno = ETIMEDOUT; return -1; }
  siginfo_t info; memset(&info, 0, sizeof(info));
  if (p.revents != POLLIN) { errno = EPROTO; return -1; }
  if (waitid(P_PIDFD, (id_t)o->egress_pidfd[stage], &info, WEXITED | WNOHANG) < 0) return -1;
  if (info.si_pid != o->egress_pid[stage] ||
      (info.si_code != CLD_EXITED && info.si_code != CLD_KILLED && info.si_code != CLD_DUMPED)) { errno = EPROTO; return -1; }
  o->egress_joined[stage] = 1; o->egress_ok[stage] = info.si_code == CLD_EXITED && info.si_status == 0;
  return 0;
}
static int oci_egress_close_fd(struct tns_oci_owner *o, int *slot) {
  if (*slot < 0) return 0;
  int fd = *slot; *slot = -1;
  if (close(fd) < 0) { o->egress_close_unknown = 1; return -1; }
  return 0;
}
static int oci_egress_stop(struct tns_oci_owner *o) {
  if (!o->egress_guard_attempt) return 0;
  if (o->controller_pid != getpid()) { errno = EPERM; return -1; }
  int saved = 0;
  for (size_t i = 0; i < 3; ++i) {
    if (o->egress_pid[i] && !o->egress_joined[i] && !o->egress_kill[i]) {
      o->egress_kill[i] = 1;
      if (syscall(SYS_pidfd_send_signal, o->egress_pidfd[i], SIGKILL, NULL, 0) < 0 && errno != ESRCH)
        { if (!saved) saved = errno; }
    }
    if (oci_egress_join(o, i, 1000) < 0 && !saved) saved = errno ? errno : EPROTO;
    if (oci_egress_close_fd(o, &o->egress_in[i]) < 0 && !saved) saved = errno;
    if (oci_egress_close_fd(o, &o->egress_out[i]) < 0 && !saved) saved = errno;
  }
  if (saved) { errno = saved; return -1; }
  return 0;
}
static int oci_egress_close(struct tns_oci_owner *o) {
  /* release_uncreated has joined every actual private command first. */
  if ((o->egress_file_attempt || o->egress_binary_attempt || o->egress_guard_attempt) &&
      o->controller_pid != getpid()) { errno = EPERM; return -1; }
  for (size_t i = 0; i < 3; ++i)
    if (o->egress_pid[i] && !o->egress_joined[i]) { errno = EBUSY; return -1; }
  for (size_t i = 0; i < 3; ++i)
    if (o->egress_pid[i] && oci_egress_close_fd(o, &o->egress_pidfd[i]) < 0) return -1;
  if (o->egress_file_attempt && oci_egress_close_fd(o, &o->egress_file) < 0) return -1;
  if (o->egress_binary_attempt && oci_egress_close_fd(o, &o->egress_binary) < 0) return -1;
  return 0;
}
static int oci_egress_original(struct tns_oci_owner *o) {
  struct tns_identity actual; struct stat st; struct statfs fs;
  if (oci_not_canceled() < 0 || o->egress_close_unknown || o->controller_pid != getpid() || geteuid() != 0 ||
      oci_inputs(o) < 0 || tns_owner_observe(o->birth, &actual) < 0 ||
      !tns_identity_equal(&actual, &o->identity) ||
      fstat(o->network, &st) < 0 || fstatfs(o->network, &fs) < 0 ||
      (unsigned long)fs.f_type != (unsigned long)NSFS_MAGIC ||
      ioctl(o->network, NS_GET_NSTYPE) != CLONE_NEWNET ||
      (uint64_t)st.st_dev != actual.device || (uint64_t)st.st_ino != actual.inode ||
      oci_not_canceled() < 0) { if (!errno) errno = ESTALE; return -1; }
  return 0;
}
static _Noreturn void oci_egress_child(struct tns_oci_owner *o, size_t stage, int input, int output) {
  int executable = fcntl(o->egress_binary, F_DUPFD_CLOEXEC, 10);
  int network = fcntl(o->network, F_DUPFD_CLOEXEC, 10);
  int incoming = fcntl(input, F_DUPFD_CLOEXEC, 10), outgoing = fcntl(output, F_DUPFD_CLOEXEC, 10);
  if (executable < 0 || network < 0 || incoming < 0 || outgoing < 0 ||
      dup3(executable, 3, O_CLOEXEC) < 0 || dup3(network, 4, O_CLOEXEC) < 0 ||
      dup2(incoming, 0) != 0 || dup2(outgoing, 1) != 1 ||
      syscall(SYS_close_range, 2u, 2u, 0u) < 0 ||
      syscall(SYS_close_range, 5u, UINT_MAX, 0u) < 0 ||
      prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != o->controller_pid) _exit(125);
  struct stat st; struct statfs fs;
  if (fstat(4, &st) < 0 || fstatfs(4, &fs) < 0 ||
      (unsigned long)fs.f_type != (unsigned long)NSFS_MAGIC || ioctl(4, NS_GET_NSTYPE) != CLONE_NEWNET ||
      (uint64_t)st.st_dev != o->identity.device || (uint64_t)st.st_ino != o->identity.inode ||
      setns(4, CLONE_NEWNET) < 0 || close(4) < 0) _exit(125);
  int null = open("/dev/null", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (null != 2 || fstat(null, &st) < 0 || !S_ISCHR(st.st_mode) || major(st.st_rdev) != 1 || minor(st.st_rdev) != 3) _exit(125);
  for (int fd = 0; fd < 3; ++fd) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) < 0 || fcntl(fd, F_SETFD, 0) < 0) _exit(125);
  }
  char *const check[] = {"nft", "--check", "-f", "-", NULL};
  char *const apply[] = {"nft", "-f", "-", NULL};
  char *const readback[] = {"nft", "-j", "list", "table", "inet", OCI_EGRESS_TABLE, NULL};
  char *const environment[] = {"PATH=/usr/sbin:/usr/bin:/sbin:/bin", NULL};
  char *const *argv = stage == 0 ? check : stage == 1 ? apply : stage == 2 ? readback : NULL;
  if (!argv) _exit(125);
  umask(077); syscall(SYS_execveat, 3, "", argv, environment, AT_EMPTY_PATH); _exit(125);
}
static int oci_egress_left(int64_t deadline) {
  int64_t now = oci_now();
  if (now < 0) return -1;
  if (now >= deadline) { errno = ETIMEDOUT; return -1; }
  return (int)(deadline - now);
}
static int oci_egress_command(struct tns_oci_owner *o, size_t stage, int64_t deadline,
                               char *output, size_t *used) {
  if (stage >= 3 || o->egress_pid[stage] || (stage && !o->egress_ok[stage - 1]) ||
      oci_egress_original(o) < 0 || oci_egress_left(deadline) < 0) return -1;
  int in[2], out[2];
  if (pipe2(in, O_CLOEXEC | O_NONBLOCK) < 0) return -1;
  if (pipe2(out, O_CLOEXEC | O_NONBLOCK) < 0) {
    (void)oci_egress_close_fd(o, &in[0]); (void)oci_egress_close_fd(o, &in[1]); return -1;
  }
  o->egress_in[stage] = in[1]; o->egress_out[stage] = out[0];
  struct clone_args args; memset(&args, 0, sizeof(args));
  args.flags = CLONE_PIDFD | CLONE_CLEAR_SIGHAND; args.exit_signal = SIGCHLD;
  args.pidfd = (uint64_t)(uintptr_t)&o->egress_pidfd[stage];
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (!child) oci_egress_child(o, stage, in[0], out[1]);
  (void)oci_egress_close_fd(o, &in[0]); (void)oci_egress_close_fd(o, &out[1]);
  if (child < 0) return -1;
  o->egress_pid[stage] = (pid_t)child;
  if (oci_not_canceled() < 0 || o->egress_close_unknown) return -1;
  size_t at = 0, size = stage == 2 ? 0 : sizeof(oci_egress_script) - 1;
  while (at < size) {
    int left = oci_egress_left(deadline); if (left < 0 || oci_not_canceled() < 0) return -1;
    struct pollfd fd = {.fd = in[1], .events = POLLOUT};
    if (poll(&fd, 1, left) != 1 || fd.revents != POLLOUT) { errno = EPIPE; return -1; }
    ssize_t n = write(in[1], oci_egress_script + at, size - at);
    if (n <= 0) return -1;
    at += (size_t)n;
  }
  if (oci_egress_close_fd(o, &o->egress_in[stage]) < 0) return -1;
  *used = 0;
  for (;;) {
    int left = oci_egress_left(deadline); if (left < 0 || oci_not_canceled() < 0) return -1;
    struct pollfd fd = {.fd = out[0], .events = POLLIN};
    if (poll(&fd, 1, left) != 1 || (fd.revents != POLLIN && fd.revents != POLLHUP && fd.revents != (POLLIN | POLLHUP))) { errno = EPROTO; return -1; }
    ssize_t n = read(out[0], output + *used, OCI_EGRESS_READ_MAX - *used);
    if (n < 0) return -1;
    if (!n) break;
    *used += (size_t)n;
    if (*used == OCI_EGRESS_READ_MAX) { errno = EOVERFLOW; return -1; }
  }
  if (oci_egress_close_fd(o, &o->egress_out[stage]) < 0) return -1;
  int left = oci_egress_left(deadline);
  if (left < 0 || oci_egress_join(o, stage, left) < 0 || !o->egress_ok[stage] ||
      oci_egress_original(o) < 0) { if (!errno) errno = EPROTO; return -1; }
  return 0;
}
static int oci_egress_guard_install(struct tns_oci_owner *o) {
  if (!o->egress_selected) return 0; /* Original profile remains kernel-denied. */
  if (tns_oci_once(&o->egress_guard_attempt) < 0) { errno = EALREADY; return -1; }
  int64_t now = oci_now(); if (now < 0) return -1;
  int64_t deadline = now + 10000;
  char *output = malloc(OCI_EGRESS_READ_MAX); if (!output) return -1;
  size_t used = 0; int result = -1;
  for (size_t stage = 0; stage < 3; ++stage) {
    if (oci_egress_command(o, stage, deadline, output, &used) < 0) goto done;
    if (stage < 2 && used) { errno = EPROTO; goto done; }
  }
  if (oci_egress_readback(output, used) < 0 || oci_egress_original(o) < 0) { errno = EPROTO; goto done; }
  o->egress_guard_verified = 1; /* Fixed DROP readback only, no admission fact. */
  result = 0;
done:
  free(output); return result;
}
#endif
