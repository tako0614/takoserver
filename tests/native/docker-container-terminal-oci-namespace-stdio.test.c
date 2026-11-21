#define _GNU_SOURCE
/* New wire tests reuse the immutable original raw syscall boundary, including
 * BOTH actual namespace and OCI producer bodies. Neither old main runs.
 * Plain DTOs below exercise only the codec, never dispatch success. */
int namespace_wire_previous_release_main_never_run(void);
#define main namespace_wire_previous_release_main_never_run
#include "docker-container-terminal-oci-namespace-release.test.c"
#undef main
#include <inttypes.h>
#include <sys/socket.h>

static int wire_poll(struct pollfd *p, nfds_t count, int timeout);
static ssize_t wire_write(int fd, const void *bytes, size_t size);
static ssize_t wire_read(int fd, void *bytes, size_t size);
static int wire_clock_gettime(clockid_t clock, struct timespec *out);
int namespace_wire_actual_main_never_run(int argc, char **argv);
#define main namespace_wire_actual_main_never_run
#define poll wire_poll
#define write wire_write
#define read wire_read
#define clock_gettime wire_clock_gettime
#include "../../scripts/native/docker-container-terminal-oci-stdio.c"
#undef main
#undef poll
#undef write
#undef read
#undef clock_gettime

static struct {
  unsigned char output[4096], input[4096];
  size_t output_size, input_size, input_at, chunk, fail_at;
  unsigned int writes, reads, polls, clocks;
  int fail_write, cancel_on_clock;
} wire;

static void wire_reset(void) {
  memset(&wire, 0, sizeof(wire)); interrupted = 0;
}
static int wire_poll(struct pollfd *p, nfds_t count, int timeout) {
  CHECK(count == 1 && (timeout == -1 || timeout > 0)); wire.polls++;
  CHECK((p->fd == 0 && p->events == POLLIN) || (p->fd == 1 && p->events == POLLOUT));
  p->revents = p->fd ? POLLOUT : POLLIN; return 1;
}
static ssize_t wire_write(int fd, const void *bytes, size_t size) {
  CHECK(fd == 1 && bytes && size); wire.writes++;
  if (wire.fail_write && wire.output_size >= wire.fail_at) { errno = EPIPE; return -1; }
  size_t n = size;
  if (wire.chunk && n > wire.chunk) n = wire.chunk;
  if (wire.fail_write && n > wire.fail_at - wire.output_size) n = wire.fail_at - wire.output_size;
  CHECK(n && n <= sizeof(wire.output) - wire.output_size);
  memcpy(wire.output + wire.output_size, bytes, n); wire.output_size += n; return (ssize_t)n;
}
static ssize_t wire_read(int fd, void *bytes, size_t size) {
  CHECK(fd == 0 && bytes && size); wire.reads++;
  size_t n = wire.input_size - wire.input_at;
  if (n > size) n = size;
  if (wire.chunk && n > wire.chunk) n = wire.chunk;
  memcpy(bytes, wire.input + wire.input_at, n); wire.input_at += n; return (ssize_t)n;
}
static int wire_clock_gettime(clockid_t clock, struct timespec *out) {
  CHECK(clock == CLOCK_MONOTONIC && out); wire.clocks++;
  *out = (struct timespec){.tv_sec = 1};
  if (wire.cancel_on_clock) { interrupted = 1; tns_oci_note_cancel(); }
  return 0;
}
static const char *frame_body(void) {
  CHECK(wire.output_size >= 4); uint32_t n = 0;
  CHECK(tns_ocip_frame(wire.output, &n) == 0 && n == wire.output_size - 4);
  CHECK(wire.output_size < sizeof(wire.output)); wire.output[wire.output_size] = 0;
  return (const char *)wire.output + 4;
}
static void expect_snapshot(enum tns_ocip_kind kind, int released, int gone, int poisoned) {
  const char *literal = kind == TNS_OCIP_RELEASE_NAMESPACE ? "linux-oci-namespace-release-observation@1" :
    kind == TNS_OCIP_CONTINUE_NAMESPACE_RELEASE ? "linux-oci-namespace-release-continuation@1" :
    "linux-oci-namespace-lifetime-observation@1";
  char expected[1024], id[65]; memset(id, 'a', 64); id[64] = 0;
  int n = snprintf(expected, sizeof(expected),
    "{\"kind\":\"%s\",\"nativeId\":\"%s\",\"namespaceDevice\":5,\"namespaceInode\":77,"
    "\"netCookie\":\"777\",\"fullIpSockets\":\"11\",\"requests\":\"12\",\"timewait\":\"13\","
    "\"packetGroups\":\"14\",\"born\":1,\"releaseAttempted\":%d,\"referenceReleased\":%d,"
    "\"netGone\":%d,\"poisoned\":%d,\"barrier\":\"unproven\"}", literal, id,
    released, released, gone, poisoned);
  CHECK(n > 0 && (size_t)n < sizeof(expected)); CHECK(!strcmp(frame_body(), expected));
}
static void expect_retained_error(const char *stage, int error, struct tns_oci_owner *o) {
  CHECK(ocip_error("linux-oci-refused@1", stage, error, o) == 0);
  char expected[256]; int n = snprintf(expected, sizeof(expected),
    "{\"kind\":\"linux-oci-refused@1\",\"stage\":\"%s\",\"errno\":%d,\"custody\":\"retained\",\"barrier\":\"unproven\"}",
    stage, error);
  CHECK(n > 0 && (size_t)n < sizeof(expected)); CHECK(!strcmp(frame_body(), expected));
}

