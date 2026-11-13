#define _GNU_SOURCE
#include <arpa/inet.h>
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#define TAKOS_DRAIN_FENCE_ONLY
#include "../../scripts/native/docker-container-inspect-projection.h"
#include "../../scripts/native/docker-container-guest-drain.h"

/* Portable byte fixtures only. This translation unit never includes native
 * socket/setns/nft/owner execution. No real C helper main is run. */
static unsigned checks;
#define CHECK(x) do { checks++; if (!(x)) { fprintf(stderr, "line %u: %s\n", __LINE__, #x); return 1; } } while (0)
typedef struct { unsigned char bytes[4096]; size_t size; } fixture;
static size_t begin_attr(fixture *f, unsigned type) {
  size_t at = f->size; struct nlattr h = {.nla_type = (uint16_t)type, .nla_len = sizeof(h)};
  memcpy(f->bytes + at, &h, sizeof(h)); f->size += sizeof(h); return at;
}
static void end_attr(fixture *f, size_t at) {
  struct nlattr h; memcpy(&h, f->bytes + at, sizeof(h)); h.nla_len = (uint16_t)(f->size - at);
  memcpy(f->bytes + at, &h, sizeof(h));
  size_t aligned = NLA_ALIGN(f->size); memset(f->bytes + f->size, 0, aligned - f->size); f->size = aligned;
}
static void scalar(fixture *f, unsigned type, const void *value, size_t size) {
  size_t at = begin_attr(f, type); memcpy(f->bytes + f->size, value, size); f->size += size; end_attr(f, at);
}
static void tuple(fixture *f, unsigned type, unsigned char family, unsigned char protocol, uint16_t zone) {
  size_t start = begin_attr(f, type | NLA_F_NESTED), ip = begin_attr(f, CTA_TUPLE_IP | NLA_F_NESTED);
  unsigned char src[16] = {0xff, 0, 0x80, 1}, dst[16] = {127, 0, 0, 2};
  scalar(f, family == AF_INET ? CTA_IP_V4_SRC : CTA_IP_V6_SRC, src, family == AF_INET ? 4 : 16);
  scalar(f, family == AF_INET ? CTA_IP_V4_DST : CTA_IP_V6_DST, dst, family == AF_INET ? 4 : 16);
  end_attr(f, ip);
  size_t proto = begin_attr(f, CTA_TUPLE_PROTO | NLA_F_NESTED);
  uint16_t source = htons(1), destination = htons(65535);
  scalar(f, CTA_PROTO_NUM, &protocol, 1); scalar(f, CTA_PROTO_SRC_PORT, &source, 2); scalar(f, CTA_PROTO_DST_PORT, &destination, 2);
  end_attr(f, proto); scalar(f, CTA_TUPLE_ZONE, &zone, 2); end_attr(f, start);
}
static size_t record(fixture *f, unsigned char family, unsigned char protocol, unsigned flags) {
  size_t start = f->size;
  struct nlmsghdr h = {.nlmsg_type = (NFNL_SUBSYS_CTNETLINK << 8) | IPCTNL_MSG_CT_NEW,
    .nlmsg_flags = (uint16_t)flags, .nlmsg_seq = 7, .nlmsg_pid = 123};
  struct nfgenmsg gen = {.nfgen_family = family};
  memcpy(f->bytes + f->size, &h, sizeof(h)); f->size += sizeof(h);
  memcpy(f->bytes + f->size, &gen, sizeof(gen)); f->size += sizeof(gen);
  tuple(f, CTA_TUPLE_ORIG, family, protocol, htons(65535)); tuple(f, CTA_TUPLE_REPLY, family, protocol, htons(1));
  uint32_t status = htonl(0x4000 | 8), timeout = htonl(999999); /* Include offload; never omit it. */
  scalar(f, CTA_STATUS, &status, sizeof(status)); scalar(f, CTA_TIMEOUT, &timeout, sizeof(timeout));
  h.nlmsg_len = (uint32_t)(f->size - start); memcpy(f->bytes + start, &h, sizeof(h)); return start;
}
static void done(fixture *f, int error, unsigned flags) {
  struct nlmsghdr h = {.nlmsg_len = sizeof(h) + sizeof(error), .nlmsg_type = NLMSG_DONE,
    .nlmsg_flags = (uint16_t)flags, .nlmsg_seq = 7, .nlmsg_pid = 123};
  memcpy(f->bytes + f->size, &h, sizeof(h)); f->size += sizeof(h);
  memcpy(f->bytes + f->size, &error, sizeof(error)); f->size += sizeof(error);
}
static gd_dump fresh(unsigned char family) { return (gd_dump){.sequence = 7, .port = 123, .family = family}; }
static bool feed(gd_dump *d, fixture *f) { return gd_feed(d, f->bytes, f->size, false, 0, 0); }
static void header_u32(fixture *f, size_t at, size_t field, uint32_t value) { memcpy(f->bytes + at + field, &value, sizeof(value)); }
static size_t attribute(const fixture *f, size_t start, size_t size, unsigned type) {
  size_t end = start + size;
  while (start + sizeof(struct nlattr) <= end) {
    struct nlattr h; memcpy(&h, f->bytes + start, sizeof(h));
    if ((h.nla_type & NLA_TYPE_MASK) == type) return start;
    start += NLA_ALIGN(h.nla_len);
  }
  abort();
}

