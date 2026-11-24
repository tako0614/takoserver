#ifndef DOCKER_CONTAINER_TERMINAL_OCI_ADMISSION_WIRE_H
#define DOCKER_CONTAINER_TERMINAL_OCI_ADMISSION_WIRE_H

#include <inttypes.h>
#include <stdio.h>

enum { OCIP_ADMISSION_REQUEST = 24, OCIP_ADMISSION_H_REPLY = 176,
       OCIP_ADMISSION_P_REPLY = 192, OCIP_ADMISSION_H_MAX_MS = 2500,
       OCIP_ADMISSION_JSON_MAX = 512 };
static const char ocip_admission_h_request[] = "TKOLIVE3";
static const char ocip_admission_h_proof[] = "TKOLIVR3";
static const char ocip_admission_h_released[] = "TKOLIVEA";
static const char ocip_admission_p_proof[] = "TKOADMR1";

static inline uint64_t ocip_admission_u64(const unsigned char *p) {
  uint64_t n = 0;
  for (size_t i = 0; i < 8; ++i) n = (n << 8) | p[i];
  return n;
}

static inline int ocip_admission_valid(const struct tns_oci_published_admission *f) {
  const struct tns_oci_topology_identity *t = &f->topology;
  return !f->init.started.native_id[64] && tns_oci_claim(f->init.started.native_id) == 0 &&
    f->generation > 0 && f->generation <= UINT64_C(9007199254740991) &&
    f->init.started.namespace_device && f->init.started.namespace_inode && f->init.pidfd_inode &&
    t->device && t->inode && t->size && t->size <= 32768 && !t->uid &&
    t->mode == (S_IFREG | 0600) && t->nlink == 1;
}

static inline void ocip_admission_encode(unsigned char *body, const char tag[8],
                                           const struct tns_oci_published_admission *f) {
  memcpy(body, tag, 8);
  memcpy(body + 8, f->init.started.native_id, 64);
  const struct tns_oci_topology_identity *t = &f->topology;
  uint64_t fields[] = {f->generation, f->init.started.namespace_device, f->init.started.namespace_inode,
    f->init.pidfd_device, f->init.pidfd_inode, t->device, t->inode, t->size, t->uid, t->mode,
    t->nlink, t->mtime_ns, t->ctime_ns};
  for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); ++i) ocipp_put64(body + 72 + 8 * i, fields[i]);
}

static inline int ocip_admission_decode(const unsigned char *body, const char tag[8],
                                           struct tns_oci_published_admission *out) {
  if (memcmp(body, tag, 8)) return -1;
  struct tns_oci_published_admission f = {.init.pidfd = -1};
  memcpy(f.init.started.native_id, body + 8, 64);
  f.generation = ocip_admission_u64(body + 72);
  f.init.started.namespace_device = ocip_admission_u64(body + 80);
  f.init.started.namespace_inode = ocip_admission_u64(body + 88);
  f.init.pidfd_device = ocip_admission_u64(body + 96);
  f.init.pidfd_inode = ocip_admission_u64(body + 104);
  f.topology = (struct tns_oci_topology_identity){.device = ocip_admission_u64(body + 112),
    .inode = ocip_admission_u64(body + 120), .size = ocip_admission_u64(body + 128),
    .uid = ocip_admission_u64(body + 136), .mode = ocip_admission_u64(body + 144),
    .nlink = ocip_admission_u64(body + 152), .mtime_ns = ocip_admission_u64(body + 160),
    .ctime_ns = ocip_admission_u64(body + 168)};
  if (!ocip_admission_valid(&f)) return -1;
  *out = f;
  return 0;
}

static inline int ocip_admission_json(char out[OCIP_ADMISSION_JSON_MAX],
                                         const struct tns_oci_published_admission *f) {
  if (!ocip_admission_valid(f)) return -1;
  const struct tns_oci_topology_identity *t = &f->topology;
  int n = snprintf(out, OCIP_ADMISSION_JSON_MAX,
    "{\"kind\":\"linux-oci-parent-held-admission-current@1\",\"nativeId\":\"%s\",\"generation\":\"%" PRIu64
    "\",\"namespaceDevice\":\"%" PRIu64 "\",\"namespaceInode\":\"%" PRIu64
    "\",\"topology\":{\"device\":\"%" PRIu64 "\",\"inode\":\"%" PRIu64 "\",\"size\":\"%" PRIu64
    "\",\"uid\":\"0\",\"mode\":\"33152\",\"nlink\":\"1\",\"mtimeNs\":\"%" PRIu64
    "\",\"ctimeNs\":\"%" PRIu64 "\"},\"barrier\":\"unproven\"}", f->init.started.native_id, f->generation,
    f->init.started.namespace_device, f->init.started.namespace_inode, t->device, t->inode,
    t->size, t->mtime_ns, t->ctime_ns);
  return n > 0 && n <= 458 ? 0 : -1;
}
#endif
