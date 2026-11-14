#ifndef TAKO_OCI_PERSISTENT_PARENT_H
#define TAKO_OCI_PERSISTENT_PARENT_H

#include <linux/sched.h>
#include <limits.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/un.h>
#include <sys/vfs.h>
#include <linux/magic.h>

#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77 /* exact v6.12 asm-generic/socket.h */
#endif

/* Opt-in, dedicated same-binary parent, not an adopted/reconstructed session.
 * This record never leaves this original process. Authenticated frontends read
 * and manage THIS record; even fact() zero is only this H's exact
 * consuming exit-zero plus independently read stdout/stderr EOF, not retirement.
 * All output is retained, including bytes whose delivery to Host is unknown.
 * Bounded capture exhaustion retains the original pipe/child as UNKNOWN.
 */
#define OCIPP_OUTPUT_MAX (4u * TNS_OCI_MAX_JSON)
#define OCIPP_ERROR_MAX 65536u
struct ocipp_owner {
  pid_t controller, child;
  int executable, pidfd, input[2], output[2], errors[2];
  struct stat executable_identity;
  unsigned int attempted, joined, wait_unknown, close_unknown, identity_unknown;
  unsigned int eof[2], pipe_unknown[2], host_lost, reply_unknown;
  int code, status;
  char claim[65]; uint64_t generation;
  unsigned char *create, *incoming, *captured[2];
  size_t create_size, incoming_size, incoming_need, incoming_sent;
  size_t used[2], delivered[2], frame_start, frame_end;
  unsigned int pending, awaiting, reply_ready;
  int listener, candidate, frontend;
  uint64_t listener_cookie;
  unsigned char capability[32], authentication[124];
  size_t authentication_used;
  int64_t authentication_started;
  unsigned int binding_attempt, bound, create_attempt, management_unknown;
  unsigned int effects, delivery_unknown, replay_required, management_resume, input_paused;
  /* Explicit v2 only: original self pidfs record, never a numeric PID lookup. */
  int self_pidfd; unsigned int self_attempt;
  uint64_t self_device, self_inode; char boot_id[37];
  enum tns_ocip_kind request_kind;
  size_t request_size, issued_size, last_reply_start, last_reply_end;
  unsigned char *frontend_input, *management_output;
  size_t frontend_used, frontend_need, management_size, management_sent;
};
static volatile sig_atomic_t ocipp_interrupted;
static void ocipp_interrupt(int number) { (void)number; ocipp_interrupted = 1; }
static int ocipp_same_executable(const struct stat *a, const struct stat *b) {
  return S_ISREG(a->st_mode) && !a->st_uid && !(a->st_mode & 06022) &&
    (a->st_mode & S_IXUSR) && a->st_nlink && a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
    a->st_mode == b->st_mode && a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
    a->st_nlink == b->st_nlink && a->st_size == b->st_size &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static int ocipp_controller(struct ocipp_owner *o) {
  if (!o || o->controller != getpid() || geteuid()) { errno = EPERM; return -1; }
  return 0;
}
static int ocipp_current(struct ocipp_owner *o) {
  struct stat st;
  if (ocipp_controller(o) < 0) return -1;
  if (o->executable < 0 || fstat(o->executable, &st) < 0 ||
      !ocipp_same_executable(&st, &o->executable_identity)) { errno = ESTALE; return -1; }
  return 0;
}
static int ocipp_close(struct ocipp_owner *o, int *slot) {
  if (*slot < 0) return 0;
  int fd = *slot; *slot = -1;
  if (close(fd) < 0) { o->close_unknown = 1; return -1; }
  return 0;
}
/* Decode a separate copy: the original bytes sent to H are never rewritten. */
static int ocipp_decode(const unsigned char *body, size_t size, char *claim,
                          uint64_t *generation, int first, enum tns_ocip_kind *kind) {
  unsigned char *copy = calloc(1, size + 1);
  struct tns_ocip_request *request = calloc(1, sizeof(*request));
  if (!copy || !request) { free(copy); free(request); return -1; }
  memcpy(copy, body, size);
  int result = tns_ocip_decode(copy, size, request);
  if (!result && (first ? request->kind != TNS_OCIP_CREATE : request->kind == TNS_OCIP_CREATE)) {
    errno = EPROTO; result = -1;
  }
  if (!result && first) {
    memcpy(claim, request->options.claim_id, 65); *generation = request->options.generation;
  }
  if (!result && kind) *kind = request->kind;
  explicit_bzero(copy, size + 1); free(copy);
  explicit_bzero(request, sizeof(*request)); free(request); return result;
}
static int ocipp_initialize(struct ocipp_owner *o) {
  if (!o) { errno = EINVAL; return -1; }
  if (o->controller || o->attempted) { errno = EALREADY; return -1; }
  memset(o, 0, sizeof(*o)); o->controller = getpid(); o->executable = o->pidfd = -1;
  o->listener = o->candidate = o->frontend = -1;
  for (unsigned int i = 0; i < 2; ++i) o->input[i] = o->output[i] = o->errors[i] = -1;
  if (geteuid()) return -1;
  o->executable = open("/proc/self/exe", O_PATH | O_CLOEXEC);
  if (o->executable < 0 || fstat(o->executable, &o->executable_identity) < 0 || ocipp_current(o) < 0) return -1;
  o->incoming = calloc(1, (size_t)TNS_OCI_MAX_JSON + 4);
  o->frontend_input = calloc(1, (size_t)TNS_OCI_MAX_JSON + 4);
  o->management_output = calloc(1, (size_t)TNS_OCI_MAX_JSON + 1024);
  o->captured[0] = calloc(1, OCIPP_OUTPUT_MAX); o->captured[1] = calloc(1, OCIPP_ERROR_MAX);
  if (!o->incoming || !o->frontend_input || !o->management_output || !o->captured[0] || !o->captured[1]) return -1;
  o->incoming_need = o->frontend_need = 4;
  return ocipp_current(o);
}
static uint64_t ocipp_u64(const unsigned char *p) {
  uint64_t n = 0; for (unsigned int i = 0; i < 8; ++i) n = (n << 8) | p[i]; return n;
}
static void ocipp_put64(unsigned char *p, uint64_t n) {
  for (unsigned int i = 0; i < 8; ++i) { p[7 - i] = (unsigned char)n; n >>= 8; }
}
static int ocipp_binding_current(struct ocipp_owner *o) {
  uint64_t cookie = 0; socklen_t size = sizeof(cookie);
  if (ocipp_current(o) < 0 || !o->bound || o->listener < 0 ||
      getsockopt(o->listener, SOL_SOCKET, SO_COOKIE, &cookie, &size) < 0 ||
      size != sizeof(cookie) || !cookie || cookie != o->listener_cookie) { errno = ESTALE; return -1; }
  return 0;
}
/* Binary framed bootstrap: TKOBIND1 | claim64 | generationBE64 | capability32.
 * Only the original private bootstrap supplies the capability. No runtime key
 * is generated and no credential appears in the discoverable abstract name.
 * The listener's actual SO_COOKIE binds this P instance, not a caller PID/name.
 */
static int ocipp_bootstrap(struct ocipp_owner *o, const unsigned char *p, size_t size) {
  if (!p || size != 112 || memcmp(p, "TKOBIND1", 8)) { errno = EPROTO; return -1; }
  if (ocipp_initialize(o) < 0) return -1;
  for (unsigned int i = 0; i < 64; ++i)
    if (!((p[8 + i] >= '0' && p[8 + i] <= '9') || (p[8 + i] >= 'a' && p[8 + i] <= 'f'))) return -1;
  o->generation = ocipp_u64(p + 72);
  if (!o->generation || o->generation > UINT64_C(9007199254740991)) return -1;
  unsigned int any = 0; for (unsigned int i = 0; i < 32; ++i) any |= p[80 + i];
  if (!any) return -1;
  memcpy(o->claim, p + 8, 64); memcpy(o->capability, p + 80, 32);
  o->binding_attempt = 1;
  o->listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (o->listener < 0) return -1;
  struct sockaddr_un address; memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  static const char label[] = "tako-oci-parent-v1:";
  memcpy(address.sun_path + 1, label, sizeof(label) - 1);
  memcpy(address.sun_path + sizeof(label), o->claim, 64);
  socklen_t length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + sizeof(label) + 64);
  if (bind(o->listener, (const struct sockaddr *)&address, length) < 0 || listen(o->listener, 1) < 0) return -1;
  struct sockaddr_un actual; memset(&actual, 0, sizeof(actual)); socklen_t n = sizeof(actual);
  if (getsockname(o->listener, (struct sockaddr *)&actual, &n) < 0 || n != length || memcmp(&address, &actual, length)) return -1;
  n = sizeof(o->listener_cookie);
  if (getsockopt(o->listener, SOL_SOCKET, SO_COOKIE, &o->listener_cookie, &n) < 0 ||
      n != sizeof(o->listener_cookie) || !o->listener_cookie) return -1;
  o->bound = 1;
  return ocipp_binding_current(o);
}
/* No H spawn or CREATE is performed by bootstrap/info. The caller has a
 * durable-save/fresh-guard window BEFORE it supplies the later canonical CREATE.
 * Info body is TKOINFO1 | claim64 | generationBE64 | actualListenerCookieBE64.
 */
