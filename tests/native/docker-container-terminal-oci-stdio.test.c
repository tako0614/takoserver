#include "../../scripts/native/docker-container-terminal-oci-stdio.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static unsigned int assertions;
#define CHECK(c) do { ++assertions; assert(c); } while (0)
#define CLAIM "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
#define DIGEST "sha256:" CLAIM
static const char valid[] = "{\"kind\":\"linux-oci-create-stopped@1\",\"allocationRoot\":\"/owned/猫\",\"claimId\":\"" CLAIM "\",\"installationId\":\"installation\",\"resourceUid\":\"resource\",\"incarnationId\":\"incarnation\",\"generation\":1,\"revision\":\"revision\",\"sourceDigest\":\"" DIGEST "\",\"manifestDigest\":\"" DIGEST "\",\"configDigest\":\"" DIGEST "\",\"archiveDigest\":\"" DIGEST "\",\"args\":[\"/bin/app\",\"\\u732b\\ud83d\\ude00\\n\"],\"env\":[\"X=猫😀\"],\"cwd\":\"/app\",\"uid\":1000,\"gid\":1001,\"memoryBytes\":268435456,\"nanoCpus\":500000000,\"pidsLimit\":64}";

static int decode(const char *text, size_t size) {
  unsigned char *copy = malloc(size + 1);
  struct tns_ocip_request *request = malloc(sizeof(*request));
  CHECK(copy && request);
  memcpy(copy, text, size); copy[size] = 0;
  int result = tns_ocip_decode(copy, size, request);
  free(copy); free(request); return result;
}

static void refuse_replacement(const char *from, const char *to) {
  const char *where = strstr(valid, from); CHECK(where != NULL);
  size_t before = (size_t)(where - valid), after = strlen(where + strlen(from));
  size_t size = before + strlen(to) + after;
  char *copy = malloc(size + 1); CHECK(copy != NULL);
  memcpy(copy, valid, before); memcpy(copy + before, to, strlen(to));
  memcpy(copy + before + strlen(to), where + strlen(from), after + 1);
  CHECK(decode(copy, size) < 0); free(copy);
}

int main(void) {
  unsigned char prefix[4] = {0, 0, 0, 1}; uint32_t size = 99;
  CHECK(tns_ocip_frame(prefix, &size) == 0 && size == 1);
  prefix[0] = 0; prefix[1] = 0x10; prefix[2] = prefix[3] = 0;
  CHECK(tns_ocip_frame(prefix, &size) == 0 && size == TNS_OCI_MAX_JSON);
  prefix[3] = 1; CHECK(tns_ocip_frame(prefix, &size) < 0 && size == TNS_OCI_MAX_JSON);
  memset(prefix, 0, sizeof(prefix)); CHECK(tns_ocip_frame(prefix, &size) < 0);
  CHECK(tns_ocip_frame(NULL, &size) < 0); CHECK(tns_ocip_frame(prefix, NULL) < 0);

  unsigned char body[sizeof(valid)]; memcpy(body, valid, sizeof(valid));
  struct tns_ocip_request *request = malloc(sizeof(*request)); CHECK(request != NULL);
  CHECK(tns_ocip_decode(body, sizeof(valid) - 1, request) == 0);
  CHECK(request->kind == TNS_OCIP_CREATE);
  CHECK(!strcmp(request->options.allocation_root, "/owned/猫"));
  CHECK(request->options.argc == 2 && request->options.envc == 1);
  CHECK(request->options.args[1].size == strlen("猫😀\n"));
  CHECK(!memcmp(request->options.args[1].data, "猫😀\n", strlen("猫😀\n")));
  CHECK(request->options.uid == 1000 && request->options.gid == 1001);
  CHECK(request->options.memory_bytes == 268435456 && request->options.nano_cpus == 500000000);
  free(request);
  for (size_t n = 0; n < sizeof(valid) - 1; ++n) CHECK(decode(valid, n) < 0);
  CHECK(decode(valid, sizeof(valid)) < 0); /* trailing NUL is not frame data */
  CHECK(decode("{}", 2) < 0);
  CHECK(decode("[]", 2) < 0);
  const char observe[] = " {\"kind\":\"linux-oci-observe-stopped@1\"} \n";
  CHECK(decode(observe, sizeof(observe) - 1) == 0);
  const char cancel[] = "{\"kind\":\"linux-oci-cancel@1\"}";
  CHECK(decode(cancel, sizeof(cancel) - 1) == 0);
  const char invalid_cancel[] = "{\"kind\":\"linux-oci-cancel@1\",\"claimId\":\"" CLAIM "\"}";
  CHECK(decode(invalid_cancel, sizeof(invalid_cancel) - 1) < 0);
  refuse_replacement("linux-oci-create-stopped@1", "linux-oci-start@1");
  refuse_replacement("\"generation\":1", "\"generation\":0");
  refuse_replacement("\"generation\":1", "\"generation\":-1");
  refuse_replacement("\"generation\":1", "\"generation\":01");
  refuse_replacement("\"generation\":1", "\"generation\":1.0");
  refuse_replacement("\"generation\":1", "\"generation\":1e0");
  refuse_replacement("\"generation\":1", "\"generation\":9007199254740992");
  refuse_replacement("\"generation\":1", "\"generation\":18446744073709551616");
  refuse_replacement("\"uid\":1000", "\"uid\":4294967296");
  refuse_replacement("\"uid\":1000", "\"uid\":true");
  refuse_replacement("\"uid\":1000", "\"uid\":\"1000\"");
  refuse_replacement("\"pidsLimit\":64", "\"pidsLimit\":0");
  refuse_replacement("\"env\":[\"X=猫😀\"]", "\"env\":[\"X=a\",\"X=b\"]");
  refuse_replacement("\"args\":[\"/bin/app\",", "\"args\":[12,");
  refuse_replacement("\"cwd\":\"/app\"", "\"cwd\":\"relative\"");
  refuse_replacement("\"revision\":\"revision\"", "\"revision\":\"\\u0000\"");
  refuse_replacement("\"revision\":\"revision\"", "\"revision\":\"\\ud800\"");
  refuse_replacement("\"revision\":\"revision\"", "\"revision\":\"\\udc00\"");
  refuse_replacement("\"revision\":\"revision\"", "\"revision\":\"\\ud800\\u0061\"");
  refuse_replacement("\"revision\":\"revision\"", "\"revision\":\"\\x61\"");
  refuse_replacement("\"revision\":\"revision\"", "\"revision\":\"\300\200\"");
  refuse_replacement("\"revision\":\"revision\"", "\"revision\":\"bad\nstring\"");
  refuse_replacement("\"generation\":1", "\"generation\":1,\"generation\":1");
  refuse_replacement("\"generation\":1", "\"generation\":1,\"gener\\u0061tion\":1");
  refuse_replacement("\"generation\":1", "\"generation\":1,\"namespaceFd\":5");
  refuse_replacement("\"generation\":1", "\"generation\":1,\"ready\":true");
  refuse_replacement("\"generation\":1,", "");
  refuse_replacement("\"generation\":1", "\"Generation\":1");
  refuse_replacement("\"pidsLimit\":64}", "\"pidsLimit\":64,}");
  refuse_replacement("\"pidsLimit\":64}", "\"pidsLimit\":64}{}");
  printf("PASS %u new pure framed/closed-JSON parser assertions; main not run\n", assertions);
  return 0;
}
