/* Reuse the immutable closed raw syscall models and BOTH actual production
 * bodies. The previous release cohort/main is compiled but NEVER called.
 * Close-call counters are attempt facts; sticky unknown is not proof of close. */
int namespace_release_previous_cohort_never_run(void);
#define main namespace_release_previous_cohort_never_run
#include "docker-container-terminal-oci-namespace-release.test.c"
#undef main

static void unchanged_by_read(struct tns_oci_owner *o, struct tns_owner *b) {
  unsigned int signals = model.custodian_signals, reaps = model.custodian_reaps;
  unsigned int releases = model.kernel_releases, loans = model.loan_closes, ns = model.birth_closes;
  pid_t child = b->child;
  int dispatched = o->namespace_release_dispatched;
  int attempt = b->namespace_release_attempted, sent = b->kernel_release_attempted;
  int loan_unknown = o->namespace_loan_close_unknown, birth_unknown = b->namespace_close_unknown;
  struct tns_oci_namespace_lifetime observed;
  CHECK(tns_oci_observe_namespace_lifetime(o, &observed) == 0);
  CHECK(model.custodian_signals == signals && model.custodian_reaps == reaps);
  CHECK(model.kernel_releases == releases && model.loan_closes == loans && model.birth_closes == ns);
  CHECK(b->child == child && o->namespace_release_dispatched == dispatched);
  CHECK(b->namespace_release_attempted == attempt && b->kernel_release_attempted == sent);
  CHECK(o->namespace_loan_close_unknown == loan_unknown && b->namespace_close_unknown == birth_unknown);
}
static void joined_continuation_cases(void) {
  const enum fault faults[] = {CUSTODIAN_TIMEOUT, CUSTODIAN_INTERRUPT};
  for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
    struct tns_oci_owner o; struct tns_owner b; struct tns_oci_namespace_lifetime out;
    initialize(&o, &b); model.fault = faults[i];
    CHECK(tns_oci_release_namespace(&o, &out) < 0);
    CHECK(o.namespace_release_dispatched && b.namespace_release_attempted && b.kill_attempted);
    CHECK(b.child == 2000 && model.custodian_signals == 1 && !model.custodian_reaps);
    CHECK(o.network == -1 && b.netfd == BIRTH_NS && !b.kernel_release_attempted);
    model.fault = NONE;
    unchanged_by_read(&o, &b); /* Read ACK cannot join or authorize the next phase. */
    CHECK(tns_oci_continue_namespace_release(&o, &out) == 0);
    CHECK(model.custodian_signals == 1 && model.custodian_reaps == 1 && !b.child);
    CHECK(model.loan_closes == 1 && model.birth_closes == 1 && model.kernel_releases == 1);
    CHECK(out.lifetime.reference_released == 1 && !out.lifetime.net_gone);
    CHECK(tns_oci_continue_namespace_release(&o, &out) < 0 && errno == EALREADY);
    CHECK(model.kernel_releases == 1 && model.custodian_signals == 1);
    retained(&o, &b);
  }
}
static void close_unknown_cases(void) {
  const enum fault faults[] = {LOAN_CLOSE_ERROR, BIRTH_CLOSE_ERROR};
  for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
    struct tns_oci_owner o; struct tns_owner b; struct tns_oci_namespace_lifetime out;
    initialize(&o, &b); model.fault = faults[i];
    CHECK(tns_oci_release_namespace(&o, &out) < 0 && errno == EINTR);
    CHECK(o.network == -1 && model.loan_closes == 1 && !model.kernel_releases);
    CHECK(faults[i] == LOAN_CLOSE_ERROR ? o.namespace_loan_close_unknown : b.namespace_close_unknown);
    if (faults[i] == LOAN_CLOSE_ERROR) CHECK(!o.namespace_release_dispatched && !b.namespace_release_attempted);
    else CHECK(o.namespace_release_dispatched && !b.child && b.netfd == -1 && model.birth_closes == 1);
    model.fault = NONE;
    unchanged_by_read(&o, &b);
    memset(&out, 0xa5, sizeof(out)); unsigned char sentinel[sizeof(out)]; memcpy(sentinel, &out, sizeof(out));
    CHECK(tns_oci_continue_namespace_release(&o, &out) < 0 && errno == EUCLEAN);
    CHECK(!memcmp(&out, sentinel, sizeof(out))); /* Later ACK is not whole-release success. */
    CHECK(model.kernel_releases == 1 && model.reference_released);
    CHECK(model.loan_closes == 1 && model.birth_closes == 1 && model.custodian_signals == 1);
    CHECK(o.namespace_loan_close_unknown || b.namespace_close_unknown);
    unchanged_by_read(&o, &b); /* Actual later lifetime may be read, uncertainty stays. */
    CHECK(tns_oci_continue_namespace_release(&o, &out) < 0 && errno == EALREADY);
    CHECK(o.namespace_loan_close_unknown || b.namespace_close_unknown);
    CHECK(model.kernel_releases == 1 && model.loan_closes == 1 && model.birth_closes == 1);
    retained(&o, &b);
  }
}
static void sent_unknown_cases(void) {
  const enum fault faults[] = {RELEASE_LOST_EFFECT, RELEASE_LOST_NO_EFFECT, RELEASE_POSITIVE, LATE_CONFIG};
  for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
    struct tns_oci_owner o; struct tns_owner b; struct tns_oci_namespace_lifetime out;
    initialize(&o, &b); model.fault = faults[i];
    CHECK(tns_oci_release_namespace(&o, &out) < 0);
    CHECK(b.kernel_release_attempted && model.kernel_releases == 1);
    CHECK(!b.child && o.network == -1 && b.netfd == -1);
    model.fault = NONE;
    unchanged_by_read(&o, &b);
    memset(&out, 0xa5, sizeof(out)); unsigned char sentinel[sizeof(out)]; memcpy(sentinel, &out, sizeof(out));
    CHECK(tns_oci_continue_namespace_release(&o, &out) < 0 && errno == EALREADY);
    CHECK(!memcmp(&out, sentinel, sizeof(out)) && model.kernel_releases == 1);
    CHECK(model.custodian_signals == 1 && model.custodian_reaps == 1);
    retained(&o, &b);
  }
}
static void original_phase_cases(void) {
  struct tns_oci_owner o; struct tns_owner b; struct tns_oci_namespace_lifetime out;
  initialize(&o, &b);
  CHECK(tns_oci_continue_namespace_release(&o, &out) < 0 && errno == EINVAL);
  struct tns_lifetime observed;
  CHECK(tns_owner_observe_lifetime(&b, &observed) == 0);
  CHECK(!o.namespace_release_attempt && !b.namespace_release_attempted);
  CHECK(tns_owner_continue_namespace_release(&b, &observed) < 0 && errno == EINVAL);
  CHECK(!model.custodian_signals && !model.loan_closes && !model.kernel_releases);

  initialize(&o, &b); model.fault = LIFETIME_READ_ERROR;
  CHECK(tns_oci_release_namespace(&o, &out) < 0);
  CHECK(!o.namespace_release_dispatched && !b.namespace_release_attempted && o.network == LOAN);
  CHECK(!model.loan_closes && !model.custodian_signals && !model.kernel_releases);
  model.fault = NONE;
  unchanged_by_read(&o, &b);
  CHECK(tns_oci_continue_namespace_release(&o, &out) == 0);
  CHECK(o.namespace_release_dispatched && model.kernel_releases == 1 && model.custodian_signals == 1);

  initialize(&o, &b); model.fault = CUSTODIAN_SIGNAL;
  CHECK(tns_oci_release_namespace(&o, &out) < 0 && b.kill_attempted);
  CHECK(model.custodian_signals == 1 && !model.custodian_exited && b.child == 2000);
  model.fault = NONE;
  CHECK(tns_oci_continue_namespace_release(&o, &out) < 0 && errno == ETIMEDOUT);
  CHECK(model.custodian_signals == 1 && !model.custodian_reaps && !model.kernel_releases);
  model.custodian_exited = 1; /* Next kernel boundary reports this same child's exit. */
  CHECK(tns_oci_continue_namespace_release(&o, &out) == 0);
  CHECK(model.custodian_signals == 1 && model.custodian_reaps == 1 && model.kernel_releases == 1);

  initialize(&o, &b); model.fault = CUSTODIAN_WRONG_PID;
  CHECK(tns_oci_release_namespace(&o, &out) < 0 && b.child == 2000 && model.custodian_reaps == 1);
  model.fault = CUSTODIAN_ECHILD;
  CHECK(tns_oci_continue_namespace_release(&o, &out) < 0 && errno == ECHILD);
  CHECK(b.child == 2000 && !b.kernel_release_attempted && !model.kernel_releases && model.custodian_signals == 1);
  unchanged_by_read(&o, &b); /* ECHILD/read ACK never fabricate a matched reap. */
}
int main(void) {
  joined_continuation_cases(); close_unknown_cases(); sent_unknown_cases(); original_phase_cases();
  printf("actual same-owner namespace release continuation raw model: %lu checks\n", checks);
  return 0;
}
