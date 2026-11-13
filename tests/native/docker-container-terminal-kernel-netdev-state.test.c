/* SPDX-License-Identifier: GPL-2.0-only */
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#include "../../scripts/native/docker-container-terminal-kernel-state.h"

struct tako_terminal_owner {
  unsigned int refs;
  unsigned int poison_before_put;
  struct tako_terminal_state devices;
  struct tako_terminal_state packets;
};

static unsigned long checks;
#define CHECK(x) do { assert(x); checks++; } while (0)

static struct tako_terminal_owner *device_cas(
    struct tako_terminal_owner **slot, struct tako_terminal_owner *expected,
    struct tako_terminal_owner *desired) {
  (void)__atomic_compare_exchange_n(slot, &expected, desired, 0,
                                    __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
  return expected;
}

#define cmpxchg device_cas
#include "../../scripts/native/docker-container-terminal-kernel-netdev-state.h"
#undef cmpxchg

void tako_terminal_device_put(struct tako_terminal_owner *owner) {
  CHECK(owner->refs > 0);
  if (owner->devices.poisoned) CHECK(owner->poison_before_put);
  tako_terminal_state_put(&owner->devices);
  owner->refs--;
}

void tako_terminal_device_poison(struct tako_terminal_owner *owner) {
  owner->devices.poisoned = 1;
  owner->poison_before_put = 1;
}

static void initialize(struct tako_terminal_owner *owner) {
  *owner = (struct tako_terminal_owner){.refs = 1}; /* original net allocation */
  tako_terminal_state_init(&owner->devices);
  tako_terminal_state_init(&owner->packets);
}

static struct tako_terminal_owner *reserve(struct tako_terminal_owner *owner) {
  if (owner) {
    owner->refs++;
    tako_terminal_state_get(&owner->devices);
  }
  return owner;
}

static void histories(void) {
  /* All 6^6 bounded histories: four retainable origins, fifth overflow, foreign.
   * Check the actual embedded CAS algorithm, not a parallel Boolean policy.
   */
  unsigned int history;
  for (history = 0; history < 46656u; history++) {
    struct tako_terminal_owner owners[5];
    struct tako_terminal_device_refs refs = {0};
    unsigned int seen[5] = {0}, retained = 0, code = history, step, i;
    for (i = 0; i < 5; i++) initialize(&owners[i]);
    for (step = 0; step < 6; step++) {
      unsigned int next = code % 6u;
      code /= 6u;
      if (next == 5u) {
        tako_terminal_device_refs_take(&refs, NULL);
      } else {
        if (!seen[next] && retained < 4u) {
          seen[next] = 1;
          retained++;
        }
        tako_terminal_device_refs_take(&refs, reserve(&owners[next]));
      }
      for (i = 0; i < 5; i++) {
        CHECK(owners[i].refs == 1u + seen[i]);
        if (!owners[i].devices.poisoned)
          CHECK(owners[i].devices.sockets == seen[i]);
      }
    }
    /* Model the actual free bookend: retain a local copy, destroy device slots,
     * then release saved refs. No unregister/migration put is performed.
     */
    {
      struct tako_terminal_device_refs held = refs;
      refs = (struct tako_terminal_device_refs){0};
      for (i = 0; i < 5; i++) CHECK(owners[i].refs == 1u + seen[i]);
      tako_terminal_device_refs_put(&held);
      tako_terminal_device_refs_put(&held);
    }
    for (i = 0; i < 5; i++) {
      CHECK(owners[i].refs == 1);
      if (!owners[i].devices.poisoned) CHECK(owners[i].devices.sockets == 0);
    }
  }
}

static void after_net_and_device_free(void) {
  struct tako_terminal_owner owner;
  struct tako_terminal_device_refs device = {0}, held;
  struct tako_terminal_owner *packet;
  initialize(&owner);
  tako_terminal_state_seal(&owner.devices);
  tako_terminal_device_refs_take(&device, reserve(&owner));
  CHECK(owner.devices.sealed && owner.devices.sockets == 1);
  owner.refs--; /* actual net allocation freed, independent device ref survives */
  CHECK(owner.refs == 1);
  packet = __atomic_load_n(&device.owners[0], __ATOMIC_ACQUIRE);
  CHECK(packet == &owner);
  packet->refs++; /* actual packet_clone uses the still-held original */
  tako_terminal_state_get(&packet->packets);
  CHECK(owner.refs == 2 && owner.packets.sockets == 1);
  held = device;
  device = (struct tako_terminal_device_refs){0}; /* device allocation free */
  CHECK(owner.devices.sockets == 1);
  tako_terminal_device_refs_put(&held); /* only after free */
  CHECK(owner.refs == 1 && owner.devices.sockets == 0);
  CHECK(packet->packets.sockets == 1);
  tako_terminal_state_put(&packet->packets);
  packet->refs--;
  CHECK(owner.refs == 0);
}

int main(void) {
  histories();
  after_net_and_device_free();
  printf("netdev same-byte CAS/lifetime model: %lu checks\n", checks);
  return 0;
}
