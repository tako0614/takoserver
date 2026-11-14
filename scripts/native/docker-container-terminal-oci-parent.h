#ifndef TAKO_OCI_PERSISTENT_PARENT_H
#define TAKO_OCI_PERSISTENT_PARENT_H

#include <linux/sched.h>
#include <sys/syscall.h>
#include <sys/wait.h>

/* Opt-in, dedicated same-binary parent, not an adopted/reconstructed session.
 * This record never leaves this original process. No reconnect/authentication
 * or public completion reply exists. Even fact() zero is only this H's exact
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
                          uint64_t *generation, int first) {
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
  explicit_bzero(copy, size + 1); free(copy);
  explicit_bzero(request, sizeof(*request)); free(request); return result;
}
static int ocipp_prepare(struct ocipp_owner *o, const unsigned char *body, uint32_t size) {
  if (!o || !body || !size || size > TNS_OCI_MAX_JSON) { errno = EINVAL; return -1; }
  if (o->controller || o->attempted) { errno = EALREADY; return -1; }
  memset(o, 0, sizeof(*o)); o->controller = getpid(); o->executable = o->pidfd = -1;
  for (unsigned int i = 0; i < 2; ++i) o->input[i] = o->output[i] = o->errors[i] = -1;
  if (geteuid() || ocipp_decode(body, size, o->claim, &o->generation, 1) < 0) return -1;
  o->executable = open("/proc/self/exe", O_PATH | O_CLOEXEC);
  if (o->executable < 0 || fstat(o->executable, &o->executable_identity) < 0 || ocipp_current(o) < 0) return -1;
  o->create_size = (size_t)size + 4;
  o->create = calloc(1, o->create_size);
  o->incoming = calloc(1, (size_t)TNS_OCI_MAX_JSON + 4);
  o->captured[0] = calloc(1, OCIPP_OUTPUT_MAX); o->captured[1] = calloc(1, OCIPP_ERROR_MAX);
  if (!o->create || !o->incoming || !o->captured[0] || !o->captured[1]) return -1;
  o->create[0] = (unsigned char)(size >> 24); o->create[1] = (unsigned char)(size >> 16);
  o->create[2] = (unsigned char)(size >> 8); o->create[3] = (unsigned char)size;
  memcpy(o->create + 4, body, size); memcpy(o->incoming, o->create, o->create_size);
  o->incoming_size = o->incoming_need = o->create_size; o->pending = 1;
  return ocipp_current(o);
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
  if (ocipp_current(o) < 0 || !o->create || !o->pending) return -1;
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
static void ocipp_host_lost(struct ocipp_owner *o) {
  /* Keep the original H stdin OPEN for later original-record management.
   * Host loss is not H EOF, a cleanup request, exit, or a delivery ACK. */
  o->host_lost = 1;
}
static int ocipp_flush_input(struct ocipp_owner *o) {
  if (ocipp_controller(o) < 0 || o->joined || o->wait_unknown || o->identity_unknown || o->reply_unknown) return -1;
  if (!o->pending || (o->host_lost && !o->incoming_sent)) return 0;
  ssize_t n = write(o->input[1], o->incoming + o->incoming_sent, o->incoming_size - o->incoming_sent);
  if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
  if (n <= 0) { ocipp_host_lost(o); o->reply_unknown = 1; return -1; }
  o->incoming_sent += (size_t)n;
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
  o->reply_ready = 1; return 0;
}
static int ocipp_forward(struct ocipp_owner *o, unsigned int which) {
  if (o->host_lost) return 0;
  size_t end = which ? o->used[1] : o->reply_ready ? o->frame_end : o->delivered[0];
  if (o->delivered[which] == end) return 0;
  ssize_t n = write(which ? 2 : 1, o->captured[which] + o->delivered[which], end - o->delivered[which]);
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
    if (ocipp_decode(o->incoming + 4, o->incoming_size - 4, NULL, NULL, 0) < 0) {
      ocipp_host_lost(o); return -1;
    }
    o->pending = 1;
  }
  return 0;
}
static int ocipp_step(struct ocipp_owner *o) {
  if (ocipp_controller(o) < 0) return -1;
  if (ocipp_current(o) < 0) { o->identity_unknown = 1; ocipp_host_lost(o); }
  if (ocipp_interrupted) ocipp_host_lost(o);
  int sending = o->pending && (!o->host_lost || o->incoming_sent) &&
    !o->identity_unknown && !o->joined && !o->wait_unknown && !o->reply_unknown;
  struct pollfd p[4] = {{.fd = o->host_lost || o->joined || o->wait_unknown ? -1 : 0,
      .events = o->pending || o->awaiting ? 0 : POLLIN},
    {.fd = o->eof[0] || o->pipe_unknown[0] ? -1 : o->output[0], .events = POLLIN},
    {.fd = o->eof[1] || o->pipe_unknown[1] ? -1 : o->errors[0], .events = POLLIN},
    {.fd = sending ? o->input[1] : -1, .events = POLLOUT}};
  int n = poll(p, 4, 1000);
  if (n < 0 && errno != EINTR) { o->reply_unknown = 1; ocipp_host_lost(o); }
  if (p[0].revents & (POLLHUP | POLLERR | POLLNVAL)) ocipp_host_lost(o);
  if (p[0].revents & POLLIN) (void)ocipp_read_host(o);
  for (unsigned int i = 0; i < 2; ++i) {
    if (p[i + 1].revents & (POLLERR | POLLNVAL)) o->pipe_unknown[i] = 1;
    else if (p[i + 1].revents & (POLLIN | POLLHUP)) (void)ocipp_drain(o, i);
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
  int prepared = o ? ocipp_prepare(o, body, size) : -1;
  explicit_bzero(body, size); free(body);
  if (prepared < 0) return 77; /* No H has been created or sent any bytes. */
  int spawned = ocipp_spawn(o);
  if (spawned < 0) {
    if (!o->child) return 77;
    o->identity_unknown = 1; ocipp_host_lost(o);
  }
  /* This SAME P stays alive after Host loss AND after a known H exit. Facts and
   * all original output remain private. No listener, new frontend or grant. */
  for (;;) (void)ocipp_step(o);
}
#endif