static int ocipp_bootstrap_reply(struct ocipp_owner *o) {
  if (ocipp_binding_current(o) < 0 || o->attempted || o->create) return -1;
  unsigned char bytes[92] = {0, 0, 0, 88};
  memcpy(bytes + 4, "TKOINFO1", 8); memcpy(bytes + 12, o->claim, 64);
  ocipp_put64(bytes + 76, o->generation); ocipp_put64(bytes + 84, o->listener_cookie);
  int64_t now = ocip_now(); if (now < 0) return -1;
  return ocip_io(1, bytes, sizeof(bytes), 1, 0, now + 4000);
}
/* Exact v6.12 64-bit pidfs profile only. pidfs_getattr deliberately masks
 * S_IFMT, so no regular-file predicate applies. A live held pidfd plus boot,
 * dev and pid->ino identifies this tracked process; 64-bit counter wrap and
 * installed-kernel equivalence remain external qualification limits. */
static int ocipp_pidfs(int fd, uint64_t *device, uint64_t *inode) {
  struct statfs fs; struct stat st;
  struct pollfd p = {.fd = fd, .events = POLLIN};
  if (sizeof(unsigned long) != 8 || sizeof(ino_t) != 8 || fd < 0 ||
      fstatfs(fd, &fs) < 0 || fs.f_type != PID_FS_MAGIC ||
      fstat(fd, &st) < 0 || !st.st_ino || poll(&p, 1, 0) != 0 || p.revents) {
    errno = ESTALE; return -1;
  }
  *device = (uint64_t)st.st_dev; *inode = (uint64_t)st.st_ino;
  return 0;
}
static int ocipp_boot_id(struct ocipp_owner *o, char out[37]) {
  int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  struct statfs fs; unsigned char bytes[38], extra; int valid = 0;
  if (fstatfs(fd, &fs) == 0 && fs.f_type == PROC_SUPER_MAGIC &&
      read(fd, bytes, sizeof(bytes)) == 37 && bytes[36] == '\n' && read(fd, &extra, 1) == 0) {
    valid = 1;
    for (unsigned int i = 0; i < 36; ++i) {
      int dash = i == 8 || i == 13 || i == 18 || i == 23;
      if (dash ? bytes[i] != '-' : !((bytes[i] >= '0' && bytes[i] <= '9') ||
          (bytes[i] >= 'a' && bytes[i] <= 'f'))) valid = 0;
    }
    if (valid) { memcpy(out, bytes, 36); out[36] = 0; }
  }
  if (ocipp_close(o, &fd) < 0 || !valid) { errno = ESTALE; return -1; }
  return 0;
}
static int ocipp_self_current(struct ocipp_owner *o) {
  uint64_t device = 0, inode = 0; char boot[37];
  if (ocipp_binding_current(o) < 0 || o->close_unknown || !o->self_attempt ||
      ocipp_pidfs(o->self_pidfd, &device, &inode) < 0 ||
      device != o->self_device || inode != o->self_inode ||
      ocipp_boot_id(o, boot) < 0 || memcmp(boot, o->boot_id, sizeof(boot))) return -1;
  return ocipp_binding_current(o);
}
static int ocipp_peer_bootstrap(struct ocipp_owner *o, const unsigned char *p, size_t size) {
  if (!p || size != 112 || memcmp(p, "TKOBIND2", 8)) { errno = EPROTO; return -1; }
  unsigned char legacy[112]; memcpy(legacy, p, sizeof(legacy)); memcpy(legacy, "TKOBIND1", 8);
  int result = ocipp_bootstrap(o, legacy, sizeof(legacy));
  explicit_bzero(legacy, sizeof(legacy));
  if (result < 0 || o->self_attempt) return -1;
  o->self_attempt = 1; o->self_pidfd = -1;
  /* Only our own current process: connector peers use SO_PEERPIDFD below. */
  long fd = syscall(SYS_pidfd_open, getpid(), 0u);
  if (fd < 0 || fd > INT_MAX) return -1;
  o->self_pidfd = (int)fd;
  if (fcntl(o->self_pidfd, F_SETFD, FD_CLOEXEC) < 0 ||
      ocipp_pidfs(o->self_pidfd, &o->self_device, &o->self_inode) < 0 ||
      ocipp_boot_id(o, o->boot_id) < 0) return -1;
  return ocipp_self_current(o);
}
/* TKOINFO2 is original info plus devBE64/inoBE64/canonical boot UUID36.
 * These are interval identity facts, no H/CREATE/SQL/retirement permission. */