static size_t fence_fixture(char *out, size_t cap) {
  const char *table = "takos_cx_test_drain";
  size_t used = (size_t)snprintf(out, cap, "{\"nftables\":[{\"metainfo\":{}},{\"table\":{\"family\":\"inet\",\"name\":\"%s\",\"handle\":1}}", table);
  const char *hooks[] = {"input", "output", "forward"};
  const char *matches[] = {
    "{\"match\":{\"op\":\"!=\",\"left\":{\"meta\":{\"key\":\"l4proto\"}},\"right\":{\"set\":[\"tcp\",\"udp\"]}}}",
    "{\"match\":{\"op\":\"!=\",\"left\":{\"ct\":{\"key\":\"state\"}},\"right\":\"established\"}}",
    "{\"match\":{\"op\":\"==\",\"left\":{\"&\":[{\"payload\":{\"protocol\":\"tcp\",\"field\":\"flags\"}},\"syn\"]},\"right\":\"syn\"}}"};
  const char *comments[] = {"takos_drain_protocol", "takos_drain_state", "takos_drain_syn"};
  for (unsigned i = 0; i < 3; i++) {
    used += (size_t)snprintf(out + used, cap - used,
      ",{\"chain\":{\"family\":\"inet\",\"table\":\"%s\",\"name\":\"%s\",\"handle\":2,\"type\":\"filter\",\"hook\":\"%s\",\"prio\":-199,\"policy\":\"accept\"}}", table, hooks[i], hooks[i]);
    for (unsigned j = 0; j < 3; j++) used += (size_t)snprintf(out + used, cap - used,
      ",{\"rule\":{\"family\":\"inet\",\"table\":\"%s\",\"chain\":\"%s\",\"handle\":3,\"expr\":[%s,{\"drop\":null}],\"comment\":\"%s\"}}", table, hooks[i], matches[j], comments[j]);
  }
  used += (size_t)snprintf(out + used, cap - used, "]}"); assert(used < cap); return used;
}
int main(void) {
  fixture v4 = {0}; record(&v4, AF_INET, IPPROTO_TCP, NLM_F_MULTI | NLM_F_DUMP_FILTERED);
  record(&v4, AF_INET, IPPROTO_UDP, NLM_F_MULTI); gd_dump d = fresh(AF_INET);
  CHECK(feed(&d, &v4) && !d.done && d.tcp == 1 && d.udp == 1);
  fixture end = {0}; done(&end, 0, NLM_F_MULTI); CHECK(feed(&d, &end) && d.done && !d.failed);
  CHECK(!feed(&d, &end) && d.failed); /* A completed dump cannot be replayed. */
  fixture v6 = {0}; record(&v6, AF_INET6, IPPROTO_TCP, NLM_F_MULTI); record(&v6, AF_INET6, IPPROTO_UDP, NLM_F_MULTI);
  done(&v6, 0, NLM_F_MULTI | NLM_F_DUMP_FILTERED); d = fresh(AF_INET6);
  CHECK(feed(&d, &v6) && d.done && d.tcp == 1 && d.udp == 1);
  d = fresh(AF_INET); CHECK(!feed(&d, &v6) && d.failed); /* Family mismatch is not a zero. */
  d = fresh(AF_INET); CHECK(feed(&d, &end) && d.done && d.tcp == 0 && d.udp == 0); /* Observation only. */
  for (size_t i = 0; i < v4.size; i++) {
    fixture cut = v4; cut.size = i; d = fresh(AF_INET);
    bool ok = feed(&d, &cut); CHECK(!ok || (!d.done && i > 0)); /* No truncated prefix completes. */
  }
  d = fresh(AF_INET); CHECK(!gd_feed(&d, v4.bytes, v4.size, true, 0, 0) && d.failed);
  d = fresh(AF_INET); CHECK(!gd_feed(&d, v4.bytes, v4.size, false, 9, 0));
  d = fresh(AF_INET); CHECK(!gd_feed(&d, v4.bytes, v4.size, false, 0, 1));
  fixture bad = v4; header_u32(&bad, 0, offsetof(struct nlmsghdr, nlmsg_seq), 8); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = v4; header_u32(&bad, 0, offsetof(struct nlmsghdr, nlmsg_pid), 0); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = v4; header_u32(&bad, 0, offsetof(struct nlmsghdr, nlmsg_len), 3); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  for (unsigned flag = 1; flag <= 0x8000; flag <<= 1) {
    if (flag == NLM_F_MULTI || flag == NLM_F_DUMP_FILTERED) continue;
    bad = v4; uint16_t flags = (uint16_t)(NLM_F_MULTI | flag); memcpy(bad.bytes + offsetof(struct nlmsghdr, nlmsg_flags), &flags, 2);
    d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  }
  bad = v4; uint16_t no_multi = 0; memcpy(bad.bytes + offsetof(struct nlmsghdr, nlmsg_flags), &no_multi, 2);
  d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  for (unsigned type = NLMSG_NOOP; type <= NLMSG_OVERRUN; type++) {
    bad = v4; uint16_t value = (uint16_t)type; memcpy(bad.bytes + offsetof(struct nlmsghdr, nlmsg_type), &value, 2);
    d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  }
  bad = (fixture){0}; done(&bad, -105, NLM_F_MULTI); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = (fixture){0}; done(&bad, 0, NLM_F_MULTI | NLM_F_DUMP_INTR); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = end; bad.size--; d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = end; record(&bad, AF_INET, IPPROTO_TCP, NLM_F_MULTI); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = (fixture){0}; record(&bad, AF_INET, IPPROTO_ICMP, NLM_F_MULTI); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = v4; bad.bytes[sizeof(struct nlmsghdr) + offsetof(struct nfgenmsg, version)] = 1; d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = v4; struct nlattr too_short = {.nla_len = 3, .nla_type = CTA_TUPLE_ORIG};
  memcpy(bad.bytes + sizeof(struct nlmsghdr) + sizeof(struct nfgenmsg), &too_short, sizeof(too_short)); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  fixture one = {0}; record(&one, AF_INET, IPPROTO_TCP, NLM_F_MULTI);
  size_t start = sizeof(struct nlmsghdr) + sizeof(struct nfgenmsg);
  size_t status_at = attribute(&one, start, one.size - start, CTA_STATUS);
  bad = one; uint16_t duplicate = CTA_TIMEOUT; memcpy(bad.bytes + status_at + offsetof(struct nlattr, nla_type), &duplicate, 2);
  d = fresh(AF_INET); CHECK(!feed(&d, &bad)); /* Missing status + duplicate ancillary field. */
  bad = one; uint16_t unknown = CTA_MAX + 1; memcpy(bad.bytes + status_at + offsetof(struct nlattr, nla_type), &unknown, 2);
  d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = one; uint16_t nested_scalar = CTA_STATUS | NLA_F_NESTED; memcpy(bad.bytes + status_at + offsetof(struct nlattr, nla_type), &nested_scalar, 2);
  d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  size_t reply_at = attribute(&one, start, one.size - start, CTA_TUPLE_REPLY);
  struct nlattr reply_header; memcpy(&reply_header, one.bytes + reply_at, sizeof(reply_header));
  size_t proto_at = attribute(&one, reply_at + sizeof(struct nlattr), reply_header.nla_len - sizeof(struct nlattr), CTA_TUPLE_PROTO);
  struct nlattr proto_header; memcpy(&proto_header, one.bytes + proto_at, sizeof(proto_header));
  size_t num_at = attribute(&one, proto_at + sizeof(struct nlattr), proto_header.nla_len - sizeof(struct nlattr), CTA_PROTO_NUM);
  bad = one; bad.bytes[num_at + sizeof(struct nlattr)] = IPPROTO_UDP; d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = one; uint16_t wide_num = 6; memcpy(bad.bytes + num_at, &wide_num, 2); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  fixture detailed = one;
  size_t info = begin_attr(&detailed, CTA_PROTOINFO | NLA_F_NESTED), tcp_info = begin_attr(&detailed, CTA_PROTOINFO_TCP | NLA_F_NESTED);
  unsigned char time_wait = 7; scalar(&detailed, CTA_PROTOINFO_TCP_STATE, &time_wait, 1); end_attr(&detailed, tcp_info); end_attr(&detailed, info);
  size_t counters = begin_attr(&detailed, CTA_COUNTERS_ORIG | NLA_F_NESTED); uint64_t count = 0;
  scalar(&detailed, CTA_COUNTERS_PACKETS, &count, 8); scalar(&detailed, CTA_COUNTERS_PAD, &count, 0);
  scalar(&detailed, CTA_COUNTERS_PAD, &count, 0); scalar(&detailed, CTA_COUNTERS_BYTES, &count, 8); end_attr(&detailed, counters);
  size_t timestamp = begin_attr(&detailed, CTA_TIMESTAMP | NLA_F_NESTED); scalar(&detailed, CTA_TIMESTAMP_START, &count, 8); end_attr(&detailed, timestamp);
  header_u32(&detailed, 0, offsetof(struct nlmsghdr, nlmsg_len), (uint32_t)detailed.size);
  d = fresh(AF_INET); CHECK(feed(&d, &detailed) && d.tcp == 1); /* Timewait/zero counters remain counted. */
  bad = detailed; uint16_t empty_state = sizeof(struct nlattr); memcpy(bad.bytes + tcp_info + sizeof(struct nlattr), &empty_state, 2);
  d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = detailed; uint16_t wrong_width = sizeof(struct nlattr) + 4; memcpy(bad.bytes + counters + sizeof(struct nlattr), &wrong_width, 2);
  d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  bad = one; size_t help = begin_attr(&bad, CTA_HELP | NLA_F_NESTED); scalar(&bad, CTA_HELP_INFO, &count, sizeof(count)); end_attr(&bad, help);
  header_u32(&bad, 0, offsetof(struct nlmsghdr, nlmsg_len), (uint32_t)bad.size); d = fresh(AF_INET); CHECK(!feed(&d, &bad));
  unsigned char unaligned[4097]; memcpy(unaligned + 1, v4.bytes, v4.size); d = fresh(AF_INET);
  CHECK(gd_feed(&d, unaligned + 1, v4.size, false, 0, 0) && d.tcp == 1 && d.udp == 1);
  d = fresh(AF_INET); d.tcp = 1000000; CHECK(!feed(&d, &v4));
  d = fresh(AF_INET); d.bytes = 64 * 1024 * 1024; CHECK(!feed(&d, &v4));
  char script[4096]; size_t length = 0;
  CHECK(gd_script("takos_cx_test", script, sizeof(script), &length));
  CHECK(length == strlen(script) && strstr(script, "create table inet takos_cx_test_drain\n") == script);
  CHECK(strstr(script, "hook input") && strstr(script, "hook output") && strstr(script, "hook forward"));
  CHECK(!strstr(script, "flush") && !strstr(script, "delete") && !strstr(script, "dport") && !strstr(script, "saddr"));
  CHECK(!gd_script("takos_cx_bad;flush ruleset", script, sizeof(script), &length));
  CHECK(!gd_script("takos_cx_test", script, 4, &length));
  char json[8192]; size_t size = fence_fixture(json, sizeof(json));
  CHECK(gd_fence((unsigned char *)json, size, "takos_cx_test_drain"));
  CHECK(!gd_fence((unsigned char *)json, size, "takos_cx_other_drain"));
  char *state = strstr(json, "established"); CHECK(state != NULL); state[0] = 'x'; CHECK(!gd_fence((unsigned char *)json, size, "takos_cx_test_drain"));
  size = fence_fixture(json, sizeof(json)); char *priority = strstr(json, "-199"); CHECK(priority != NULL); priority[3] = '8'; CHECK(!gd_fence((unsigned char *)json, size, "takos_cx_test_drain"));
  size = fence_fixture(json, sizeof(json)); CHECK(!gd_fence((unsigned char *)json, size - 1, "takos_cx_test_drain"));
  size = fence_fixture(json, sizeof(json)); char *drop = strstr(json, "\"drop\":null"); CHECK(drop != NULL); drop[1] = 'x'; CHECK(!gd_fence((unsigned char *)json, size, "takos_cx_test_drain"));
  size = fence_fixture(json, sizeof(json)); char *hook = strstr(json, "\"hook\":\"input\""); CHECK(hook != NULL); hook[9] = 'x'; CHECK(!gd_fence((unsigned char *)json, size, "takos_cx_test_drain"));
  size = fence_fixture(json, sizeof(json)); char *udp = strstr(json, "\"tcp\",\"udp\""); CHECK(udp != NULL); udp[8] = 'x'; CHECK(!gd_fence((unsigned char *)json, size, "takos_cx_test_drain"));
  size = fence_fixture(json, sizeof(json)); char *comment = strstr(json, "takos_drain_protocol"); CHECK(comment != NULL); comment[12] = 'x'; CHECK(!gd_fence((unsigned char *)json, size, "takos_cx_test_drain"));
  /* Bounded deterministic mutations exercise refusal paths under sanitizers.
   * A mutation may remain a valid observation; it never gains terminal status. */
  uint32_t seed = 17;
  for (unsigned i = 0; i < 256; i++) {
    bad = v4; seed = seed * 1664525U + 1013904223U;
    bad.bytes[seed % bad.size] ^= (unsigned char)(1U << ((seed >> 16) & 7));
    d = fresh(AF_INET); bool valid = feed(&d, &bad); CHECK(!valid || !d.done);
  }
  printf("PASS %u pure decoder/fence checks; native execution 0; barrier unproven\n", checks);
  return 0;
}