static int decode(const char *body, size_t size, enum tns_ocip_kind *kind) {
  unsigned char *copy = calloc(1, size + 1);
  struct tns_ocip_request *request = calloc(1, sizeof(*request)); CHECK(copy && request);
  memcpy(copy, body, size); int result = tns_ocip_decode(copy, size, request);
  *kind = request->kind; free(copy); free(request); return result;
}
static void request_cases(void) {
  const char *literal[] = {"linux-oci-release-namespace@1", "linux-oci-continue-namespace-release@1",
    "linux-oci-observe-namespace-lifetime@1"};
  const enum tns_ocip_kind kinds[] = {TNS_OCIP_RELEASE_NAMESPACE, TNS_OCIP_CONTINUE_NAMESPACE_RELEASE,
    TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME};
  for (size_t i = 0; i < 3; i++) {
    char body[512]; enum tns_ocip_kind kind = 0;
    int n = snprintf(body, sizeof(body), "{\"kind\":\"%s\"}", literal[i]); CHECK(n > 0);
    CHECK(decode(body, (size_t)n, &kind) == 0 && kind == kinds[i]);
    for (size_t short_size = 0; short_size < (size_t)n; short_size++) CHECK(decode(body, short_size, &kind) < 0);
    wire_reset(); wire.chunk = 1; uint32_t size = (uint32_t)n;
    wire.input[0] = (unsigned char)(size >> 24); wire.input[1] = (unsigned char)(size >> 16);
    wire.input[2] = (unsigned char)(size >> 8); wire.input[3] = (unsigned char)size;
    memcpy(wire.input + 4, body, size); wire.input_size = (size_t)size + 4;
    unsigned char *actual = NULL; uint32_t actual_size = 0;
    CHECK(ocip_read(&actual, &actual_size) == 0 && actual_size == size);
    CHECK(decode((char *)actual, actual_size, &kind) == 0 && kind == kinds[i]); free(actual);
    n = snprintf(body, sizeof(body), "{\"kind\":\"%s\",\"nativeId\":\"a\"}", literal[i]); CHECK(n > 0);
    CHECK(decode(body, (size_t)n, &kind) < 0);
    n = snprintf(body, sizeof(body), "{\"kind\":\"%s\",\"kind\":\"%s\"}", literal[i], literal[i]); CHECK(n > 0);
    CHECK(decode(body, (size_t)n, &kind) < 0);
    n = snprintf(body, sizeof(body), "{\"kind\":\"%s\"}{}", literal[i]); CHECK(n > 0);
    CHECK(decode(body, (size_t)n, &kind) < 0);
    n = snprintf(body, sizeof(body), "{\"kind\":\"%sX\"}", literal[i]); CHECK(n > 0);
    CHECK(decode(body, (size_t)n, &kind) < 0);
  }
  CHECK(TNS_OCIP_CREATE == 1 && TNS_OCIP_OBSERVE == 2 && TNS_OCIP_CANCEL == 3 &&
    TNS_OCIP_START == 4 && TNS_OCIP_OBSERVE_STARTED == 5 && TNS_OCIP_STOP_INIT == 6 && TNS_OCIP_JOIN_INIT == 7);
}

