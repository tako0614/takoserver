#include "../../scripts/native/docker-container-terminal-oci.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static unsigned int assertions;
#define CHECK(c) do { ++assertions; assert(c); } while (0)
#define TEXT(s) { (const unsigned char *)(s), sizeof(s) - 1 }

int main(void) {
  static const char claim[] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  static const char digest[] = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const struct tns_oci_text args[] = {TEXT("/bin/app"), TEXT("猫😀\n\"\\")};
  const struct tns_oci_text env[] = {TEXT("HELLO=猫😀\n"), TEXT("EMPTY=")};
  struct tns_oci_options o = {
    .allocation_root = "/private/owned-claim", .claim_id = claim,
    .installation_id = "installation-猫", .resource_uid = "resource",
    .incarnation_id = "incarnation", .generation = UINT64_C(9007199254740991),
    .revision = "rev\n\"\\", .source_digest = digest, .manifest_digest = digest,
    .config_digest = digest, .archive_digest = digest,
    .args = args, .argc = 2, .env = env, .envc = 2,
    .cwd = TEXT("/アプリ"), .uid = 123, .gid = 456,
    .memory_bytes = UINT64_C(268435456), .nano_cpus = UINT64_C(250000000), .pids_limit = 42
  };
  CHECK(tns_oci_data(&o) == 0); CHECK(tns_oci_metadata(&o) == 0);
  CHECK(tns_oci_claim(claim) == 0); CHECK(tns_oci_claim(NULL) < 0);
  CHECK(tns_oci_claim("a") < 0); CHECK(tns_oci_digest(digest) == 0);
  CHECK(tns_oci_digest(claim) < 0); CHECK(tns_oci_digest(NULL) < 0);
  char invalid_claim[65]; memcpy(invalid_claim, claim, sizeof(invalid_claim));
  invalid_claim[63] = 'A'; CHECK(tns_oci_claim(invalid_claim) < 0);

  static const unsigned char invalid[][5] = {
    {0}, {0xc0, 0x80}, {0xc1, 0xbf}, {0x80}, {0xff}, {0xfe},
    {0xe0, 0x80, 0x80}, {0xed, 0xa0, 0x80}, {0xed, 0xbf, 0xbf},
    {0xf0, 0x80, 0x80, 0x80}, {0xf4, 0x90, 0x80, 0x80},
    {0xf5, 0x80, 0x80, 0x80}, {0xe3, 'a', 0x80}, {0xf0, 0x90, 'a', 0x80}
  };
  static const size_t sizes[] = {1,2,2,1,1,1,3,3,3,4,4,4,3,4};
  for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
    struct tns_oci_text text = {invalid[i], sizes[i]};
    CHECK(tns_oci_utf8(text) < 0);
  }
  const unsigned char three[] = {0xe7, 0x8c, 0xab};
  const unsigned char four[] = {0xf0, 0x9f, 0x98, 0x80};
  for (size_t size = 1; size < sizeof(three); ++size) {
    struct tns_oci_text text = {three, size}; CHECK(tns_oci_utf8(text) < 0);
  }
  for (size_t size = 1; size < sizeof(four); ++size) {
    struct tns_oci_text text = {four, size}; CHECK(tns_oci_utf8(text) < 0);
  }
  struct tns_oci_text text = {four, sizeof(four)};
  CHECK(tns_oci_utf8(text) == 0);
  text.data = NULL; CHECK(tns_oci_utf8(text) < 0);
  text.size = 0; CHECK(tns_oci_utf8(text) == 0);
  const unsigned char controls[] = {1, 8, 9, 10, 11, 12, 13, '"', '\\'};
  char escaped[128]; struct tns_oci_json quoted = {escaped, sizeof(escaped), 0, 0};
  text.data = controls; text.size = sizeof(controls);
  tns_oci_string(&quoted, text);
  CHECK(!quoted.failed);
  CHECK(!strcmp(escaped, "\"\\u0001\\b\\t\\n\\u000b\\f\\r\\\"\\\\\""));
  for (size_t size = 0; size <= quoted.used; ++size) {
    struct tns_oci_json short_out = {escaped, size, 0, 0};
    tns_oci_string(&short_out, text); CHECK(short_out.failed);
  }
  struct tns_oci_text duplicate[] = {TEXT("X=first"), TEXT("X=second")};
  const struct tns_oci_text *saved_env = o.env;
  o.env = duplicate; CHECK(tns_oci_data(&o) < 0); o.env = saved_env;
  o.generation = 0; CHECK(tns_oci_metadata(&o) < 0);
  o.generation = UINT64_C(9007199254740992); CHECK(tns_oci_metadata(&o) < 0);
  o.generation = UINT64_C(9007199254740991);
  o.memory_bytes = 0; CHECK(tns_oci_data(&o) < 0); o.memory_bytes = 268435456;
  o.nano_cpus = 9999999; CHECK(tns_oci_data(&o) < 0); o.nano_cpus = 250000000;
  o.pids_limit = 0; CHECK(tns_oci_data(&o) < 0); o.pids_limit = 42;
  const struct tns_oci_text saved_cwd = o.cwd;
  o.cwd = (struct tns_oci_text)TEXT("relative"); CHECK(tns_oci_data(&o) < 0); o.cwd = saved_cwd;
  o.argc = 0; CHECK(tns_oci_data(&o) < 0); o.argc = 2;
  o.envc = TNS_OCI_MAX_ENV + 1; CHECK(tns_oci_data(&o) < 0); o.envc = 2;

  CHECK(tns_oci_pid((const unsigned char *)"1", 1) == 1);
  CHECK(tns_oci_pid((const unsigned char *)"2147483647\n", 11) == 2147483647);
  CHECK(tns_oci_pid((const unsigned char *)"2147483648", 10) < 0);
  CHECK(tns_oci_pid((const unsigned char *)"01", 2) < 0);
  CHECK(tns_oci_pid((const unsigned char *)"0", 1) < 0);
  CHECK(tns_oci_pid((const unsigned char *)"-1", 2) < 0);
  CHECK(tns_oci_pid((const unsigned char *)"1\n2", 3) < 0);
  CHECK(tns_oci_pid((const unsigned char *)"1\n\n", 3) < 0);
  CHECK(tns_oci_pid((const unsigned char *)"1\0", 2) < 0);
  CHECK(tns_oci_pid(NULL, 1) < 0);
  unsigned int attempt = 0;
  CHECK(tns_oci_once(&attempt) == 0 && attempt == 1);
  CHECK(tns_oci_once(&attempt) < 0 && attempt == 1);
  CHECK(tns_oci_once(NULL) < 0);

  char receipt[8192]; struct tns_oci_json receipt_out = {receipt, sizeof(receipt), 0, 0};
  tns_oci_receipt(&o, &receipt_out); CHECK(!receipt_out.failed);
  char *bundle = malloc(TNS_OCI_MAX_JSON); CHECK(bundle != NULL);
  struct tns_oci_json bundle_out = {bundle, TNS_OCI_MAX_JSON, 0, 0};
  tns_oci_bundle(&o, "/proc/123/fd/7", "/proc/123/fd/8", &bundle_out);
  CHECK(!bundle_out.failed); CHECK(strstr(bundle, "hooks") == NULL);
  CHECK(strstr(bundle, "\"network\",\"path\":\"/proc/123/fd/8\"") != NULL);
  puts(receipt); puts(bundle); free(bundle);
  printf("PASS %u pure OCI data assertions; no native owner function run\n", assertions);
  return 0;
}
