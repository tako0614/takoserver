#include "../../scripts/native/docker-container-terminal-namespace.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned int assertions;
#define CHECK(condition) do { ++assertions; assert(condition); } while (0)

static void put64(unsigned char *p, uint64_t value) {
  for (int i = 7; i >= 0; --i) { p[i] = (unsigned char)value; value >>= 8; }
}

static void created(unsigned char *p, uint64_t device, uint64_t inode) {
  memset(p, 0, TNS_WIRE_SIZE);
  memcpy(p, "TNS1", 4);
  p[4] = TNS_WIRE_CREATED;
  put64(p + 16, device);
  put64(p + 24, inode);
}

int main(void) {
  unsigned char bytes[TNS_WIRE_SIZE + 1];
  struct tns_wire_message message;
  created(bytes, UINT64_C(0x0102030405060708), UINT64_MAX);
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) == 0);
  CHECK(message.kind == TNS_WIRE_CREATED && message.error == 0);
  CHECK(message.identity.device == UINT64_C(0x0102030405060708));
  CHECK(message.identity.inode == UINT64_MAX);

  /* Every partial/extra frame is rejected; rejection must not overwrite the
   * caller's previous output with a zero or partial-success observation. */
  struct tns_wire_message previous = message;
  for (size_t size = 0; size <= TNS_WIRE_SIZE + 1; ++size) {
    if (size == TNS_WIRE_SIZE) continue;
    CHECK(tns_wire_decode(bytes, size, &message) < 0);
    CHECK(message.kind == previous.kind && message.error == previous.error &&
          message.identity.device == previous.identity.device &&
          message.identity.inode == previous.identity.inode);
  }
  CHECK(tns_wire_decode(NULL, TNS_WIRE_SIZE, &message) < 0);
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, NULL) < 0);
  const unsigned int reserved[] = {5, 6, 7, 12, 13, 14, 15};
  for (size_t i = 0; i < sizeof(reserved) / sizeof(reserved[0]); ++i) {
    bytes[reserved[i]] = 1;
    CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);
    bytes[reserved[i]] = 0;
  }
  for (size_t i = 0; i < 4; ++i) {
    unsigned char save = bytes[i];
    bytes[i] ^= 1;
    CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);
    bytes[i] = save;
  }
  for (unsigned int kind = 0; kind <= 255; ++kind) {
    if (kind == TNS_WIRE_CREATED) continue;
    bytes[4] = (unsigned char)kind;
    CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);
  }
  created(bytes, 4, 9);
  bytes[11] = 1;
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);
  created(bytes, 0, 9);
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);
  created(bytes, 4, 0);
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);

  memset(bytes, 0, sizeof(bytes));
  memcpy(bytes, "TNS1", 4);
  bytes[4] = TNS_WIRE_ERROR;
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);
  bytes[11] = 1;
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) == 0);
  CHECK(message.kind == TNS_WIRE_ERROR && message.error == 1);
  CHECK(message.identity.device == 0 && message.identity.inode == 0);
  bytes[10] = 15; bytes[11] = 255;
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) == 0);
  CHECK(message.error == 4095);
  bytes[10] = 16; bytes[11] = 0;
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);
  bytes[10] = 0; bytes[11] = 1; bytes[31] = 1;
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);
  bytes[31] = 0; bytes[23] = 1;
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) < 0);

  struct tns_identity creator = {4, 100}, actual = {4, 101};
  created(bytes, 4, 101);
  CHECK(tns_wire_decode(bytes, TNS_WIRE_SIZE, &message) == 0);
  CHECK(tns_birth_matches(&creator, &message, &actual));
  CHECK(!tns_birth_matches(&actual, &message, &actual)); /* creator NS refused */
  actual.inode = 102;
  CHECK(!tns_birth_matches(&creator, &message, &actual));
  actual.inode = 101; actual.device = 5;
  CHECK(!tns_birth_matches(&creator, &message, &actual));
  actual.device = 4; message.kind = TNS_WIRE_ERROR;
  CHECK(!tns_birth_matches(&creator, &message, &actual));
  message.kind = TNS_WIRE_CREATED; message.error = 1;
  CHECK(!tns_birth_matches(&creator, &message, &actual));
  message.error = 0; creator.inode = 0;
  CHECK(!tns_birth_matches(&creator, &message, &actual));
  CHECK(!tns_birth_matches(NULL, &message, &actual));
  CHECK(!tns_birth_matches(&creator, NULL, &actual));
  CHECK(!tns_birth_matches(&creator, &message, NULL));

  enum tns_phase phase = TNS_UNUSED;
  CHECK(tns_phase_hold(&phase) < 0);
  CHECK(tns_phase_close(&phase) < 0);
  CHECK(tns_phase_start(&phase) == 0 && phase == TNS_CREATING);
  CHECK(tns_phase_start(&phase) < 0); /* failed/lost-ACK attempt consumed */
  CHECK(tns_phase_hold(&phase) == 0 && phase == TNS_HELD);
  CHECK(tns_phase_hold(&phase) < 0);
  CHECK(tns_phase_start(&phase) < 0);
  CHECK(tns_phase_close(&phase) == 0 && phase == TNS_CLOSING);
  CHECK(tns_phase_hold(&phase) < 0); /* interruption cannot reopen */
  CHECK(tns_phase_start(&phase) < 0);
  CHECK(tns_phase_close(&phase) == 0); /* only close/join may repeat */
  phase = TNS_UNUSED;
  CHECK(tns_phase_start(&phase) == 0);
  CHECK(tns_phase_close(&phase) == 0);
  CHECK(tns_phase_hold(&phase) < 0);
  CHECK(tns_phase_start(&phase) < 0);
  phase = (enum tns_phase)99;
  CHECK(tns_phase_hold(&phase) < 0);
  CHECK(tns_phase_start(&phase) < 0);
  CHECK(tns_phase_close(&phase) < 0);
  CHECK(tns_phase_start(NULL) < 0);
  CHECK(tns_phase_hold(NULL) < 0);
  CHECK(tns_phase_close(NULL) < 0);
  printf("PASS %u pure byte/identity/one-use assertions; constructor not run\n", assertions);
  return 0;
}