static int ocipp_peer_bootstrap_reply(struct ocipp_owner *o) {
  if (ocipp_self_current(o) < 0 || o->attempted || o->create) return -1;
  unsigned char bytes[144] = {0, 0, 0, 140};
  memcpy(bytes + 4, "TKOINFO2", 8); memcpy(bytes + 12, o->claim, 64);
  ocipp_put64(bytes + 76, o->generation); ocipp_put64(bytes + 84, o->listener_cookie);
  ocipp_put64(bytes + 92, o->self_device); ocipp_put64(bytes + 100, o->self_inode);
  memcpy(bytes + 108, o->boot_id, 36);
  int64_t now = ocip_now(); if (now < 0) return -1;
  return ocip_io(1, bytes, sizeof(bytes), 1, 0, now + 4000);
}
static int ocipp_first_create(struct ocipp_owner *o, const unsigned char *body, uint32_t size) {
  if (ocipp_binding_current(o) < 0 || o->create_attempt || o->attempted || o->create ||
      !body || !size || size > TNS_OCI_MAX_JSON) return -1;
  o->create_attempt = 1;
  char claim[65]; uint64_t generation = 0;
  if (ocipp_decode(body, size, claim, &generation, 1, NULL) < 0 ||
      strcmp(claim, o->claim) || generation != o->generation) { errno = EPROTO; return -1; }
  o->create_size = (size_t)size + 4; o->create = calloc(1, o->create_size);
  if (!o->create) return -1;
  o->create[0] = (unsigned char)(size >> 24); o->create[1] = (unsigned char)(size >> 16);
  o->create[2] = (unsigned char)(size >> 8); o->create[3] = (unsigned char)size;
  memcpy(o->create + 4, body, size); memcpy(o->incoming, o->create, o->create_size);
  o->incoming_size = o->incoming_need = o->create_size; o->pending = 1;
  o->request_kind = TNS_OCIP_CREATE; o->effects |= 1u << TNS_OCIP_CREATE;
  o->request_size = o->create_size;
  return ocipp_binding_current(o);
}
static _Noreturn void ocipp_child(struct ocipp_owner *o) {
  if (getppid() != o->controller || prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0) < 0 ||
      getppid() != o->controller) _exit(126);
  int source[4] = {o->input[0], o->output[1], o->errors[1], o->executable}, saved[4];
  for (unsigned int i = 0; i < 4; ++i) {
    saved[i] = fcntl(source[i], F_DUPFD_CLOEXEC, 10);
    if (saved[i] < 0) _exit(126);
  }
  for (unsigned int i = 0; i < 4; ++i)
    if (dup3(saved[i], (int)i, i == 3 ? O_CLOEXEC : 0) < 0) _exit(126);
  if (syscall(SYS_close_range, 4u, ~0u, 0u) < 0) _exit(126);
  sigset_t empty; sigemptyset(&empty);
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = SIG_DFL;
  if (sigprocmask(SIG_SETMASK, &empty, NULL) < 0 || sigaction(SIGCHLD, &action, NULL) < 0 ||
      sigaction(SIGTERM, &action, NULL) < 0 || sigaction(SIGINT, &action, NULL) < 0) _exit(126);
  struct stat st;
  if (fstat(3, &st) < 0 || !ocipp_same_executable(&st, &o->executable_identity) ||
      getppid() != o->controller) _exit(126);
  (void)umask(077);
  char *const argv[] = {(char *)"docker-container-terminal-oci", NULL};
  char *const environment[] = {NULL};
  (void)syscall(SYS_execveat, 3, "", argv, environment, AT_EMPTY_PATH);
  _exit(126);
}
static int ocipp_spawn(struct ocipp_owner *o) {
  if (!o || o->attempted) { errno = EALREADY; return -1; }
  if (ocipp_binding_current(o) < 0 || !o->create || !o->pending) return -1;
  o->attempted = 1; /* Permanently consumed before any possible child birth. */
  if (pipe2(o->input, O_CLOEXEC | O_NONBLOCK) < 0 ||
      pipe2(o->output, O_CLOEXEC | O_NONBLOCK) < 0 ||
      pipe2(o->errors, O_CLOEXEC | O_NONBLOCK) < 0) return -1;
  if (ocipp_current(o) < 0) return -1;
  struct clone_args args; memset(&args, 0, sizeof(args));
  args.flags = CLONE_PIDFD; args.pidfd = (uint64_t)(uintptr_t)&o->pidfd; args.exit_signal = SIGCHLD;
  long child = syscall(SYS_clone3, &args, sizeof(args));
  if (!child) ocipp_child(o);
  if (child < 0) return -1;
  o->child = (pid_t)child;
  if (o->pidfd < 0) { o->wait_unknown = 1; return -1; }
  int result = 0;
  if (ocipp_close(o, &o->input[0]) < 0) result = -1;
  if (ocipp_close(o, &o->output[1]) < 0) result = -1;
  if (ocipp_close(o, &o->errors[1]) < 0) result = -1;
  if (ocipp_current(o) < 0) { o->identity_unknown = 1; result = -1; }
  return result;
}
/* Consuming wait of this exact clone-created pidfd only. No waitpid(-1),
 * WNOWAIT, caller PID, exit event inference or replacement child. */
static int ocipp_wait(struct ocipp_owner *o) {
  if (ocipp_controller(o) < 0 || !o->child || o->pidfd < 0) return -1;
  if (o->wait_unknown) { errno = EUCLEAN; return -1; }
  if (o->joined) return 0;
  siginfo_t status; memset(&status, 0, sizeof(status));
  if (waitid(P_PIDFD, (id_t)o->pidfd, &status, WEXITED | WNOHANG) < 0) {
    if (errno == EINTR) return 1;
    o->wait_unknown = 1; return -1;
  }
  if (!status.si_pid) return 1;
  if (status.si_pid != o->child || status.si_signo != SIGCHLD ||
      (status.si_code != CLD_EXITED && status.si_code != CLD_KILLED && status.si_code != CLD_DUMPED) ||
      (status.si_code == CLD_EXITED && (status.si_status < 0 || status.si_status > 255)) ||
      (status.si_code != CLD_EXITED && (status.si_status <= 0 || status.si_status >= NSIG))) {
    o->wait_unknown = 1; errno = EPROTO; return -1;
  }
  o->joined = 1; o->code = status.si_code; o->status = status.si_status; return 0;
}
static int ocipp_drain(struct ocipp_owner *o, unsigned int which) {
  if (ocipp_controller(o) < 0 || which > 1) return -1;
  if (o->eof[which]) return 0;
  if (o->pipe_unknown[which]) { errno = EUCLEAN; return -1; }
  int *slot = which ? &o->errors[0] : &o->output[0];
  size_t capacity = which ? OCIPP_ERROR_MAX : OCIPP_OUTPUT_MAX;
  if (*slot < 0 || o->used[which] == capacity) { o->pipe_unknown[which] = 1; errno = ENOBUFS; return -1; }
  ssize_t n = read(*slot, o->captured[which] + o->used[which], capacity - o->used[which]);
  if (n < 0) {
    if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) return 1;
    o->pipe_unknown[which] = 1; return -1;
  }
  if (!n) { o->eof[which] = 1; return ocipp_close(o, slot); }
  o->used[which] += (size_t)n; return 1;
}
static int ocipp_fact(struct ocipp_owner *o) {
  if (ocipp_controller(o) < 0) return -1;
  if (ocipp_current(o) < 0) o->identity_unknown = 1;
  if (o->wait_unknown || o->identity_unknown || o->close_unknown || o->pipe_unknown[0] || o->pipe_unknown[1]) {
    errno = EUCLEAN; return -1;
  }
  if (!o->joined || !o->eof[0] || !o->eof[1]) { errno = EAGAIN; return -1; }
  if (o->code != CLD_EXITED || o->status) { errno = ECHILD; return -1; }
  return 0;
}
static int ocipp_management_text(struct ocipp_owner *o, const char *body) {
  size_t size = strlen(body);
  if (o->management_sent != o->management_size || size > 900) { errno = EBUSY; return -1; }
  o->management_output[0] = (unsigned char)(size >> 24); o->management_output[1] = (unsigned char)(size >> 16);
  o->management_output[2] = (unsigned char)(size >> 8); o->management_output[3] = (unsigned char)size;
  memcpy(o->management_output + 4, body, size); o->management_sent = 0; o->management_size = size + 4;
  return 0;
}
static int ocipp_frontend_close(struct ocipp_owner *o, int *slot) {
  if (*slot < 0) return 0;
  int fd = *slot; *slot = -1;
  if (close(fd) < 0) { o->management_unknown = 1; return -1; }
  return 0;
}
/* Auth body: TKOAUTH1 | claim64 | generationBE64 | actualCookieBE64 | cap32.
 * UID, endpoint and all public fields are insufficient without this original
 * capability AND original listener cookie/current executable/controller.
 */
