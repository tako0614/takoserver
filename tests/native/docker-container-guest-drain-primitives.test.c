#define _GNU_SOURCE
#include <arpa/inet.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define TAKOS_DRAIN_PARSER_ONLY
#include "../../scripts/native/docker-container-guest-drain.h"

/* Byte parsers, fixed script construction and the actual local one-use
 * primitive only. Native execution is excluded from this translation unit. */
static unsigned checks;
#define CHECK(x) do { checks++; if (!(x)) { fprintf(stderr, "line %u: %s\n", __LINE__, #x); return 1; } } while (0)
typedef struct { unsigned char bytes[128]; size_t size; } fixture;
static void attr(fixture *f, uint16_t type, uint32_t value) {
  struct nlattr h = {.nla_type = type, .nla_len = sizeof(h) + sizeof(value)};
  memcpy(f->bytes + f->size, &h, sizeof(h)); f->size += sizeof(h);
  value = htonl(value); memcpy(f->bytes + f->size, &value, sizeof(value)); f->size += sizeof(value);
}
static fixture stats(uint32_t entries, uint32_t maximum, bool reverse) {
  fixture f = {0}; struct nlmsghdr h = {
    .nlmsg_type = (NFNL_SUBSYS_CTNETLINK << 8) | IPCTNL_MSG_CT_GET_STATS,
    .nlmsg_flags = NLM_F_MULTI, .nlmsg_seq = 3, .nlmsg_pid = 123};
  struct nfgenmsg gen = {.nfgen_family = AF_UNSPEC};
  memcpy(f.bytes, &h, sizeof(h)); f.size += sizeof(h);
  memcpy(f.bytes + f.size, &gen, sizeof(gen)); f.size += sizeof(gen);
  attr(&f, reverse ? CTA_STATS_GLOBAL_MAX_ENTRIES : CTA_STATS_GLOBAL_ENTRIES, reverse ? maximum : entries);
  attr(&f, reverse ? CTA_STATS_GLOBAL_ENTRIES : CTA_STATS_GLOBAL_MAX_ENTRIES, reverse ? entries : maximum);
  h.nlmsg_len = (uint32_t)f.size; memcpy(f.bytes, &h, sizeof(h)); return f;
}
static gd_stats fresh(void) { return (gd_stats){.allocated = 0xdead, .maximum = 0xbeef}; }
static bool feed(gd_stats *s, const fixture *f) { return gd_stats_feed(s, f->bytes, f->size, false, 0, 0, 3, 123); }
static bool refused(const fixture *f) {
  gd_stats s = fresh(); return !feed(&s, f) && s.failed && !s.done && s.allocated == 0xdead && s.maximum == 0xbeef;
}
static void u32(fixture *f, size_t at, uint32_t value) { memcpy(f->bytes + at, &value, sizeof(value)); }
static void u16(fixture *f, size_t at, uint16_t value) { memcpy(f->bytes + at, &value, sizeof(value)); }
int main(void) {
  fixture f = stats(0, 65536, false); gd_stats s = fresh();
  CHECK(feed(&s, &f) && s.done && !s.failed && s.allocated == 0 && s.maximum == 65536);
  CHECK(!feed(&s, &f) && s.failed); /* A result cannot be appended/replayed. */
  f = stats(17, UINT32_MAX, true); s = fresh(); CHECK(feed(&s, &f) && s.allocated == 17 && s.maximum == UINT32_MAX);
  f = stats(UINT32_MAX, 0, false); s = fresh(); CHECK(feed(&s, &f) && s.allocated == UINT32_MAX && s.maximum == 0);
  /* Counts are raw observations; maximum is not a capacity/readiness grant. */
  f = stats(1234, 1, false); s = fresh(); CHECK(feed(&s, &f) && s.allocated == 1234 && s.maximum == 1);
  for (size_t i = 0; i < f.size; i++) { fixture cut = f; cut.size = i; CHECK(refused(&cut)); }
  s = fresh(); CHECK(!gd_stats_feed(&s, f.bytes, f.size, true, 0, 0, 3, 123) && s.failed && s.allocated == 0xdead);
  s = fresh(); CHECK(!gd_stats_feed(&s, f.bytes, f.size, false, 1, 0, 3, 123));
  s = fresh(); CHECK(!gd_stats_feed(&s, f.bytes, f.size, false, 0, 1, 3, 123));
  s = fresh(); CHECK(!gd_stats_feed(&s, f.bytes, f.size, false, 0, 0, 0, 123));
  s = fresh(); CHECK(!gd_stats_feed(&s, f.bytes, f.size, false, 0, 0, 3, 0));
  fixture bad = f; u32(&bad, offsetof(struct nlmsghdr, nlmsg_seq), 4); CHECK(refused(&bad));
  bad = f; u32(&bad, offsetof(struct nlmsghdr, nlmsg_pid), 0); CHECK(refused(&bad));
  bad = f; u32(&bad, offsetof(struct nlmsghdr, nlmsg_len), 0); CHECK(refused(&bad));
  bad = f; u32(&bad, offsetof(struct nlmsghdr, nlmsg_len), UINT32_MAX); CHECK(refused(&bad));
  for (unsigned flags = 1; flags <= 0x8000; flags <<= 1) {
    if (flags == NLM_F_MULTI) continue;
    bad = f; u16(&bad, offsetof(struct nlmsghdr, nlmsg_flags), (uint16_t)(NLM_F_MULTI | flags)); CHECK(refused(&bad));
  }
  bad = f; u16(&bad, offsetof(struct nlmsghdr, nlmsg_flags), 0); CHECK(refused(&bad));
  for (unsigned type = NLMSG_NOOP; type <= NLMSG_OVERRUN; type++) {
    bad = f; u16(&bad, offsetof(struct nlmsghdr, nlmsg_type), (uint16_t)type); CHECK(refused(&bad));
  }
  bad = f; u16(&bad, offsetof(struct nlmsghdr, nlmsg_type), (NFNL_SUBSYS_CTNETLINK << 8) | IPCTNL_MSG_CT_NEW); CHECK(refused(&bad));
  bad = f; bad.bytes[sizeof(struct nlmsghdr)] = AF_INET; CHECK(refused(&bad));
  bad = f; bad.bytes[sizeof(struct nlmsghdr) + offsetof(struct nfgenmsg, version)] = 1; CHECK(refused(&bad));
  bad = f; bad.bytes[sizeof(struct nlmsghdr) + offsetof(struct nfgenmsg, res_id)] = 1; CHECK(refused(&bad));
  size_t first = sizeof(struct nlmsghdr) + sizeof(struct nfgenmsg), second = first + 8;
  bad = f; u16(&bad, second + offsetof(struct nlattr, nla_type), CTA_STATS_GLOBAL_ENTRIES); CHECK(refused(&bad));
  bad = f; u16(&bad, first + offsetof(struct nlattr, nla_type), CTA_STATS_GLOBAL_MAX + 1); CHECK(refused(&bad));
  bad = f; u16(&bad, first + offsetof(struct nlattr, nla_type), 0); CHECK(refused(&bad));
  bad = f; u16(&bad, first + offsetof(struct nlattr, nla_type), CTA_STATS_GLOBAL_ENTRIES | NLA_F_NESTED); CHECK(refused(&bad));
  bad = f; u16(&bad, first + offsetof(struct nlattr, nla_type), CTA_STATS_GLOBAL_ENTRIES | NLA_F_NESTED | NLA_F_NET_BYTEORDER); CHECK(refused(&bad));
  bad = f; u16(&bad, first + offsetof(struct nlattr, nla_len), 3); CHECK(refused(&bad));
  bad = f; u16(&bad, first + offsetof(struct nlattr, nla_len), 5); CHECK(refused(&bad));
  bad = f; u16(&bad, first + offsetof(struct nlattr, nla_len), 12); CHECK(refused(&bad));
  bad = f; bad.size -= 8; u32(&bad, offsetof(struct nlmsghdr, nlmsg_len), (uint32_t)bad.size); CHECK(refused(&bad));
  bad = f; bad.bytes[bad.size++] = 0; CHECK(refused(&bad));
  bad = f; memcpy(bad.bytes + bad.size, f.bytes, f.size); bad.size += f.size; CHECK(refused(&bad));
  bad = f; u16(&bad, first + offsetof(struct nlattr, nla_type), CTA_STATS_GLOBAL_ENTRIES | NLA_F_NET_BYTEORDER); s = fresh();
  CHECK(feed(&s, &bad) && s.allocated == 1234);
  unsigned char unaligned[129]; memcpy(unaligned + 1, f.bytes, f.size); s = fresh();
  CHECK(gd_stats_feed(&s, unaligned + 1, f.size, false, 0, 0, 3, 123) && s.allocated == 1234);
  uint32_t seed = 23;
  for (unsigned i = 0; i < 256; i++) {
    bad = f; seed = seed * 1664525U + 1013904223U; bad.bytes[seed % bad.size] ^= (unsigned char)(1U << ((seed >> 16) & 7));
    s = fresh(); bool ok = feed(&s, &bad); CHECK(ok ? (s.done && !s.failed) : (s.failed && s.allocated == 0xdead && s.maximum == 0xbeef));
  }
  char script[160]; size_t length = 0;
  CHECK(gd_probe_script("takos_cx_0123456789abcdef0123456789abcdef", script, sizeof(script), &length));
  CHECK(strcmp(script, "create table inet takos_cx_0123456789abcdef0123456789abcdef_drain_probe\n") == 0 && length == strlen(script));
  CHECK(length > 0 && strchr(script, '\n') == script + length - 1 && !strchr(script, ';'));
  CHECK(!strstr(script, "flush") && !strstr(script, "delete") && !strstr(script, "rule ") && !strstr(script, "hook "));
  CHECK(!gd_probe_script("takos_cx_bad\nflush ruleset", script, sizeof(script), &length));
  CHECK(!gd_probe_script("takos_cx_bad;delete table", script, sizeof(script), &length));
  CHECK(!gd_probe_script("foreign", script, sizeof(script), &length));
  CHECK(!gd_probe_script("takos_cx_good", script, 1, &length));
  /* The real native call site uses this exact primitive before raw check IO.
   * No failure/ACK result resets it. These cases execute no native operation. */
  bool attempted = false; unsigned raw_effects = 0;
  if (gd_probe_consume(&attempted)) raw_effects++;
  CHECK(attempted && raw_effects == 1);
  CHECK(!gd_probe_consume(&attempted) && raw_effects == 1); /* Lost ACK. */
  CHECK(!gd_probe_consume(&attempted) && raw_effects == 1); /* Stats/refusal/cancel. */
  CHECK(!gd_probe_consume(&attempted) && raw_effects == 1); /* Successful reply replay. */
  printf("PASS %u pure CT-stats/probe checks; native execution 0; barrier unproven\n", checks);
  return 0;
}