static void codec_cases(void) {
  /* Serialization data only: these structs never feed actual dispatch. */
  struct tns_oci_namespace_lifetime o = {0}; memset(o.native_id, 'a', 64);
  o.lifetime.identity = (struct tns_identity){.device = 1, .inode = 9007199254740991};
  o.lifetime.net_cookie = UINT64_MAX; o.lifetime.born = 1;
  o.lifetime.full_ip_sockets = UINT64_MAX; o.lifetime.requests = UINT64_MAX - 1;
  o.lifetime.timewait = 0; o.lifetime.packet_groups = 1;
  char bytes[1024];
  CHECK(ocip_namespace_encode(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, &o, bytes, sizeof(bytes)) == 0);
  CHECK(strstr(bytes, "\"namespaceInode\":9007199254740991,\"netCookie\":\"18446744073709551615\"") != NULL);
  CHECK(strstr(bytes, "\"fullIpSockets\":\"18446744073709551615\",\"requests\":\"18446744073709551614\",\"timewait\":\"0\",\"packetGroups\":\"1\"") != NULL);
  size_t n = strlen(bytes);
  for (size_t size = 0; size <= n; size++) CHECK(ocip_namespace_encode(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, &o, bytes, size) < 0);
  CHECK(ocip_namespace_encode(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, &o, bytes, n + 1) == 0);
  for (int field = 0; field < 12; field++) {
    struct tns_oci_namespace_lifetime bad = o;
    switch (field) {
      case 0: bad.native_id[0] = 'A'; break;
      case 1: bad.native_id[64] = 'x'; break;
      case 2: bad.lifetime.identity.device = 0; break;
      case 3: bad.lifetime.identity.inode = 9007199254740992; break;
      case 4: bad.lifetime.net_cookie = 0; break;
      case 5: bad.lifetime.born = 0; break;
      case 6: bad.lifetime.release_attempted = 2; break;
      case 7: bad.lifetime.reference_released = 2; break;
      case 8: bad.lifetime.net_gone = 2; break;
      case 9: bad.lifetime.poisoned = 2; break;
      case 10: bad.lifetime.reference_released = 1; break;
      default: bad.lifetime.net_gone = 1; break;
    }
    CHECK(ocip_namespace_encode(TNS_OCIP_RELEASE_NAMESPACE, &bad, bytes, sizeof(bytes)) < 0);
  }
  CHECK(ocip_namespace_encode(TNS_OCIP_START, &o, bytes, sizeof(bytes)) < 0);
  CHECK(ocip_namespace_encode(TNS_OCIP_RELEASE_NAMESPACE, NULL, bytes, sizeof(bytes)) < 0);
}