static int ocipp_authenticate(struct ocipp_owner *o, const unsigned char *p, size_t size) {
  if (!p || ocipp_binding_current(o) < 0 || o->management_unknown || size != 120 ||
      memcmp(p, "TKOAUTH1", 8) || memcmp(p + 8, o->claim, 64) ||
      ocipp_u64(p + 72) != o->generation || ocipp_u64(p + 80) != o->listener_cookie) return -1;
  unsigned int difference = 0;
  for (unsigned int i = 0; i < 32; ++i) difference |= (unsigned int)(p[88 + i] ^ o->capability[i]);
  if (difference) { errno = EACCES; return -1; }
  return 0;
}
static int ocipp_accept(struct ocipp_owner *o) {
  if (ocipp_binding_current(o) < 0 || o->management_unknown || o->candidate >= 0) return -1;
  int fd = accept4(o->listener, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
  if (fd < 0) return -1;
  o->candidate = fd;
  struct ucred peer; socklen_t n = sizeof(peer);
  if (!o->host_lost || o->frontend >= 0 || getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &n) < 0 ||
      n != sizeof(peer) || peer.uid || peer.pid <= 0) return ocipp_frontend_close(o, &o->candidate);
  o->authentication_used = 0; explicit_bzero(o->authentication, sizeof(o->authentication));
  o->authentication_started = ocip_now();
  if (o->authentication_started < 0) return ocipp_frontend_close(o, &o->candidate);
  return 0;
}
static int ocipp_read_authentication(struct ocipp_owner *o) {
  if (o->candidate < 0 || ocipp_binding_current(o) < 0) return -1;
  int64_t now = ocip_now();
  if (now < 0 || now - o->authentication_started >= 4000) return ocipp_frontend_close(o, &o->candidate);
  if (o->authentication_used >= sizeof(o->authentication)) {
    errno = EPROTO; (void)ocipp_frontend_close(o, &o->candidate); return -1;
  }
  size_t remaining = sizeof(o->authentication) - o->authentication_used;
  ssize_t n = read(o->candidate, o->authentication + o->authentication_used, remaining);
  if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 0;
  if (n <= 0) return ocipp_frontend_close(o, &o->candidate);
  if ((size_t)n > remaining) {
    errno = EPROTO; (void)ocipp_frontend_close(o, &o->candidate); return -1;
  }
  o->authentication_used += (size_t)n;
  if (o->authentication_used >= 4 && memcmp(o->authentication, (unsigned char[]){0, 0, 0, 120}, 4))
    return ocipp_frontend_close(o, &o->candidate);
  if (o->authentication_used != sizeof(o->authentication)) return 0;
  if (ocipp_authenticate(o, o->authentication + 4, 120) < 0)
    return ocipp_frontend_close(o, &o->candidate);
  o->frontend = o->candidate; o->candidate = -1; o->host_lost = 0; o->replay_required = 1;
  o->frontend_used = 0; o->frontend_need = 4;
  explicit_bzero(o->authentication, sizeof(o->authentication));
  o->management_size = o->management_sent = 0; o->management_resume = 0;
  return ocipp_management_text(o, "{\"kind\":\"linux-oci-parent-authenticated@1\",\"barrier\":\"unproven\"}");
}
static int ocipp_is_effect(enum tns_ocip_kind kind) {
  return kind == TNS_OCIP_CREATE || kind == TNS_OCIP_START || kind == TNS_OCIP_STOP_INIT ||
    kind == TNS_OCIP_RELEASE_NAMESPACE || kind == TNS_OCIP_BEGIN_TRACKED_JOIN ||
    kind == TNS_OCIP_DELETE_BORN || kind == TNS_OCIP_DISPOSE_BORN;
}
static int ocipp_allowed(struct ocipp_owner *o, enum tns_ocip_kind kind) {
  if (ocipp_is_effect(kind) && (o->effects & (1u << kind))) { errno = EALREADY; return -1; }
  enum tns_ocip_kind original = kind == TNS_OCIP_JOIN_INIT ? TNS_OCIP_STOP_INIT :
    kind == TNS_OCIP_CONTINUE_NAMESPACE_RELEASE || kind == TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME ? TNS_OCIP_RELEASE_NAMESPACE :
    kind == TNS_OCIP_READ_TRACKED_JOIN ? TNS_OCIP_BEGIN_TRACKED_JOIN :
    kind == TNS_OCIP_JOIN_BORN_DELETE ? TNS_OCIP_DELETE_BORN :
    kind == TNS_OCIP_CONTINUE_BORN_DISPOSAL ? TNS_OCIP_DISPOSE_BORN : 0;
  if (original && !(o->effects & (1u << original))) return -1;
  if ((o->effects & (1u << TNS_OCIP_DISPOSE_BORN)) && kind != TNS_OCIP_CONTINUE_BORN_DISPOSAL) return -1;
  if ((o->effects & (1u << TNS_OCIP_BEGIN_TRACKED_JOIN)) && kind != TNS_OCIP_READ_TRACKED_JOIN &&
      kind != TNS_OCIP_DELETE_BORN && kind != TNS_OCIP_JOIN_BORN_DELETE && kind != TNS_OCIP_DISPOSE_BORN &&
      kind != TNS_OCIP_CONTINUE_BORN_DISPOSAL && kind != TNS_OCIP_CANCEL) return -1;
  return 0; /* Routing only. The original H still enforces every producer phase. */
}
static int ocipp_queue(struct ocipp_owner *o, const unsigned char *body, uint32_t size) {
  if (ocipp_binding_current(o) < 0 || o->joined || o->wait_unknown || o->reply_unknown || o->identity_unknown) return -1;
  if (!o->create) {
    if (ocipp_first_create(o, body, size) < 0) return -1;
    return ocipp_spawn(o);
  }
  if (o->pending || o->awaiting) { errno = EBUSY; return -1; }
  enum tns_ocip_kind kind = 0;
  if (ocipp_decode(body, size, NULL, NULL, 0, &kind) < 0 || ocipp_allowed(o, kind) < 0) return -1;
  if (ocipp_is_effect(kind)) o->effects |= 1u << kind;
  o->request_kind = kind; o->request_size = (size_t)size + 4; o->issued_size = 0;
  o->last_reply_start = o->last_reply_end = 0;
  memmove(o->incoming + 4, body, size);
  o->incoming[0] = (unsigned char)(size >> 24); o->incoming[1] = (unsigned char)(size >> 16);
  o->incoming[2] = (unsigned char)(size >> 8); o->incoming[3] = (unsigned char)size;
  o->incoming_size = o->incoming_need = (size_t)size + 4; o->incoming_sent = 0; o->pending = 1;
  return 0;
}
static int ocipp_management(struct ocipp_owner *o, const unsigned char *body, size_t size) {
  static const char result[] = "{\"kind\":\"linux-oci-parent-read-result@1\"}";
  static const char outcome[] = "{\"kind\":\"linux-oci-parent-read-outcome@1\"}";
  static const char resume[] = "{\"kind\":\"linux-oci-parent-continue-frame@1\"}";
  if (ocipp_binding_current(o) < 0 || o->frontend < 0) return -1;
  char text[900]; int n;
  if (size == sizeof(resume) - 1 && !memcmp(body, resume, size)) {
    /* Authentication and reading past facts cannot issue held unsent effects.
     * Only this explicit operation continues the SAME previously saved frame. */
    if (o->replay_required || !o->input_paused || !o->pending || o->incoming_sent ||
        o->reply_unknown || o->wait_unknown || o->identity_unknown || o->joined) return -1;
    o->input_paused = 0;
    return ocipp_management_text(o, "{\"kind\":\"linux-oci-parent-frame-continued@1\",\"barrier\":\"unproven\"}");
  }
  if (size == sizeof(result) - 1 && !memcmp(body, result, size)) {
    int fact = ocipp_fact(o), error = fact ? errno : 0;
    n = snprintf(text, sizeof(text), "{\"kind\":\"%s\",\"error\":%d,\"barrier\":\"unproven\"}",
      fact ? "linux-oci-parent-h-result-refused@1" : "linux-oci-parent-h-exited@1", error);
    if (n < 0 || (size_t)n >= sizeof(text)) return -1;
    return ocipp_management_text(o, text);
  }
  if (size != sizeof(outcome) - 1 || memcmp(body, outcome, size)) return 1;
  size_t start = o->last_reply_start, end = o->last_reply_end;
  if (end < start || end > o->used[0]) return -1;
  n = snprintf(text, sizeof(text), "{\"kind\":\"linux-oci-parent-outcome@1\",\"requestKind\":%u,\"effects\":%u,\"requestBytes\":\"%zu\",\"issuedBytes\":\"%zu\",\"deliveryUnknown\":%u,\"replyBytes\":\"%zu\",\"barrier\":\"unproven\"}",
    (unsigned int)o->request_kind, o->effects, o->request_size, o->issued_size, o->delivery_unknown, end - start);
  if (n < 0 || (size_t)n >= sizeof(text) || ocipp_management_text(o, text) < 0) return -1;
  if (end > start) {
    if (end > o->used[0] || end - start > TNS_OCI_MAX_JSON + 4u) return -1;
    memcpy(o->management_output + o->management_size, o->captured[0] + start, end - start);
    o->management_size += end - start;
    o->management_resume = o->awaiting && o->reply_ready;
    o->replay_required = 0;
  } else if (!o->awaiting) o->replay_required = 0;
  return 0;
}
static void ocipp_host_lost(struct ocipp_owner *o);
static int ocipp_frontend_read(struct ocipp_owner *o) {
  if (o->frontend < 0 || o->management_size != o->management_sent) return -1;
  ssize_t n = read(o->frontend, o->frontend_input + o->frontend_used, o->frontend_need - o->frontend_used);
  if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 0;
  if (n <= 0) { ocipp_host_lost(o); return -1; }
  o->frontend_used += (size_t)n;
  if (o->frontend_used == 4 && o->frontend_need == 4) {
    uint32_t length;
    if (tns_ocip_frame(o->frontend_input, &length) < 0) { ocipp_host_lost(o); return -1; }
    o->frontend_need = (size_t)length + 4;
  }
  if (o->frontend_used != o->frontend_need) return 0;
  int result = ocipp_management(o, o->frontend_input + 4, o->frontend_used - 4);
  if (result == 1) {
    if (o->replay_required) result = -1;
    else result = ocipp_queue(o, o->frontend_input + 4, (uint32_t)(o->frontend_used - 4));
  }
  if (result < 0) { ocipp_host_lost(o); return -1; }
  explicit_bzero(o->frontend_input, o->frontend_used); o->frontend_used = 0; o->frontend_need = 4;
  return 0;
}
static int ocipp_management_flush(struct ocipp_owner *o) {
  if (o->frontend < 0 || o->management_sent == o->management_size) return 0;
  ssize_t n = write(o->frontend, o->management_output + o->management_sent, o->management_size - o->management_sent);
  if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 0;
  if (n <= 0) { ocipp_host_lost(o); return -1; }
  o->management_sent += (size_t)n;
  if (o->management_sent == o->management_size && o->management_resume) {
    /* Boundary comes from the actual captured original H frame, not a Host
     * acknowledgement. Effect latches and delivery UNKNOWN are never cleared. */
    o->management_resume = 0; o->awaiting = o->reply_ready = 0;
    o->frame_start = o->frame_end; o->delivered[0] = o->frame_end;
  }
  return 0;
}
static void ocipp_host_lost(struct ocipp_owner *o) {
  /* Keep the original H stdin OPEN for later original-record management.
   * Host loss is not H EOF, a cleanup request, exit, or a delivery ACK. */
  o->host_lost = 1;
  o->delivery_unknown = 1;
  if (o->pending && !o->incoming_sent) o->input_paused = 1;
  if (o->frontend >= 0) {
    if (o->frontend_used) o->reply_unknown = 1; /* Never splice a partial frame from a new frontend. */
    (void)ocipp_frontend_close(o, &o->frontend);
  } else if (!o->pending && o->incoming_size) o->reply_unknown = 1;
}
static int ocipp_flush_input(struct ocipp_owner *o) {
  if (ocipp_controller(o) < 0 || o->joined || o->wait_unknown || o->identity_unknown || o->reply_unknown) return -1;
  if (!o->pending || o->input_paused || (o->host_lost && !o->incoming_sent)) return 0;
  ssize_t n = write(o->input[1], o->incoming + o->incoming_sent, o->incoming_size - o->incoming_sent);
  if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
  if (n <= 0) { ocipp_host_lost(o); o->reply_unknown = 1; return -1; }
  o->incoming_sent += (size_t)n;
  o->issued_size = o->incoming_sent;
  if (o->incoming_sent == o->incoming_size) {
    explicit_bzero(o->incoming, o->incoming_size); o->incoming_size = o->incoming_sent = 0;
    o->incoming_need = 4; o->pending = 0; o->awaiting = 1;
  }
  return 0;
}
static int ocipp_parse_reply(struct ocipp_owner *o) {
  if (!o->awaiting || o->reply_ready || o->used[0] - o->frame_start < 4) return 0;
  uint32_t size;
  if (tns_ocip_frame(o->captured[0] + o->frame_start, &size) < 0) {
    o->reply_unknown = 1; ocipp_host_lost(o); errno = EPROTO; return -1;
  }
  if (o->used[0] - o->frame_start < (size_t)size + 4) return 0;
  o->frame_end = o->frame_start + (size_t)size + 4;
  if (o->used[0] != o->frame_end) {
    o->reply_unknown = 1; ocipp_host_lost(o); errno = EPROTO; return -1;
  }
  o->last_reply_start = o->frame_start; o->last_reply_end = o->frame_end;
  o->reply_ready = 1; return 0;
}
static int ocipp_forward(struct ocipp_owner *o, unsigned int which) {
  if (o->host_lost) return 0;
  if (o->frontend >= 0 && (which || o->replay_required || o->management_size != o->management_sent)) return 0;
  size_t end = which ? o->used[1] : o->reply_ready ? o->frame_end : o->delivered[0];
  if (o->delivered[which] == end) return 0;
  ssize_t n = write(o->frontend >= 0 ? o->frontend : which ? 2 : 1,
    o->captured[which] + o->delivered[which], end - o->delivered[which]);
  if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
  if (n <= 0) { ocipp_host_lost(o); return -1; }
  o->delivered[which] += (size_t)n;
  if (!which && o->delivered[0] == o->frame_end) {
    o->awaiting = o->reply_ready = 0; o->frame_start = o->frame_end;
  }
  return 0; /* Delivery progress only. Captured original bytes remain retained. */
}
static int ocipp_read_host(struct ocipp_owner *o) {
  if (o->host_lost || o->pending || o->awaiting || o->joined) return 0;
  ssize_t n = read(0, o->incoming + o->incoming_size, o->incoming_need - o->incoming_size);
  if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
  if (n <= 0) { ocipp_host_lost(o); return -1; }
  o->incoming_size += (size_t)n;
  if (o->incoming_size == 4 && o->incoming_need == 4) {
    uint32_t size;
    if (tns_ocip_frame(o->incoming, &size) < 0) { ocipp_host_lost(o); return -1; }
    o->incoming_need = (size_t)size + 4;
  }
  if (o->incoming_size == o->incoming_need) {
    if (ocipp_queue(o, o->incoming + 4, (uint32_t)(o->incoming_size - 4)) < 0) {
      ocipp_host_lost(o); return -1;
    }
  }
  return 0;
}
static int ocipp_step(struct ocipp_owner *o) {
  if (ocipp_controller(o) < 0) return -1;
  if (ocipp_current(o) < 0) { o->identity_unknown = 1; ocipp_host_lost(o); }
  if (ocipp_interrupted) ocipp_host_lost(o);
  int sending = o->pending && !o->input_paused && (!o->host_lost || o->incoming_sent) &&
    !o->identity_unknown && !o->joined && !o->wait_unknown && !o->reply_unknown;
  struct pollfd p[7] = {{.fd = o->frontend >= 0 || o->host_lost || o->joined || o->wait_unknown ? -1 : 0,
      .events = o->pending || o->awaiting ? 0 : POLLIN},
    {.fd = o->eof[0] || o->pipe_unknown[0] ? -1 : o->output[0], .events = POLLIN},
    {.fd = o->eof[1] || o->pipe_unknown[1] ? -1 : o->errors[0], .events = POLLIN},
    {.fd = sending ? o->input[1] : -1, .events = POLLOUT},
    {.fd = o->bound && !o->management_unknown && o->candidate < 0 ? o->listener : -1, .events = POLLIN},
    {.fd = o->candidate, .events = POLLIN},
    {.fd = o->frontend, .events = o->management_sent == o->management_size ? POLLIN : POLLOUT}};
  int n = poll(p, 7, 1000);
  if (n < 0 && errno != EINTR) { o->reply_unknown = 1; ocipp_host_lost(o); }
  if (p[0].revents & (POLLHUP | POLLERR | POLLNVAL)) ocipp_host_lost(o);
  if (p[0].revents & POLLIN) (void)ocipp_read_host(o);
  for (unsigned int i = 0; i < 2; ++i) {
    if (p[i + 1].revents & (POLLERR | POLLNVAL)) o->pipe_unknown[i] = 1;
    else if (p[i + 1].revents & (POLLIN | POLLHUP)) (void)ocipp_drain(o, i);
  }
  if (p[4].revents & (POLLERR | POLLNVAL | POLLHUP)) o->management_unknown = 1;
  else if (p[4].revents & POLLIN) (void)ocipp_accept(o);
  if (o->candidate >= 0) (void)ocipp_read_authentication(o);
  if (p[6].revents & (POLLERR | POLLHUP | POLLNVAL)) ocipp_host_lost(o);
  else {
    if (p[6].revents & POLLIN) (void)ocipp_frontend_read(o);
    if (p[6].revents & POLLOUT) (void)ocipp_management_flush(o);
  }
  (void)ocipp_wait(o);
  (void)ocipp_parse_reply(o); (void)ocipp_forward(o, 0); (void)ocipp_forward(o, 1);
  if (o->eof[0] && o->awaiting && !o->reply_ready) {
    o->reply_unknown = 1; ocipp_host_lost(o);
  }
  if (p[3].revents & (POLLERR | POLLHUP | POLLNVAL)) {
    o->reply_unknown = 1; ocipp_host_lost(o);
  } else if (p[3].revents & POLLOUT)
    (void)ocipp_flush_input(o);
  return ocipp_fact(o);
}
static int ocipp_peer_mode;
static int ocipp_main(void) {
  if (geteuid() || ocip_private_channel(0) < 0 || ocip_private_channel(1) < 0) return 77;
  for (int fd = 0; fd < 3; ++fd) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) return 77;
  }
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = SIG_IGN;
  if (sigaction(SIGPIPE, &action, NULL) < 0) return 77;
  action.sa_handler = ocipp_interrupt;
  if (sigaction(SIGTERM, &action, NULL) < 0 || sigaction(SIGINT, &action, NULL) < 0) return 77;
  action.sa_handler = SIG_DFL;
  if (sigaction(SIGCHLD, &action, NULL) < 0 || prctl(PR_SET_PDEATHSIG, 0, 0, 0, 0) < 0) return 77;
  sigset_t controls; sigemptyset(&controls); sigaddset(&controls, SIGCHLD);
  sigaddset(&controls, SIGTERM); sigaddset(&controls, SIGINT);
  if (sigprocmask(SIG_UNBLOCK, &controls, NULL) < 0) return 77;
  unsigned char *body = NULL; uint32_t size = 0;
  if (ocip_read(&body, &size)) { if (body) { explicit_bzero(body, size); free(body); } return 77; }
  struct ocipp_owner *o = calloc(1, sizeof(*o));
  int prepared = o ? (ocipp_peer_mode ? ocipp_peer_bootstrap(o, body, size) : ocipp_bootstrap(o, body, size)) : -1;
  explicit_bzero(body, size); free(body);
  if (prepared < 0) return 77; /* No H has been created or sent any bytes. */
  if ((ocipp_peer_mode ? ocipp_peer_bootstrap_reply(o) : ocipp_bootstrap_reply(o)) < 0) return 77;
  /* This SAME P stays alive after Host loss AND after a known H exit. Facts and
   * all original output remain in this record. Authenticated reads/control are
   * not SQL, full-traffic or retirement permission. */
  for (;;) (void)ocipp_step(o);
}
/* A separate one-shot same-binary process, not P/H or a result oracle from its
 * own exit. Only the original P's fixed read-result reply is relayed, after
 * kernel peer identity is checked BEFORE cap bytes and again after the read. */
