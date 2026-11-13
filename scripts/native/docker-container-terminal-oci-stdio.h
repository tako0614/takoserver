#ifndef DOCKER_CONTAINER_TERMINAL_OCI_STDIO_H
#define DOCKER_CONTAINER_TERMINAL_OCI_STDIO_H

#include "docker-container-terminal-oci.h"
#include <limits.h>
#include <sys/types.h>
#include <sys/stat.h>

/* Only actual fstat metadata reaches this policy in the native main. */
static inline int tns_ocip_private_fifo(mode_t mode, uid_t owner) {
  return S_ISFIFO(mode) && owner == 0 && (mode & 0077) == 0;
}

/* A closed parser for private IO, never a namespace or admission capability. */
enum tns_ocip_kind { TNS_OCIP_CREATE = 1, TNS_OCIP_OBSERVE = 2, TNS_OCIP_CANCEL = 3,
                     TNS_OCIP_START = 4, TNS_OCIP_OBSERVE_STARTED = 5 };
struct tns_ocip_request {
  enum tns_ocip_kind kind;
  struct tns_oci_options options;
  struct tns_oci_text args[TNS_OCI_MAX_ARGS], env[TNS_OCI_MAX_ENV];
};
struct tns_ocip_cursor { unsigned char *data; size_t size, at; };

static inline int tns_ocip_frame(const unsigned char *prefix, uint32_t *size) {
  if (!prefix || !size) return -1;
  uint32_t n = ((uint32_t)prefix[0] << 24) | ((uint32_t)prefix[1] << 16) |
               ((uint32_t)prefix[2] << 8) | prefix[3];
  if (!n || n > TNS_OCI_MAX_JSON) return -1;
  *size = n; return 0;
}

static inline void tns_ocip_space(struct tns_ocip_cursor *p) {
  while (p->at < p->size && (p->data[p->at] == ' ' || p->data[p->at] == '\t' ||
         p->data[p->at] == '\n' || p->data[p->at] == '\r')) ++p->at;
}

static inline int tns_ocip_take(struct tns_ocip_cursor *p, unsigned int c) {
  tns_ocip_space(p);
  if (p->at >= p->size || p->data[p->at] != c) return -1;
  ++p->at; return 0;
}

static inline int tns_ocip_hex(unsigned int c) {
  if (c >= '0' && c <= '9') return (int)(c - '0');
  if (c >= 'a' && c <= 'f') return (int)(c - 'a' + 10);
  if (c >= 'A' && c <= 'F') return (int)(c - 'A' + 10);
  return -1;
}

static inline int tns_ocip_u16(struct tns_ocip_cursor *p, unsigned int *value) {
  if (p->size - p->at < 4) return -1;
  unsigned int n = 0;
  for (unsigned int i = 0; i < 4; ++i) {
    int c = tns_ocip_hex(p->data[p->at++]); if (c < 0) return -1;
    n = (n << 4) | (unsigned int)c;
  }
  *value = n; return 0;
}

static inline int tns_ocip_string(struct tns_ocip_cursor *p, struct tns_oci_text *out) {
  if (tns_ocip_take(p, '"') < 0) return -1;
  size_t start = p->at, write = start;
  while (p->at < p->size) {
    unsigned int c = p->data[p->at++];
    if (c == '"') {
      struct tns_oci_text text = {p->data + start, write - start};
      if (tns_oci_utf8(text) < 0) return -1;
      p->data[write] = 0; *out = text; return 0;
    }
    if (c < 0x20) return -1;
    if (c != '\\') { p->data[write++] = (unsigned char)c; continue; }
    if (p->at >= p->size) return -1;
    c = p->data[p->at++];
    if (c == 'b') c = 8;
    else if (c == 'f') c = 12;
    else if (c == 'n') c = 10;
    else if (c == 'r') c = 13;
    else if (c == 't') c = 9;
    else if (c == 'u') {
      if (tns_ocip_u16(p, &c) < 0) return -1;
      if (c >= 0xd800 && c <= 0xdbff) {
        unsigned int low;
        if (p->size - p->at < 6 || p->data[p->at++] != '\\' ||
            p->data[p->at++] != 'u' || tns_ocip_u16(p, &low) < 0 ||
            low < 0xdc00 || low > 0xdfff) return -1;
        c = 0x10000 + ((c - 0xd800) << 10) + low - 0xdc00;
      } else if (c >= 0xdc00 && c <= 0xdfff) return -1;
      if (!c) return -1;
      if (c < 0x80) p->data[write++] = (unsigned char)c;
      else if (c < 0x800) {
        p->data[write++] = (unsigned char)(0xc0 | (c >> 6));
        p->data[write++] = (unsigned char)(0x80 | (c & 63));
      } else if (c < 0x10000) {
        p->data[write++] = (unsigned char)(0xe0 | (c >> 12));
        p->data[write++] = (unsigned char)(0x80 | ((c >> 6) & 63));
        p->data[write++] = (unsigned char)(0x80 | (c & 63));
      } else {
        p->data[write++] = (unsigned char)(0xf0 | (c >> 18));
        p->data[write++] = (unsigned char)(0x80 | ((c >> 12) & 63));
        p->data[write++] = (unsigned char)(0x80 | ((c >> 6) & 63));
        p->data[write++] = (unsigned char)(0x80 | (c & 63));
      }
      continue;
    } else if (c != '"' && c != '\\' && c != '/') return -1;
    p->data[write++] = (unsigned char)c;
  }
  return -1;
}

