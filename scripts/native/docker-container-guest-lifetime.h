#ifndef TAKOS_DOCKER_GUEST_LIFETIME_H
#define TAKOS_DOCKER_GUEST_LIFETIME_H
/* Safety close is monotonic deny in the original held guest namespace. It does
 * not reconnect, install an allow policy, touch a Host bridge or mint a lease.
 * A separate retained child observes controller/channel death, including a
 * controller SIGKILL. It never uses a replacement PID or pathname namespace. */
static bool guest_fail_closed;
static int guest_watch_writer = -1;
static pid_t guest_watch_pid = -1;
static int guest_watch_pidfd = -1;
static bool guest_watch_armed;
enum { GUEST_AUTHORITY_MS = 10000 };
static bool guest_watch_current(void) {
  if (!guest_fail_closed || guest_watch_pid < 0) return true;
  struct pollfd held = {.fd = guest_watch_pidfd, .events = POLLIN};
  return guest_watch_pidfd >= 0 && poll(&held, 1, 0) == 0;
}
static bool guest_watch_arm(void) {
  if (!guest_fail_closed || guest_watch_writer < 0 || !guest_watch_current()) return false;
  if (guest_watch_armed) return true;
  char arm = 'A';
  if (!transfer(guest_watch_writer, &arm, 1, true) || !guest_watch_current()) return false;
  guest_watch_armed = true; return true;
}
/* A successful genuine SQL/currentness read is required by the actual runtime
 * before this private transport heartbeat. It is no tenant authority token. */
static bool guest_watch_keep(void) {
  if (!guest_watch_armed || !guest_watch_current()) return false;
  char beat = 'H'; return transfer(guest_watch_writer, &beat, 1, true) && guest_watch_current();
}
static bool guest_deny_original(void) {
  struct stat actual; struct statfs fs;
  if (guest_netns < 0 || fstat(guest_netns, &actual) || fstatfs(guest_netns, &fs) || fs.f_type != NSFS_MAGIC ||
    actual.st_dev != guest_namespace_stat.st_dev || actual.st_ino != guest_namespace_stat.st_ino ||
    (actual.st_dev == namespace_stat.st_dev && actual.st_ino == namespace_stat.st_ino)) return false;
  char script[256];
  int n = snprintf(script, sizeof(script), "insert rule inet %s output counter name killed drop comment \"guest_lifetime_closed\"\n", table_name);
  if (n < 0 || (size_t)n >= sizeof(script)) return false;
  int in[2]; if (pipe2(in, O_CLOEXEC)) return false;
  pid_t parent = getpid(), child = fork();
  if (child == 0) {
    close(in[1]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent || setns(guest_netns, CLONE_NEWNET) || dup2(in[0], STDIN_FILENO) < 0) _exit(125);
    int null = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (null < 0 || dup2(null, STDOUT_FILENO) < 0 || dup2(null, STDERR_FILENO) < 0) _exit(125);
    char *argv[] = {(char *)nft_binary, "-f", "-", NULL}; clearenv(); execv(nft_binary, argv); _exit(125);
  }
  close(in[0]);
  if (child < 0) { close(in[1]); return false; }
  bool ok = transfer(in[1], script, (size_t)n, true); close(in[1]);
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
static bool guest_watch_start(void) {
  if (!guest_fail_closed) return true;
  char expected[64]; snprintf(expected, sizeof(expected), "takos_cx_%.32s", selected_native_id);
  if (!guest_mode || strcmp(table_name, expected) || !guest_fd_current()) return false;
  if (!current() || !hi_capture(&guest_host_inventory) || !current()) return false;
  host_inventory_held = true; host_inventory_checked = clock_ms();
  if (host_inventory_checked < 0) return false;
  int channel[2]; if (pipe2(channel, O_CLOEXEC | O_NONBLOCK)) return false;
  pid_t child = fork();
  if (child == 0) {
    close(channel[1]);
    /* Do not inherit controller stdio/peer/daemon descriptors. The original
     * guest NSFS FD and this private EOF channel are sufficient for deny. */
    int null = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (null < 0 || dup2(null, STDIN_FILENO) < 0 || dup2(null, STDOUT_FILENO) < 0 || dup2(null, STDERR_FILENO) < 0) _exit(125);
    if (peer >= 0) close(peer);
    if (peer_pidfd >= 0) close(peer_pidfd);
    if (netns >= 0) close(netns);
    if (guest_pidfd >= 0) close(guest_pidfd);
    if (daemon_root >= 0) close(daemon_root);
    bool armed = false; int64_t deadline = -1;
    for (;;) {
      int64_t now = clock_ms();
      if (now < 0 || (armed && now >= deadline)) break;
      struct pollfd event = {.fd = channel[0], .events = POLLIN};
      int ready = poll(&event, 1, armed ? (int)(deadline - now) : -1);
      if (ready < 0 && errno == EINTR) continue;
      if (ready != 1) break;
      char unexpected;
      ssize_t got = read(channel[0], &unexpected, 1);
      if (got < 0 && (errno == EINTR || errno == EAGAIN)) continue;
      now = clock_ms();
      if (now < 0 || (armed && now >= deadline)) break;
      if (got == 1 && unexpected == 'A') { armed = true; deadline = now + GUEST_AUTHORITY_MS; continue; }
      if (got == 1 && unexpected == 'H' && armed) { deadline = now + GUEST_AUTHORITY_MS; continue; }
      break; /* EOF or invalid data closes only an already armed lifetime. */
    }
    close(channel[0]); _exit(!armed || guest_deny_original() ? 0 : 125);
  }
  close(channel[0]);
  if (child < 0) { close(channel[1]); return false; }
  guest_watch_writer = channel[1]; guest_watch_pid = child;
  /* Child cannot be PID-reused while this parent retains it unreaped. */
  guest_watch_pidfd = (int)syscall(SYS_pidfd_open, child, 0);
  if (guest_watch_pidfd < 0 || fcntl(guest_watch_pidfd, F_SETFD, FD_CLOEXEC) < 0) return false;
  return guest_watch_current();
}
static bool guest_watch_join(void) {
  if (guest_watch_writer >= 0) { close(guest_watch_writer); guest_watch_writer = -1; }
  if (guest_watch_pid < 0) return !guest_fail_closed;
  int status = 0;
  /* The owned watchdog has its own bounded native child custody. Join it even
   * after the upstream deadline; never report successful close before closure. */
  pid_t got; do { got = waitpid(guest_watch_pid, &status, 0); } while (got < 0 && errno == EINTR);
  bool ok = got == guest_watch_pid && WIFEXITED(status) && WEXITSTATUS(status) == 0;
  if (guest_watch_pidfd >= 0) close(guest_watch_pidfd);
  /* If the watchdog itself failed while the controller survived, still attempt
   * monotonic deny in the original FD, without claiming a successful close. */
  if (!ok && guest_watch_armed) (void)guest_deny_original();
  return ok;
}
#endif