struct ocipp_connector {
  struct ocipp_owner custody;
  int socket, peer_pidfd; unsigned int attempted, outcome_phase, init_attempt;
  int64_t deadline;
  uint64_t device, inode; char boot[37];
};
static int ocipp_connector_current(struct ocipp_connector *c) {
  uint64_t device = 0, inode = 0; char boot[37];
  if (ocipp_current(&c->custody) < 0 || c->custody.close_unknown ||
      ocipp_pidfs(c->peer_pidfd, &device, &inode) < 0 ||
      device != c->device || inode != c->inode ||
      ocipp_boot_id(&c->custody, boot) < 0 || memcmp(boot, c->boot, sizeof(boot))) return -1;
  return ocipp_current(&c->custody);
}
static int ocipp_connector_frame(int fd, unsigned char out[512], size_t *size, int64_t until) {
  unsigned char prefix[4];
  if (ocip_io(fd, prefix, sizeof(prefix), 0, 0, until) < 0) return -1;
  uint32_t n = ((uint32_t)prefix[0] << 24) | ((uint32_t)prefix[1] << 16) |
    ((uint32_t)prefix[2] << 8) | prefix[3];
  if (!n || n >= 512 || ocip_io(fd, out, n, 0, 0, until) < 0) return -1;
  out[n] = 0; *size = n; return 0;
}
static int ocipp_connector_result(const unsigned char *body, size_t size) {
  static const char yes[] = "{\"kind\":\"linux-oci-parent-h-exited@1\",\"error\":0,\"barrier\":\"unproven\"}";
  static const char no[] = "{\"kind\":\"linux-oci-parent-h-result-refused@1\",\"error\":";
  static const char tail[] = ",\"barrier\":\"unproven\"}";
  if (size == sizeof(yes) - 1 && !memcmp(body, yes, size)) return 0;
  if (size <= sizeof(no) + sizeof(tail) - 2 || memcmp(body, no, sizeof(no) - 1) ||
      memcmp(body + size - (sizeof(tail) - 1), tail, sizeof(tail) - 1)) return -1;
  size_t end = size - (sizeof(tail) - 1); int value = 0;
  if (body[sizeof(no) - 1] < '1' || body[sizeof(no) - 1] > '9') return -1;
  for (size_t i = sizeof(no) - 1; i < end; ++i) {
    if (body[i] < '0' || body[i] > '9' || value > (INT_MAX - (body[i] - '0')) / 10) return -1;
    value = value * 10 + body[i] - '0';
  }
  return value ? 0 : -1;
}
static int ocipp_connector_open(struct ocipp_connector *c, const unsigned char *p, size_t size) {
  if (!c || c->attempted || !p || size != 172 || memcmp(p, "TKOPEER2", 8)) return -1;
  c->attempted = 1; c->socket = c->peer_pidfd = -1;
  if (ocipp_initialize(&c->custody) < 0) return -1;
  for (unsigned int i = 0; i < 64; ++i)
    if (!((p[8 + i] >= '0' && p[8 + i] <= '9') || (p[8 + i] >= 'a' && p[8 + i] <= 'f'))) return -1;
  uint64_t generation = ocipp_u64(p + 72), cookie = ocipp_u64(p + 80);
  unsigned int any = 0; for (unsigned int i = 0; i < 32; ++i) any |= p[88 + i];
  c->device = ocipp_u64(p + 120); c->inode = ocipp_u64(p + 128);
  memcpy(c->boot, p + 136, 36); c->boot[36] = 0;
  char boot[37];
  if (!generation || generation > UINT64_C(9007199254740991) || !cookie || !any || !c->inode ||
      ocipp_boot_id(&c->custody, boot) < 0 || memcmp(boot, c->boot, sizeof(boot))) return -1;
  c->socket = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (c->socket < 0) return -1;
  struct sockaddr_un address; memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  static const char label[] = "tako-oci-parent-v1:";
  memcpy(address.sun_path + 1, label, sizeof(label) - 1); memcpy(address.sun_path + sizeof(label), p + 8, 64);
  socklen_t length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + sizeof(label) + 64);
  int64_t now = ocip_now(); if (now < 0) return -1;
  int64_t until = now + 4000; c->deadline = until;
  if (connect(c->socket, (struct sockaddr *)&address, length) < 0) {
    if (errno != EINPROGRESS) return -1;
    struct pollfd writable = {.fd = c->socket, .events = POLLOUT};
    if (poll(&writable, 1, 4000) != 1 || writable.revents != POLLOUT) return -1;
    int error = 0; length = sizeof(error);
    if (getsockopt(c->socket, SOL_SOCKET, SO_ERROR, &error, &length) < 0 ||
        length != sizeof(error) || error) return -1;
  }
  /* Captures the actual connected struct pid, never pidfd_open(caller PID). */
  length = sizeof(c->peer_pidfd);
  if (getsockopt(c->socket, SOL_SOCKET, SO_PEERPIDFD, &c->peer_pidfd, &length) < 0 ||
      length != sizeof(c->peer_pidfd) || c->peer_pidfd < 0 ||
      fcntl(c->peer_pidfd, F_SETFD, FD_CLOEXEC) < 0 || ocipp_connector_current(c) < 0) return -1;
  unsigned char auth[124] = {0, 0, 0, 120}; memcpy(auth + 4, "TKOAUTH1", 8);
  memcpy(auth + 12, p + 8, 112);
  int result = ocip_io(c->socket, auth, sizeof(auth), 1, 0, until);
  explicit_bzero(auth, sizeof(auth)); if (result < 0) return -1;
  unsigned char frame[512]; size_t n = 0;
  static const char ack[] = "{\"kind\":\"linux-oci-parent-authenticated@1\",\"barrier\":\"unproven\"}";
  if (ocipp_connector_frame(c->socket, frame, &n, until) < 0 || n != sizeof(ack) - 1 ||
      memcmp(frame, ack, n) || ocipp_connector_current(c) < 0) return -1;
  return 0;
}
static int ocipp_connector_read(struct ocipp_connector *c, const unsigned char *p, size_t size,
                                 unsigned char reply[512], size_t *reply_size) {
  if (ocipp_connector_open(c, p, size) < 0) return -1;
  int64_t until = c->deadline;
  static const char command[] = "{\"kind\":\"linux-oci-parent-read-result@1\"}";
  unsigned char request[4 + sizeof(command) - 1]; size_t bytes = sizeof(command) - 1;
  request[0] = (unsigned char)(bytes >> 24); request[1] = (unsigned char)(bytes >> 16);
  request[2] = (unsigned char)(bytes >> 8); request[3] = (unsigned char)bytes;
  memcpy(request + 4, command, bytes);
  if (ocip_io(c->socket, request, sizeof(request), 1, 0, until) < 0 ||
      ocipp_connector_frame(c->socket, reply, reply_size, until) < 0 ||
      ocipp_connector_result(reply, *reply_size) < 0 || ocipp_connector_current(c) < 0) return -1;
  struct pollfd trailing = {.fd = c->socket, .events = POLLIN};
  if (poll(&trailing, 1, 0) != 0 || trailing.revents) return -1;
  return 0;
}
/* A fixed two-stage peer connection. Past outcome is never a management
 * permission. Only a later explicit STOP/JOIN frame on original private stdin
 * may issue that fixed command; original P and H still enforce one-use/phase. */
