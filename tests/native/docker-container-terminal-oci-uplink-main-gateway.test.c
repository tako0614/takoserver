/* Original main-table next-hop contract; closed pure byte/syscall models.
 * Includes the admission model, never its old main/cases. Only actual topology
 * selection and the exact route classifier/decoder run over a prepared owner;
 * no complete CREATE/currentness/cleanup/native networking is qualified here.
 *
 * Repo-only extraction at product root (OUT is existing private scratch):
 * python3 - "$OUT/gateway-body.inc" <<'PY'
 * import pathlib,re,sys
 * s=pathlib.Path('scripts/native/docker-container-terminal-oci-uplink.h').read_text()
 * m=re.search(r'^static int oci_uplink_host_routes\([^\n]*\) \{\n.*?^\}',s,re.M|re.S)
 * assert m
 * pathlib.Path(sys.argv[1]).write_text(m.group()+'\n')
 * PY
 * cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wpedantic \
 *   -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie \
 *   -DGATEWAY_BODY='"'"$OUT/gateway-body.inc"'"' \
 *   tests/native/docker-container-terminal-oci-uplink-main-gateway.test.c \
 *   -o "$OUT/gateway-test"
 * "$OUT/gateway-test" --foreign # Original classifier acceptance counterexample.
 * "$OUT/gateway-test" --all     # Revised classifier's new focused cases.
 */
#define main prior_admission_main_never_called
#include "docker-container-terminal-oci-admission.test.c"
#undef main
#ifndef GATEWAY_BODY
#error "Extract the exact original host_routes definition using the recipe above"
#endif
/* This extracted classifier is pure: all of its callees are byte validators.
 * There is no standalone getpid/syscall/FD operation to escape the raw model. */
#define oci_uplink_host_routes measured_host_routes
#include GATEWAY_BODY
#undef oci_uplink_host_routes