static void actual_dispatch_cases(void) {
  struct tns_oci_owner o; struct tns_owner b; struct ocip_namespace_state state;
  initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0}; wire.chunk = 3;
  CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == 0);
  expect_snapshot(TNS_OCIP_RELEASE_NAMESPACE, 1, 0, 0);
  CHECK(state.entered && state.release_requested && !state.unusable);
  CHECK(model.kernel_releases == 1 && model.custodian_signals == 1 && model.custodian_reaps == 1);
  retained(&o, &b);
  wire_reset(); CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -1 && errno == EALREADY);
  CHECK(!wire.output_size && model.kernel_releases == 1 && model.custodian_signals == 1);
  CHECK(ocip_namespace_retained_error(&state, "release-namespace") == 1);
  expect_retained_error("release-namespace", EALREADY, &o);
  wire_reset(); model.net_gone = model.poisoned = 1;
  CHECK(ocip_namespace_command(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, &o, &state) == 0);
  expect_snapshot(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, 1, 1, 1);
  CHECK(model.kernel_releases == 1 && model.custodian_signals == 1); retained(&o, &b);

  initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0}; model.fault = CUSTODIAN_TIMEOUT;
  CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -1 && errno == ETIMEDOUT);
  CHECK(!wire.output_size && model.custodian_signals == 1 && !model.custodian_reaps && !model.kernel_releases);
  CHECK(ocip_namespace_retained_error(&state, "release-namespace") == 1);
  expect_retained_error("release-namespace", ETIMEDOUT, &o);
  CHECK(!model.custodian_reaps && b.child == 2000); /* Refusal ACK never joins. */
  wire_reset(); model.fault = NONE;
  CHECK(ocip_namespace_command(TNS_OCIP_CONTINUE_NAMESPACE_RELEASE, &o, &state) == 0);
  expect_snapshot(TNS_OCIP_CONTINUE_NAMESPACE_RELEASE, 1, 0, 0);
  CHECK(model.custodian_signals == 1 && model.custodian_reaps == 1 && model.kernel_releases == 1);
  retained(&o, &b);

  for (enum fault fault = RELEASE_LOST_EFFECT; fault <= RELEASE_LOST_NO_EFFECT; fault++) {
    initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0}; model.fault = fault;
    CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -1 && errno == EINTR);
    CHECK(!wire.output_size && model.kernel_releases == 1);
    CHECK(ocip_namespace_retained_error(&state, "release-namespace") == 1);
    expect_retained_error("release-namespace", EINTR, &o);
    wire_reset(); model.fault = NONE;
    CHECK(ocip_namespace_command(TNS_OCIP_CONTINUE_NAMESPACE_RELEASE, &o, &state) == -1 && errno == EALREADY);
    CHECK(!wire.output_size && model.kernel_releases == 1 && model.custodian_signals == 1);
    CHECK(ocip_namespace_command(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, &o, &state) == 0);
    expect_snapshot(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, fault == RELEASE_LOST_EFFECT, 0, 0);
    retained(&o, &b);
  }
  for (enum fault fault = LOAN_CLOSE_ERROR; fault <= BIRTH_CLOSE_ERROR; fault++) {
    initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0}; model.fault = fault;
    CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -1 && errno == EINTR);
    CHECK(!wire.output_size); model.fault = NONE;
    CHECK(ocip_namespace_command(TNS_OCIP_CONTINUE_NAMESPACE_RELEASE, &o, &state) == -1 && errno == EUCLEAN);
    CHECK(!wire.output_size && model.kernel_releases == 1 && model.loan_closes == 1 && model.birth_closes == 1);
    CHECK(o.namespace_loan_close_unknown || b.namespace_close_unknown);
    CHECK(ocip_namespace_retained_error(&state, "continue-namespace-release") == 1);
    expect_retained_error("continue-namespace-release", EUCLEAN, &o);
    wire_reset(); CHECK(ocip_namespace_command(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, &o, &state) == 0);
    expect_snapshot(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, 1, 0, 0);
    CHECK(o.namespace_loan_close_unknown || b.namespace_close_unknown); retained(&o, &b);
  }
  for (enum fault fault = LIFETIME_READ_ERROR; fault <= GONE_WITHOUT_ATTEMPT; fault++) {
    initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0}; model.fault = fault;
    CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -1 && !wire.output_size);
    CHECK(ocip_namespace_retained_error(&state, "release-namespace") == 1);
    CHECK(!model.kernel_releases && !model.custodian_signals); retained(&o, &b);
  }
}