static inline int tns_ocip_number(struct tns_ocip_cursor *p, uint64_t *out) {
  tns_ocip_space(p);
  if (p->at >= p->size || p->data[p->at] < '0' || p->data[p->at] > '9') return -1;
  size_t start = p->at; uint64_t n = 0;
  while (p->at < p->size && p->data[p->at] >= '0' && p->data[p->at] <= '9') {
    unsigned int digit = p->data[p->at++] - '0';
    if (n > (UINT64_MAX - digit) / 10) return -1;
    n = n * 10 + digit;
  }
  if (p->at - start > 1 && p->data[start] == '0') return -1;
  *out = n; return 0;
}

static inline int tns_ocip_array(struct tns_ocip_cursor *p, struct tns_oci_text *items,
                                  size_t maximum, size_t *count) {
  if (tns_ocip_take(p, '[') < 0) return -1;
  *count = 0; tns_ocip_space(p);
  if (p->at < p->size && p->data[p->at] == ']') { ++p->at; return 0; }
  for (;;) {
    if (*count == maximum || tns_ocip_string(p, items + *count) < 0) return -1;
    ++*count; tns_ocip_space(p);
    if (p->at >= p->size) return -1;
    unsigned int c = p->data[p->at++];
    if (c == ']') return 0;
    if (c != ',') return -1;
  }
}

static inline int tns_ocip_decode(unsigned char *data, size_t size,
                                   struct tns_ocip_request *request) {
  static const char *const names[] = {"kind", "allocationRoot", "claimId",
    "installationId", "resourceUid", "incarnationId", "generation", "revision",
    "sourceDigest", "manifestDigest", "configDigest", "archiveDigest", "args",
    "env", "cwd", "uid", "gid", "memoryBytes", "nanoCpus", "pidsLimit"};
  if (!data || !request || !size || size > TNS_OCI_MAX_JSON) return -1;
  memset(request, 0, sizeof(*request));
  struct tns_ocip_cursor p = {data, size, 0}; uint64_t seen = 0;
  if (tns_ocip_take(&p, '{') < 0) return -1;
  for (;;) {
    struct tns_oci_text key, value; uint64_t number;
    if (tns_ocip_string(&p, &key) < 0 || tns_ocip_take(&p, ':') < 0) return -1;
    size_t field = 0;
    while (field < sizeof(names) / sizeof(names[0]) &&
           (strlen(names[field]) != key.size || memcmp(names[field], key.data, key.size))) ++field;
    if (field == sizeof(names) / sizeof(names[0]) || (seen & (UINT64_C(1) << field))) return -1;
    seen |= UINT64_C(1) << field;
    if (field == 12 || field == 13) {
      if (tns_ocip_array(&p, field == 12 ? request->args : request->env,
                        field == 12 ? TNS_OCI_MAX_ARGS : TNS_OCI_MAX_ENV,
                        field == 12 ? &request->options.argc : &request->options.envc) < 0) return -1;
    } else if (field == 6 || field >= 15) {
      if (tns_ocip_number(&p, &number) < 0) return -1;
      if ((field == 15 || field == 16 || field == 19) && number > UINT32_MAX) return -1;
      if (field == 6) request->options.generation = number;
      else if (field == 15) request->options.uid = (uint32_t)number;
      else if (field == 16) request->options.gid = (uint32_t)number;
      else if (field == 17) request->options.memory_bytes = number;
      else if (field == 18) request->options.nano_cpus = number;
      else request->options.pids_limit = (uint32_t)number;
    } else {
      if (tns_ocip_string(&p, &value) < 0) return -1;
      const char *s = (const char *)value.data;
      if (field == 0) {
        if (!strcmp(s, "linux-oci-create-stopped@1")) request->kind = TNS_OCIP_CREATE;
        else if (!strcmp(s, "linux-oci-observe-stopped@1")) request->kind = TNS_OCIP_OBSERVE;
        else if (!strcmp(s, "linux-oci-cancel@1")) request->kind = TNS_OCIP_CANCEL;
        else if (!strcmp(s, "linux-oci-start@1")) request->kind = TNS_OCIP_START;
        else if (!strcmp(s, "linux-oci-observe-started@1")) request->kind = TNS_OCIP_OBSERVE_STARTED;
        else return -1;
      } else if (field == 1) request->options.allocation_root = s;
      else if (field == 2) request->options.claim_id = s;
      else if (field == 3) request->options.installation_id = s;
      else if (field == 4) request->options.resource_uid = s;
      else if (field == 5) request->options.incarnation_id = s;
      else if (field == 7) request->options.revision = s;
      else if (field == 8) request->options.source_digest = s;
      else if (field == 9) request->options.manifest_digest = s;
      else if (field == 10) request->options.config_digest = s;
      else if (field == 11) request->options.archive_digest = s;
      else request->options.cwd = value;
    }
    tns_ocip_space(&p);
    if (p.at >= p.size) return -1;
    unsigned int c = p.data[p.at++];
    if (c == '}') break;
    if (c != ',') return -1;
  }
  tns_ocip_space(&p);
  if (p.at != p.size || !request->kind) return -1;
  if (request->kind != TNS_OCIP_CREATE) return seen == 1 ? 0 : -1;
  if (seen != ((UINT64_C(1) << 20) - 1)) return -1;
  request->options.args = request->args; request->options.env = request->env;
  return tns_oci_data(&request->options) == 0 &&
         tns_oci_metadata(&request->options) == 0 ? 0 : -1;
}

#endif