struct route_shape {
  int family;
  unsigned char prefix, table, scope, type, source, tos;
  uint32_t flags, index;
  int gateway, no_destination, peer_destination, duplicate_gateway, override_table;
  size_t gateway_width, destination_width;
  uint16_t forbidden;
};
static struct route_shape route_shape(int family, unsigned char prefix) {
  struct route_shape s = {.family = family, .prefix = prefix,
    .table = RT_TABLE_MAIN, .scope = RT_SCOPE_UNIVERSE, .type = RTN_UNICAST,
    .index = subject->expected.index, .gateway = 1,
    .gateway_width = family == AF_INET ? 4u : 16u,
    .destination_width = family == AF_INET ? 4u : 16u};
  return s;
}
static void append_route(unsigned char *bytes, size_t *used, const struct route_shape *s) {
  struct rtmsg h = {.rtm_family = (unsigned char)s->family, .rtm_dst_len = s->prefix,
    .rtm_src_len = s->source, .rtm_tos = s->tos, .rtm_table = s->table,
    .rtm_protocol = RTPROT_STATIC, .rtm_scope = s->scope, .rtm_type = s->type,
    .rtm_flags = s->flags};
  struct oci_uplink_request r; oci_uplink_request(&r, RTM_NEWROUTE, 0, &h, sizeof(h));
  unsigned char gateway[16], destination[16];
  const unsigned char *expected = s->family == AF_INET ? subject->expected.gateway4 : subject->expected.gateway6;
  const unsigned char *peer = s->family == AF_INET ? subject->expected.host4 : subject->expected.host6;
  memset(gateway, 0, sizeof(gateway)); memcpy(gateway, expected, s->family == AF_INET ? 4u : 16u);
  if (s->gateway == 2) gateway[s->family == AF_INET ? 3 : 15] ^= 0x40;
  memset(destination, 0, sizeof(destination));
  CHECK(inet_pton(s->family, s->family == AF_INET ? "198.18.0.0" : "2001:db9::", destination) == 1);
  if (s->peer_destination) memcpy(destination, peer, s->family == AF_INET ? 4u : 16u);
  CHECK(oci_uplink_attr(&r, RTA_OIF, &s->index, sizeof(s->index)) == 0);
  if (s->prefix && !s->no_destination)
    CHECK(oci_uplink_attr(&r, RTA_DST, destination, s->destination_width) == 0);
  if (s->gateway) {
    CHECK(oci_uplink_attr(&r, RTA_GATEWAY, gateway, s->gateway_width) == 0);
    if (s->duplicate_gateway) CHECK(oci_uplink_attr(&r, RTA_GATEWAY, gateway, s->gateway_width) == 0);
  }
  if (s->override_table) {
    uint32_t table = RT_TABLE_MAIN;
    CHECK(oci_uplink_attr(&r, RTA_TABLE, &table, sizeof(table)) == 0);
  }
  if (s->forbidden) {
    uint32_t value = 7;
    CHECK(oci_uplink_attr(&r, s->forbidden, &value, sizeof(value)) == 0);
  }
  *used = raw_append(bytes, *used, &r, 901);
}
static int scan_routes(const struct route_shape *routes, size_t count) {
  struct oci_uplink_dump *d = calloc(1, sizeof(*d));
  unsigned char *bytes = calloc(1, OCI_UPLINK_PACKET_MAX);
  CHECK(d && bytes); size_t used = 0;
  up.request.nlmsg_seq = 17;
  for (size_t i = 0; i < count; ++i) append_route(bytes, &used, &routes[i]);
  struct {struct nlmsghdr h; int result;} done = {.h = {
    .nlmsg_len = NLMSG_LENGTH(sizeof(int)), .nlmsg_type = NLMSG_DONE,
    .nlmsg_flags = NLM_F_MULTI, .nlmsg_seq = 17, .nlmsg_pid = 901}};
  CHECK(used + sizeof(done) <= OCI_UPLINK_PACKET_MAX);
  memcpy(bytes + used, &done, sizeof(done)); used += sizeof(done);
  d->sequence = 17; d->port = 901; d->type = RTM_NEWROUTE;
  CHECK(oci_uplink_dump_feed(d, bytes, used) == 0 && d->done && d->records == count);
  int result = measured_host_routes(subject, d);
  free(bytes); free(d); return result;
}
static void defaults(struct route_shape routes[3]) {
  routes[0] = route_shape(AF_INET, 0); routes[1] = route_shape(AF_INET6, 0);
}
static void foreign_counterexample(void) {
  struct route_shape routes[3]; defaults(routes);
  routes[2] = route_shape(AF_INET, 16); routes[2].gateway = 2;
  int result = scan_routes(routes, 3);
  printf("actual main nondefault foreign-gateway classifier: %d (must refuse)\n", result); fflush(stdout);
  CHECK(result < 0);
}
static void next_hop_cases(void) {
  struct route_shape routes[3];
  for (int family = 0; family < 2; ++family) {
    defaults(routes); routes[2] = route_shape(family ? AF_INET6 : AF_INET, family ? 64 : 16);
    CHECK(scan_routes(routes, 3) == 0); /* Positive prefix is not a third default. */
    for (int fault = 1; fault <= 12; ++fault) {
      struct route_shape saved = routes[2];
      if (fault == 1) routes[2].gateway = 2;
      if (fault == 2) routes[2].index++;
      if (fault == 3) routes[2].gateway_width--;
      if (fault == 4) routes[2].scope = RT_SCOPE_LINK;
      if (fault == 5) routes[2].type = RTN_BLACKHOLE;
      if (fault == 6) routes[2].flags = RTM_F_CLONED;
      if (fault == 7) routes[2].duplicate_gateway = 1;
      if (fault == 8) routes[2].forbidden = RTA_NH_ID;
      if (fault == 9) routes[2].no_destination = 1;
      if (fault == 10) routes[2].destination_width--;
      if (fault == 11) routes[2].peer_destination = 1;
      if (fault == 12) { routes[2].table = RT_TABLE_UNSPEC; routes[2].override_table = 1; routes[2].gateway = 2; }
      CHECK(scan_routes(routes, 3) < 0); routes[2] = saved;
    }
    /* Other-table gateways are outside this main-table source constraint. */
    routes[2].table = 200; routes[2].gateway = 2; routes[2].index++;
    CHECK(scan_routes(routes, 3) == 0);
    /* Ordinary direct connected/local prefixes retain their original rules. */
    routes[2].table = RT_TABLE_MAIN; routes[2].gateway = 0; routes[2].scope = RT_SCOPE_LINK;
    CHECK(scan_routes(routes, 3) == 0);
    routes[2].table = RT_TABLE_LOCAL; routes[2].scope = RT_SCOPE_HOST; routes[2].type = RTN_LOCAL;
    CHECK(scan_routes(routes, 3) == 0);
    routes[2].peer_destination = 1; CHECK(scan_routes(routes, 3) < 0);
  }
}
static void default_cases(void) {
  struct route_shape routes[3]; defaults(routes);
  CHECK(scan_routes(routes, 2) == 0);
  CHECK(scan_routes(routes, 1) < 0);
  CHECK(scan_routes(routes + 1, 1) < 0);
  for (int family = 0; family < 2; ++family) {
    defaults(routes); routes[2] = routes[family]; CHECK(scan_routes(routes, 3) < 0);
    for (int fault = 1; fault <= 7; ++fault) {
      defaults(routes);
      if (fault == 1) routes[family].gateway = 0;
      if (fault == 2) routes[family].gateway = 2;
      if (fault == 3) routes[family].index++;
      if (fault == 4) routes[family].gateway_width--;
      if (fault == 5) routes[family].scope = RT_SCOPE_LINK;
      if (fault == 6) routes[family].type = RTN_BLACKHOLE;
      if (fault == 7) routes[family].flags = RTM_F_CLONED;
      CHECK(scan_routes(routes, 2) < 0);
    }
  }
}
int main(int argc, char **argv) {
  CHECK(argc == 2); struct tns_oci_owner o; struct tns_owner b; prepare(&o, &b);
  if (!strcmp(argv[1], "--foreign")) foreign_counterexample();
  else { CHECK(!strcmp(argv[1], "--all")); foreign_counterexample(); next_hop_cases(); default_cases(); }
  CHECK(!up.creates && !up.mutations && !up.deletes);
  discard(&o); /* Raw-only fixture memory; no real FD exists or product cleanup runs. */
  printf("new actual main gateway raw boundary: %lu checks\n", checks); return 0;
}
