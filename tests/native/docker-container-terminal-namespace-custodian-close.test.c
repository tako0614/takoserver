#ifndef CUSTODIAN_CLOSE_RAW_MODEL
#define CUSTODIAN_CLOSE_RAW_MODEL
/* Original constructor/release/JOIN/disposal over the existing closed syscall
 * model. Previous case functions/main compile but are never invoked. */
static int cc_close(int fd);
static void cc_free(void *allocation);
int custodian_close_previous_cohort_never_run(void);
#define NAMESPACE_SOURCE "docker-container-terminal-namespace-custodian-close.test.c"
#define main custodian_close_previous_cohort_never_run
#include "docker-container-terminal-namespace-owner-join.test.c"
#undef main
#undef NAMESPACE_SOURCE

static struct {
  int target, no_effect, error, consumed_before_close;
  unsigned int calls, frees;
} cc;
static void cc_reset(void) { memset(&cc, 0, sizeof(cc)); cc.target = -1; }
static int cc_close(int fd) {
  if (fd != cc.target) return raw_close(fd);
  CHECK(!cc.calls++);
  struct tns_owner *o = original_owner();
  cc.consumed_before_close = fd == STATUS ? o->status < 0 : o->control < 0;
  if (cc.no_effect) { fd_current(fd); m.closes[fd]++; }
  else CHECK(raw_close(fd) == 0);
  errno = cc.error;
  return -1;
}
static void cc_free(void *allocation) {
  CHECK(allocation == *m.slot); cc.frees++; free(allocation);
}
static void cc_teardown(struct tns_owner **slot) {
  /* Memory-only teardown after UNKNOWN assertions, never product recovery. */
  cc.target = -1; m.fault = NONE;
  if (m.tracked_allocation) raw_final_object_free();
  free(*slot); *slot = NULL;
  memset(m.fd_live, 0, sizeof(m.fd_live));
}
static void cc_known(void) {
  struct tns_owner *o; cc_reset(); create_and_loan(&o); released(o);
  CHECK(m.closes[STATUS] == 1 && m.closes[CONTROL] == 1);
  CHECK(tns_owner_stop_custodian(o) == 0 && m.reaps == 1 && m.signals == 1);
  CHECK(tns_owner_begin_tracked_join(o) == 0); raw_final_object_free();
  CHECK(tns_owner_read_tracked_join(o) == 0);
  CHECK(tns_owner_dispose_tracked(&o) == 0 && !o && cc.frees == 1);
  CHECK(m.creates == 1 && m.clones == 1 && m.reaps == 1 && m.releases == 1);
  for (int fd = ROOT; fd < MAX_FD; fd++) CHECK(!m.fd_live[fd]);
}
static void cc_control_error(int no_effect, int error, int reuse) {
  struct tns_owner *o; cc_reset(); create_and_loan(&o);
  CHECK(tns_owner_cut_admission(o) == 0);
  cc.target = CONTROL; cc.no_effect = no_effect; cc.error = error;
  struct tns_lifetime life;
  CHECK(tns_owner_release_namespace(o, &life) < 0 && errno == error);
  CHECK(cc.calls == 1 && cc.consumed_before_close && o->control == -1);
  CHECK(m.reaps == 1 && m.signals == 1 && !m.releases && !m.begin_calls);
  CHECK(o->netfd == BIRTH_NS && !m.closes[BIRTH_NS] && !cc.frees);
  if (reuse) { CHECK(!m.fd_live[CONTROL]); m.fd_live[CONTROL] = 1; }
  CHECK(tns_owner_continue_namespace_release(o, &life) < 0 && errno == EUCLEAN);
  CHECK(tns_owner_stop_custodian(o) < 0 && errno == EUCLEAN);
  CHECK(tns_owner_begin_tracked_join(o) < 0 && errno == EUCLEAN);
  CHECK(tns_owner_dispose_tracked(&o) < 0 && errno == EINVAL);
  errno = 0; /* Released-family guard preserves a preexisting errno. */
  CHECK(tns_owner_dispose_released(&o) < 0 && errno == EUCLEAN);
  CHECK(tns_owner_close(&o) < 0 && errno == EUCLEAN);
  CHECK(o && !cc.frees && cc.calls == 1 && m.closes[CONTROL] == 1);
  CHECK(m.fd_live[CONTROL] == (unsigned int)(no_effect || reuse));
  CHECK(m.reaps == 1 && m.signals == 1 && !m.releases && !m.begin_calls && !m.read_calls);
  CHECK(m.creates == 1 && m.clones == 1); cc_teardown(&o);
}
static void cc_status_error(int no_effect, int error, int reuse) {
  struct tns_owner *o; cc_reset(); reset(&o);
  cc.target = STATUS; cc.no_effect = no_effect; cc.error = error;
  CHECK(tns_owner_create(&o) < 0 && errno == error);
  CHECK(o && o->status == -1 && cc.calls == 1 && cc.consumed_before_close);
  CHECK(m.reaps == 1 && m.signals == 1 && !m.releases && !cc.frees);
  if (reuse) { CHECK(!m.fd_live[STATUS]); m.fd_live[STATUS] = 1; }
  CHECK(tns_owner_create(&o) < 0 && errno == EALREADY);
  CHECK(tns_owner_close(&o) < 0 && errno == EUCLEAN && o && !cc.frees);
  CHECK(m.fd_live[STATUS] == (unsigned int)(no_effect || reuse));
  CHECK(cc.calls == 1 && m.closes[STATUS] == 1 && m.closes[CONTROL] == 1);
  CHECK(m.reaps == 1 && m.signals == 1 && m.creates == 1 && m.clones == 1);
  cc_teardown(&o);
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--control")) cc_control_error(0, EINTR, 0);
  else if (argc == 2 && !strcmp(argv[1], "--status")) cc_status_error(0, EIO, 0);
  else if (argc == 2 && !strcmp(argv[1], "--known")) cc_known();
  else {
    CHECK(argc == 1 || (argc == 2 && !strcmp(argv[1], "--errors")));
    if (argc == 1) cc_known();
    const int errors[] = {EINTR, EIO};
    for (size_t i = 0; i < sizeof(errors) / sizeof(errors[0]); i++)
      for (int effect = 0; effect < 2; effect++)
        for (int reuse = 0; reuse <= effect; reuse++) {
          cc_control_error(!effect, errors[i], reuse);
          cc_status_error(!effect, errors[i], reuse);
        }
  }
  printf("PASS %u actual custodian-close syscall-model checks; old cases0/native effects0\n", checks);
  return 0;
}
#else
#undef close
#define close cc_close
#define free cc_free
#include "../../scripts/native/docker-container-terminal-namespace.c"
#undef free
#undef close
#define close raw_close
#endif
