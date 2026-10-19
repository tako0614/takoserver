#ifndef TAKOS_DOCKER_GUEST_RESUME_H
#define TAKOS_DOCKER_GUEST_RESUME_H
/* Resume removes only actual observed unconditional owned-deny prefix rules.
 * It cannot reset quota/counters, alter policy, create tables, START or connect.
 * Caller retains genuine fresh reconcile authority and verifies the full table;
 * this independent native selector never accepts caller-provided handles. */
static bool guest_resume_attempted;
static bool gr_keys(const di_parser *p, int object, const char *const keys[], unsigned count) {
  if (object < 0 || p->nodes[object].kind != '{') return false;
  unsigned actual = 0;
  for (int key = p->nodes[object].child; key >= 0 && key < p->nodes[object].next;) {
    bool found = false;
    for (unsigned i = 0; i < count; i++) if (di_key(p, key, keys[i])) found = true;
    if (!found) return false;
    actual++; key = p->nodes[p->nodes[key].next].next;
  }
  if (actual != count) return false;
  for (unsigned i = 0; i < count; i++) if (di_field(p, object, keys[i]) < 0) return false;
  return true;
}
static bool gr_drop(const di_parser *p, int expr) {
  if (expr < 0 || p->nodes[expr].kind != '[' || p->nodes[expr].child < 0) return false;
  int counter = p->nodes[expr].child, drop = p->nodes[counter].next;
  const char *const counter_keys[] = {"counter"}, *const drop_keys[] = {"drop"};
  return drop < p->nodes[expr].next && p->nodes[drop].next == p->nodes[expr].next &&
    gr_keys(p, counter, counter_keys, 1) && di_equal_text(p, di_field(p, counter, "counter"), "killed") &&
    gr_keys(p, drop, drop_keys, 1) && p->nodes[di_field(p, drop, "drop")].kind == 'n';
}
static bool gr_handle(const di_parser *p, int index, unsigned long long *value) {
  if (index < 0 || p->nodes[index].kind != 'd') return false;
  const di_node *node = &p->nodes[index];
  unsigned long long n = 0;
  for (size_t i = node->start; i < node->end; i++) {
    unsigned char c = p->s[i];
    if (c < '0' || c > '9' || n > 9007199254740991ULL / 10) return false;
    n = n * 10 + c - '0'; if (n > 9007199254740991ULL) return false;
  }
  if (!n) return false;
  *value = n;
  return true;
}
static bool gr_select(const unsigned char *body, size_t size, unsigned long long handles[8], unsigned *count) {
  di_node *nodes = calloc(DI_TOKENS, sizeof(*nodes)); if (!nodes) return false;
  di_parser p = {.s = body, .size = size, .nodes = nodes, .until = di_clock() + 500};
  int root = di_value(&p, 0); di_space(&p); bool ok = false, normal = false; *count = 0;
  const char *const root_keys[] = {"nftables"}, *const rule_keys[] = {"family", "table", "chain", "expr", "comment", "handle"};
  if (root != 0 || p.at != size || !gr_keys(&p, 0, root_keys, 1)) goto finish;
  int list = di_field(&p, 0, "nftables"); if (nodes[list].kind != '[') goto finish;
  for (int item = nodes[list].child; item >= 0 && item < nodes[list].next; item = nodes[item].next) {
    int rule = di_field(&p, item, "rule");
    if (rule == -2) goto finish;
    if (rule < 0) continue;
    bool owned = di_equal_text(&p, di_field(&p, rule, "comment"), "guest_lifetime_closed");
    bool output = di_equal_text(&p, di_field(&p, rule, "family"), "inet") &&
      di_equal_text(&p, di_field(&p, rule, "table"), table_name) && di_equal_text(&p, di_field(&p, rule, "chain"), "output");
    if (owned) {
      const char *const object_keys[] = {"rule"};
      if (!output || normal || *count >= 8 || !gr_keys(&p, item, object_keys, 1) ||
        !gr_keys(&p, rule, rule_keys, 6) || !gr_drop(&p, di_field(&p, rule, "expr")) ||
        !gr_handle(&p, di_field(&p, rule, "handle"), &handles[*count])) goto finish;
      for (unsigned i = 0; i < *count; i++) if (handles[i] == handles[*count]) goto finish;
      (*count)++;
    } else if (output) normal = true;
  }
  ok = *count > 0 && normal && di_live(&p);
finish:
  free(nodes); return ok;
}
static bool guest_resume(void) {
  if (!guest_mode || !guest_fail_closed || guest_watch_armed || guest_resume_attempted || !selected_current())
    return refusal("guest_resume_refused");
  char *read_argv[] = {(char *)nft_binary, "-j", "-a", "list", "table", "inet", table_name, NULL};
  unsigned char *data = NULL; size_t used = 0; unsigned long long handles[8]; unsigned count = 0;
  bool ok = capture_native(read_argv, NULL, 0, &data, &used) && gr_select(data, used, handles, &count);
  free(data);
  if (!ok || !selected_current()) return refusal("guest_resume_refused");
  char script[1536]; size_t length = 0;
  for (unsigned i = 0; i < count; i++) {
    int n = snprintf(script + length, sizeof(script) - length, "delete rule inet %s output handle %llu\n", table_name, handles[i]);
    if (n < 0 || (size_t)n >= sizeof(script) - length) return refusal("guest_resume_refused");
    length += (size_t)n;
  }
  /* Arm BEFORE removing deny. A lost ACK/controller/channel causes deny again;
   * no uncertain outcome can expose an unmonitored allow policy. */
  if (!guest_watch_arm() || !selected_current()) return refusal("guest_lifetime_unavailable");
  guest_resume_attempted = true;
  char *write_argv[] = {(char *)nft_binary, "-f", "-", NULL}; data = NULL; used = 0;
  ok = capture_native(write_argv, script, length, &data, &used); free(data);
  return ok && selected_current() ? reply(0, "{}", 2) : refusal("guest_resume_outcome_unknown");
}
#endif
