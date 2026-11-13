/* SPDX-License-Identifier: GPL-2.0 WITH Linux-syscall-note */
#ifndef _UAPI_LINUX_TAKO_TERMINAL_H
#define _UAPI_LINUX_TAKO_TERMINAL_H

#include <linux/ioctl.h>
#include <linux/types.h>

/* Experimental private v6.12 source ABI, not a terminal certificate.
 * CREATE takes arg=0, consumes this device open's only attempt, and returns
 * an O_CLOEXEC NSFS FD for a newly allocated namespace. No PID/nsFD input.
 * The original device open retains the same net even on a lost return.
 * CUT is monotonic, arg=0, and never opens the birth-deny gate.
 * full_ip_sockets includes in-flight/failing full-sock reservations.
 * OPEN is arg=0, one use, and limited to the original born namespace.
 * CUT, poison, release and close forbid reopening. No count is a grant.
 * No START, ADOPT, DELETE, or TERMINAL operation exists in this unit.
 */
#define TAKO_TERMINAL_CREATE _IO(0xb7, 1)
#define TAKO_TERMINAL_CUT _IO(0xb7, 2)
#define TAKO_TERMINAL_OPEN _IO(0xb7, 6)

struct tako_terminal_observation {
	__u64 net_cookie;
	__u64 namespace_inum;
	__u64 full_ip_sockets;
	__u64 allocations;
	__u64 releases;
	__u32 sealed;
	__u32 poisoned;
};
#define TAKO_TERMINAL_OBSERVE _IOR(0xb7, 3, struct tako_terminal_observation)

/* Drop ONLY this original device context's own net reference. The same device
 * FD retains its standalone kernel ledger. Other NSFS/runtime/task/socket refs
 * can keep the namespace alive. No wait/terminal result is provided.
 */
#define TAKO_TERMINAL_RELEASE_NAMESPACE _IO(0xb7, 4)
struct tako_terminal_lifetime_observation {
	__u64 net_cookie;
	__u64 namespace_inum;
	__u64 full_ip_sockets;
	__u64 requests;
	__u64 timewait;
	__u64 packet_groups;
	__u32 born;
	__u32 release_attempted;
	__u32 reference_released;
	__u32 net_gone;
	__u32 poisoned;
	__u32 reserved;
};
#define TAKO_TERMINAL_LIFETIME _IOR(0xb7, 5, struct tako_terminal_lifetime_observation)

#endif