static void refusal_and_lost_wire_cases(void) {
  struct tns_oci_owner o; struct tns_owner b; struct ocip_namespace_state state;
  initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0}; o.init_joined = 0;
  CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -1 && !wire.output_size);
  CHECK(!model.loan_closes && !model.custodian_signals && !model.kernel_releases);
  initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0};
  CHECK(ocip_namespace_command(TNS_OCIP_CONTINUE_NAMESPACE_RELEASE, &o, &state) == -3 && state.unusable);
  CHECK(!wire.output_size && !model.kernel_releases && !o.namespace_release_attempt);
  CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -3 && !o.namespace_release_attempt);
  state = (struct ocip_namespace_state){0};
  CHECK(ocip_namespace_command(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, &o, &state) == -3 && state.unusable);
  CHECK(!wire.output_size && !model.kernel_releases);
  state = (struct ocip_namespace_state){0};
  CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, NULL, &state) == -3 && !state.entered);
  CHECK(ocip_namespace_command(TNS_OCIP_START, &o, &state) == -3 && !o.namespace_release_attempt);
  CHECK(!ocip_namespace_stage(TNS_OCIP_CANCEL));
  CHECK(!ocip_namespace_retained_error(&state, "request") && state.unusable);
  CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -3 && !model.kernel_releases);
  state = (struct ocip_namespace_state){0};
  CHECK(!ocip_namespace_retained_error(&state, "stop-init") && !state.unusable);
  CHECK(!ocip_namespace_retained_error(&state, "join-init") && !state.unusable);

  for (size_t lost_at = 0; lost_at < 3; lost_at++) {
    initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0};
    wire.fail_write = 1; wire.fail_at = lost_at == 0 ? 0 : lost_at == 1 ? 2 : 12;
    CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -2 && errno == EPIPE);
    CHECK(state.unusable && wire.output_size == wire.fail_at && model.kernel_releases == 1);
    size_t sent = wire.output_size;
    CHECK(ocip_namespace_command(TNS_OCIP_CONTINUE_NAMESPACE_RELEASE, &o, &state) == -3);
    CHECK(ocip_namespace_command(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, &o, &state) == -3);
    CHECK(wire.output_size == sent && model.kernel_releases == 1 && model.custodian_signals == 1);
    CHECK(!ocip_namespace_retained_error(&state, "release-namespace")); retained(&o, &b);
  }
  initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0}; wire.cancel_on_clock = 1;
  CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -2 && errno == ECANCELED);
  CHECK(state.unusable && !wire.output_size && model.kernel_releases == 1);
  CHECK(ocip_namespace_command(TNS_OCIP_OBSERVE_NAMESPACE_LIFETIME, &o, &state) == -3);
  CHECK(!wire.output_size && model.kernel_releases == 1); retained(&o, &b);
  initialize(&o, &b); wire_reset(); state = (struct ocip_namespace_state){0}; interrupted = 1;
  CHECK(ocip_namespace_command(TNS_OCIP_RELEASE_NAMESPACE, &o, &state) == -2 && errno == ECANCELED);
  CHECK(!model.loan_closes && !model.custodian_signals && !model.kernel_releases && !wire.output_size);
  wire_reset();
}

int main(void) {
  request_cases(); codec_cases(); actual_dispatch_cases(); refusal_and_lost_wire_cases();
  printf("new namespace wire codec/actual original producer raw dispatch: %lu checks\n", checks);
  return 0;
}