static int ocipp_connector_command(struct ocipp_connector *c, const char *command, int64_t until) {
  size_t size = strlen(command);
  if (size >= 128 || ocipp_connector_current(c) < 0) return -1;
  unsigned char frame[132];
  frame[0] = frame[1] = frame[2] = 0; frame[3] = (unsigned char)size;
  memcpy(frame + 4, command, size);
  return ocip_io(c->socket, frame, size + 4, 1, 0, until);
}
static int ocipp_outcome_literal(const unsigned char **at, const unsigned char *end, const char *text) {
  size_t size = strlen(text);
  if ((size_t)(end - *at) < size || memcmp(*at, text, size)) return -1;
  *at += size; return 0;
}
static int ocipp_outcome_decimal(const unsigned char **at, const unsigned char *end, uint64_t limit, uint64_t *value) {
  const unsigned char *start = *at; uint64_t n = 0;
  while (*at < end && **at >= '0' && **at <= '9') {
    unsigned int digit = (unsigned int)(**at - '0');
    if (n > limit / 10 || (n == limit / 10 && digit > limit % 10)) return -1;
    n = n * 10 + digit; ++*at;
  }
  if (*at == start || (*at - start > 1 && *start == '0')) return -1;
  *value = n; return 0;
}
static int ocipp_connector_outcome_size(const unsigned char *body, size_t size, size_t *reply_size) {
  const unsigned char *at = body, *end = body + size; uint64_t kind, effects, request, issued, unknown, reply;
  if (ocipp_outcome_literal(&at,end,"{\"kind\":\"linux-oci-parent-outcome@1\",\"requestKind\":") < 0 ||
      ocipp_outcome_decimal(&at,end,TNS_OCIP_CONTINUE_BORN_DISPOSAL,&kind) < 0 ||
      ocipp_outcome_literal(&at,end,",\"effects\":") < 0 || ocipp_outcome_decimal(&at,end,UINT_MAX,&effects) < 0 ||
      ocipp_outcome_literal(&at,end,",\"requestBytes\":\"") < 0 || ocipp_outcome_decimal(&at,end,TNS_OCI_MAX_JSON+4u,&request) < 0 ||
      ocipp_outcome_literal(&at,end,"\",\"issuedBytes\":\"") < 0 || ocipp_outcome_decimal(&at,end,request,&issued) < 0 ||
      ocipp_outcome_literal(&at,end,"\",\"deliveryUnknown\":") < 0 || ocipp_outcome_decimal(&at,end,1,&unknown) < 0 ||
      ocipp_outcome_literal(&at,end,",\"replyBytes\":\"") < 0 || ocipp_outcome_decimal(&at,end,TNS_OCI_MAX_JSON+4u,&reply) < 0 ||
      ocipp_outcome_literal(&at,end,"\",\"barrier\":\"unproven\"}") < 0 || at != end || (reply && reply < 5)) return -1;
  *reply_size = (size_t)reply; return 0;
}
static int ocipp_connector_outcome(struct ocipp_connector *c, int64_t until) {
  if (c->outcome_phase || ocipp_connector_current(c) < 0) return -1;
  c->outcome_phase = 1;
  unsigned char body[512]; size_t size = 0, captured_size = 0;
  if (ocipp_connector_command(c,"{\"kind\":\"linux-oci-parent-read-outcome@1\"}",until) < 0 ||
      ocipp_connector_frame(c->socket,body,&size,until) < 0 ||
      ocipp_connector_outcome_size(body,size,&captured_size) < 0 || ocipp_connector_current(c) < 0 ||
      ocip_reply((const char *)body) < 0) return -1;
  if (captured_size) {
    unsigned char *captured = malloc(captured_size);
    if (!captured) return -1;
    int result = ocip_io(c->socket,captured,captured_size,0,0,until);
    uint32_t bytes = 0;
    if (!result && (tns_ocip_frame(captured,&bytes) < 0 || (size_t)bytes + 4 != captured_size)) result = -1;
    if (!result && ocipp_connector_current(c) < 0) result = -1;
    if (!result) result = ocip_io(1,captured,captured_size,1,0,until);
    free(captured); if (result < 0) return -1;
  }
  if (ocipp_connector_current(c) < 0) return -1;
  c->outcome_phase = 2; return 0;
}
static int ocipp_connector_init(struct ocipp_connector *c, const unsigned char *body, size_t size,
                                 unsigned char reply[512], size_t *reply_size) {
  static const char stop[] = "{\"kind\":\"linux-oci-stop-init@1\"}";
  static const char join[] = "{\"kind\":\"linux-oci-join-init@1\"}";
  static const char release[] = "{\"kind\":\"linux-oci-release-namespace@1\"}";
  static const char resume[] = "{\"kind\":\"linux-oci-continue-namespace-release@1\"}";
  const char *command = size == sizeof(stop)-1 && !memcmp(body,stop,size) ? stop :
    size == sizeof(join)-1 && !memcmp(body,join,size) ? join :
    size == sizeof(release)-1 && !memcmp(body,release,size) ? release :
    size == sizeof(resume)-1 && !memcmp(body,resume,size) ? resume : NULL;
  if (!command || c->outcome_phase != 2 || c->init_attempt || ocipp_connector_current(c) < 0) return -1;
  c->init_attempt = 1; /* consumed before the sole fixed command write */
  int64_t now = ocip_now(); if (now < 0) return -1;
  if (ocipp_connector_command(c,command,now+4000) < 0 ||
      ocipp_connector_frame(c->socket,reply,reply_size,now+20000) < 0 || ocipp_connector_current(c) < 0) return -1;
  struct pollfd trailing = {.fd=c->socket,.events=POLLIN};
  return poll(&trailing,1,0) || trailing.revents ? -1 : 0;
}
static int ocipp_connector_close(struct ocipp_connector *c) {
  if (ocipp_controller(&c->custody) < 0) return -1;
  int result = 0;
  if (ocipp_close(&c->custody, &c->peer_pidfd) < 0) result = -1;
  if (ocipp_close(&c->custody, &c->socket) < 0) result = -1;
  if (ocipp_close(&c->custody, &c->custody.executable) < 0) result = -1;
  return result || c->custody.close_unknown ? -1 : 0;
}
static void ocipp_connector_free(struct ocipp_connector *c) {
  free(c->custody.incoming); free(c->custody.frontend_input); free(c->custody.management_output);
  free(c->custody.captured[0]); free(c->custody.captured[1]);
}
static int ocipp_connector_main(void) {
  if (geteuid() || ocip_private_channel(0) < 0 || ocip_private_channel(1) < 0) return 77;
  unsigned char *body = NULL; uint32_t size = 0;
  if (ocip_read(&body, &size)) { if (body) { explicit_bzero(body, size); free(body); } return 77; }
  struct ocipp_connector c; memset(&c, 0, sizeof(c)); c.socket = c.peer_pidfd = -1;
  c.custody.executable = -1;
  unsigned char reply[512]; size_t reply_size = 0;
  int result = ocipp_connector_read(&c, body, size, reply, &reply_size);
  explicit_bzero(body, size); free(body);
  if (ocipp_connector_close(&c) < 0) result = -1;
  ocipp_connector_free(&c);
  if (result < 0) return 77;
  /* This relays original P's factual H reply, never connector-exit=>H-exit. */
  return ocip_reply((const char *)reply) < 0 ? 77 : 0;
}
static int ocipp_connector_management_main(void) {
  if (geteuid() || ocip_private_channel(0) < 0 || ocip_private_channel(1) < 0) return 77;
  unsigned char *body = NULL; uint32_t size = 0;
  if (ocip_read(&body,&size)) { if (body) { explicit_bzero(body,size); free(body); } return 77; }
  struct ocipp_connector c; memset(&c,0,sizeof(c)); c.socket=c.peer_pidfd=c.custody.executable=-1;
  int result=ocipp_connector_open(&c,body,size); explicit_bzero(body,size); free(body); body=NULL;
  if (!result) result=ocipp_connector_outcome(&c,c.deadline);
  unsigned char reply[512]; size_t reply_size=0;
  /* This wait is the source window for the owning fresh Sql guard. No command
   * or EOF before it authorises H IO; closing only this connector preserves P. */
  if (!result) { if (ocip_read(&body,&size)) result=-1;
    else result=ocipp_connector_init(&c,body,size,reply,&reply_size); }
  if (body) { explicit_bzero(body,size); free(body); }
  if (ocipp_connector_close(&c)<0) result=-1;
  ocipp_connector_free(&c);
  return result<0 || ocip_reply((const char *)reply)<0 ? 77 : 0;
}
static int ocipp_peer_main(void) { ocipp_peer_mode = 1; return ocipp_main(); }
#endif
