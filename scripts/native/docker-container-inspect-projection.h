#ifndef TAKOS_DOCKER_INSPECT_PROJECTION_H
#define TAKOS_DOCKER_INSPECT_PROJECTION_H

/* Bounded, nonsecret projection of one selected Engine container. Raw inspect
 * bytes (including Env) never enter a reply or diagnostic. No JSON dependency. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum { DI_TOKENS = 16384, DI_DEPTH = 64, DI_OUTPUT = 16384 };
typedef struct { size_t start, end; int next, child; unsigned char kind; } di_node;
typedef struct {
  const unsigned char *s;
  size_t size, at;
  int count;
  di_node *nodes;
  int64_t until;
} di_parser;
typedef struct { char *s; size_t used, capacity; } di_output;
typedef struct {
  uint32_t pid;
  bool healthy;
  char sandbox_id[65], sandbox_key[4096], image_id[72];
  char identity[72], revision[72], claim[65], network_mode[257];
  unsigned network_count;
  char network_name[257], network_id[65], endpoint_id[65];
  bool safe_host_config;
} di_capture;

static int64_t di_clock(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1;
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static bool di_live(const di_parser *p) {
  int64_t now = di_clock();
  return now >= 0 && now < p->until;
}

static int di_hex(unsigned char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static bool di_u16(di_parser *p, unsigned *out) {
  if (p->size - p->at < 4) return false;
  unsigned n = 0;
  for (int i = 0; i < 4; i++) {
    int h = di_hex(p->s[p->at++]);
    if (h < 0) return false;
    n = n * 16 + (unsigned)h;
  }
  *out = n;
  return true;
}
static bool di_string(di_parser *p) {
  if (p->at >= p->size || p->s[p->at++] != '"') return false;
  size_t checked = p->at;
  while (p->at < p->size) {
    if (p->at - checked >= 4096) {
      if (!di_live(p)) return false;
      checked = p->at;
    }
    unsigned char c = p->s[p->at++];
    if (c == '"') return true;
    if (c < 32) return false;
    if (c == '\\') {
      if (p->at >= p->size) return false;
      c = p->s[p->at++];
      if (c != 'u') {
        if (!c || !strchr("\"\\/bfnrt", c)) return false;
      } else {
        unsigned n;
        if (!di_u16(p, &n)) return false;
        if (n >= 0xd800 && n <= 0xdbff) {
          if (p->size - p->at < 6 || p->s[p->at++] != '\\' || p->s[p->at++] != 'u') return false;
          if (!di_u16(p, &n) || n < 0xdc00 || n > 0xdfff) return false;
        } else if (n >= 0xdc00 && n <= 0xdfff) return false;
      }
    } else if (c >= 128) {
      unsigned value, left, minimum;
      if (c >= 0xc2 && c <= 0xdf) { value = c & 31; left = 1; minimum = 128; }
      else if (c >= 0xe0 && c <= 0xef) { value = c & 15; left = 2; minimum = 2048; }
      else if (c >= 0xf0 && c <= 0xf4) { value = c & 7; left = 3; minimum = 65536; }
      else return false;
      if (p->size - p->at < left) return false;
      for (unsigned i = 0; i < left; i++) {
        unsigned char b = p->s[p->at++];
        if ((b & 0xc0) != 0x80) return false;
        value = (value << 6) | (b & 63);
      }
      if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
    }
  }
  return false;
}
static void di_space(di_parser *p) {
  while (p->at < p->size && (p->s[p->at] == ' ' || p->s[p->at] == '\t' ||
    p->s[p->at] == '\r' || p->s[p->at] == '\n')) p->at++;
}
static int di_value(di_parser *p, unsigned depth) {
  di_space(p);
  if (depth > DI_DEPTH || p->at >= p->size || p->count >= DI_TOKENS || !di_live(p)) return -1;
  int index = p->count++;
  di_node *n = &p->nodes[index];
  n->start = p->at; n->child = -1;
  unsigned char c = p->s[p->at];
  if (c == '{' || c == '[') {
    n->kind = c; p->at++;
    unsigned char close = c == '{' ? '}' : ']';
    di_space(p);
    if (p->at < p->size && p->s[p->at] != close) {
      n->child = p->count;
      for (;;) {
        if (c == '{') {
          di_space(p);
          if (p->at >= p->size || p->s[p->at] != '"' || di_value(p, depth + 1) < 0) return -1;
          di_space(p);
          if (p->at >= p->size || p->s[p->at++] != ':') return -1;
        }
        if (di_value(p, depth + 1) < 0) return -1;
        di_space(p);
        if (p->at >= p->size) return -1;
        if (p->s[p->at] == close) break;
        if (p->s[p->at++] != ',') return -1;
      }
    }
    if (p->at >= p->size || p->s[p->at++] != close) return -1;
  } else if (c == '"') {
    n->kind = 's';
    if (!di_string(p)) return -1;
  } else if (c == 't' || c == 'f' || c == 'n') {
    const char *word = c == 't' ? "true" : c == 'f' ? "false" : "null";
    size_t length = strlen(word);
    if (p->size - p->at < length || memcmp(p->s + p->at, word, length)) return -1;
    p->at += length; n->kind = c;
  } else {
    n->kind = 'd';
    if (c == '-') p->at++;
    if (p->at >= p->size || p->s[p->at] < '0' || p->s[p->at] > '9') return -1;
    if (p->s[p->at] == '0') p->at++;
    else while (p->at < p->size && p->s[p->at] >= '0' && p->s[p->at] <= '9') p->at++;
    if (p->at < p->size && p->s[p->at] == '.') {
      p->at++; size_t first = p->at;
      while (p->at < p->size && p->s[p->at] >= '0' && p->s[p->at] <= '9') p->at++;
      if (p->at == first) return -1;
    }
    if (p->at < p->size && (p->s[p->at] == 'e' || p->s[p->at] == 'E')) {
      p->at++; if (p->at < p->size && (p->s[p->at] == '+' || p->s[p->at] == '-')) p->at++;
      size_t first = p->at;
      while (p->at < p->size && p->s[p->at] >= '0' && p->s[p->at] <= '9') p->at++;
      if (p->at == first) return -1;
    }
  }
  n->end = p->at; n->next = p->count;
  return index;
}
static bool di_key(const di_parser *p, int node, const char *key) {
  const di_node *n = &p->nodes[node];
  if (n->kind != 's') return false;
  size_t at = n->start + 1, k = 0;
  while (at < n->end - 1) {
    unsigned c = p->s[at++];
    if (c == '\\') {
      if (p->s[at++] != 'u' || n->end - at < 5) return false;
      c = 0;
      for (int i = 0; i < 4; i++) c = c * 16 + (unsigned)di_hex(p->s[at++]);
    }
    if (!key[k] || c != (unsigned char)key[k++]) return false;
  }
  return key[k] == 0;
}
static int di_field(const di_parser *p, int object, const char *key) {
  if (object < 0 || p->nodes[object].kind != '{') return -1;
  int found = -1;
  for (int k = p->nodes[object].child; k >= 0 && k < p->nodes[object].next;) {
    int value = p->nodes[k].next;
    if (value >= p->nodes[object].next) return -1;
    if (di_key(p, k, key)) {
      if (found >= 0) return -2;
      found = value;
    }
    k = p->nodes[value].next;
  }
  return found;
}
static bool di_add(di_output *o, const void *s, size_t size) {
  if (size >= o->capacity - o->used) return false;
  memcpy(o->s + o->used, s, size); o->used += size; o->s[o->used] = 0;
  return true;
}
static bool di_text(di_output *o, const char *s) { return di_add(o, s, strlen(s)); }
static bool di_string_copy(const di_parser *p, int index, di_output *out, size_t max) {
  if (index < 0 || p->nodes[index].kind != 's') return false;
  const di_node *n = &p->nodes[index];
  if (n->end - n->start > max + 2) return false;
  for (size_t i = n->start + 1; i < n->end - 1; i++)
    if (p->s[i] < 32 || p->s[i] > 126 || p->s[i] == '\\' || p->s[i] == '"') return false;
  return di_add(out, p->s + n->start, n->end - n->start);
}
static bool di_property(const di_parser *p, int object, const char *key, const char *output, di_output *out, size_t max) {
  return di_text(out, output) && di_string_copy(p, di_field(p, object, key), out, max);
}
static bool di_optional(const di_parser *p, int object, const char *key, const char *output, di_output *out, size_t max) {
  if (object < 0 || p->nodes[object].kind != '{' || !di_text(out, output)) return false;
  int i = di_field(p, object, key);
  return i == -1 ? di_text(out, "\"\"") : di_string_copy(p, i, out, max);
}
static bool di_boolean(const di_parser *p, int object, const char *key, const char *output, di_output *out) {
  int i = di_field(p, object, key);
  if (i < 0 || (p->nodes[i].kind != 't' && p->nodes[i].kind != 'f')) return false;
  return di_text(out, output) && di_text(out, p->nodes[i].kind == 't' ? "true" : "false");
}
static bool di_copy_c(const di_parser *p, int index, char *out, size_t capacity) {
  if (index < 0 || p->nodes[index].kind != 's' || capacity < 1) return false;
  const di_node *n = &p->nodes[index];
  size_t length = n->end - n->start - 2;
  if (length >= capacity) return false;
  for (size_t i = 0; i < length; i++) {
    unsigned char c = p->s[n->start + 1 + i];
    if (c < 32 || c > 126 || c == '\\' || c == '"') return false;
    out[i] = (char)c;
  }
  out[length] = 0;
  return true;
}
static bool di_equal_text(const di_parser *p, int index, const char *text) {
  if (index < 0 || p->nodes[index].kind != 's') return false;
  const di_node *n = &p->nodes[index]; size_t size = strlen(text);
  return n->end - n->start == size + 2 && !memcmp(p->s + n->start + 1, text, size);
}
static bool di_empty(const di_parser *p, int object, const char *field, unsigned char kind) {
  int n = di_field(p, object, field);
  return n == -1 || (n >= 0 && (p->nodes[n].kind == 'n' ||
    (p->nodes[n].kind == kind && p->nodes[n].child < 0)));
}
static bool di_false(const di_parser *p, int object, const char *field) {
  int n = di_field(p, object, field); return n >= 0 && p->nodes[n].kind == 'f';
}
static bool di_mode(const di_parser *p, int object, const char *field, bool empty_default) {
  int n = di_field(p, object, field);
  return (empty_default && (n == -1 || di_equal_text(p, n, ""))) || di_equal_text(p, n, "private");
}
static bool di_security(const di_parser *p, int host, di_output *out, bool *safe) {
  int drop = di_field(p, host, "CapDrop"), security = di_field(p, host, "SecurityOpt");
  bool drop_all = drop >= 0 && p->nodes[drop].kind == '[' && p->nodes[drop].child >= 0 &&
    p->nodes[p->nodes[drop].child].next == p->nodes[drop].next && di_equal_text(p, p->nodes[drop].child, "ALL");
  bool no_new = security >= 0 && p->nodes[security].kind == '[' && p->nodes[security].child >= 0 &&
    p->nodes[p->nodes[security].child].next == p->nodes[security].next &&
    (di_equal_text(p, p->nodes[security].child, "no-new-privileges:true") ||
      di_equal_text(p, p->nodes[security].child, "no-new-privileges"));
  const bool facts[] = {
    di_false(p, host, "Privileged"), drop_all, di_empty(p, host, "CapAdd", '['), no_new,
    di_empty(p, host, "Binds", '[') && di_empty(p, host, "Mounts", '[') && di_empty(p, host, "VolumesFrom", '['),
    di_empty(p, host, "Devices", '[') && di_empty(p, host, "DeviceRequests", '[') && di_empty(p, host, "DeviceCgroupRules", '['),
    di_mode(p, host, "PidMode", true), di_mode(p, host, "IpcMode", false),
    di_mode(p, host, "UTSMode", true), di_mode(p, host, "CgroupnsMode", false),
    di_false(p, host, "PublishAllPorts") && di_empty(p, host, "PortBindings", '{')
  };
  const char *keys[] = {"nonPrivileged", "capDropAll", "capAddEmpty", "noNewPrivileges", "noHostMounts",
    "noDevices", "privatePid", "privateIpc", "privateUts", "privateCgroup", "unpublishedPorts"};
  bool all = true;
  if (!di_text(out, ",\"security\":{")) return false;
  for (size_t i = 0; i < sizeof(facts) / sizeof(*facts); i++) {
    if ((i && !di_text(out, ",")) || !di_text(out, "\"") || !di_text(out, keys[i]) ||
      !di_text(out, "\":") || !di_text(out, facts[i] ? "true" : "false")) return false;
    all = all && facts[i];
  }
  *safe = all;
  return di_text(out, "}");
}
static bool di_project(const unsigned char *body, size_t size, const char *selected_id, char *output, size_t capacity, di_capture *capture) {
  if (!body || !size || size > 1048576 || !selected_id || strlen(selected_id) != 64 || capacity < 1) return false;
  di_node *nodes = calloc(DI_TOKENS, sizeof(*nodes));
  if (!nodes) return false;
  int64_t began = di_clock();
  if (began < 0) { free(nodes); return false; }
  di_parser p = {.s = body, .size = size, .nodes = nodes, .until = began + 500};
  di_output out = {.s = output, .capacity = capacity}; output[0] = 0;
  bool ok = false, safe_host = false;
  if (di_value(&p, 0) != 0) goto done;
  di_space(&p);
  if (p.at != size || nodes[0].kind != '{') goto done;
  int id = di_field(&p, 0, "Id"), state = di_field(&p, 0, "State"), config = di_field(&p, 0, "Config");
  int host = di_field(&p, 0, "HostConfig"), network = di_field(&p, 0, "NetworkSettings");
  if (id < 0 || nodes[id].kind != 's' || nodes[id].end - nodes[id].start != 66 ||
    memcmp(body + nodes[id].start + 1, selected_id, 64)) goto done;
  if (!di_text(&out, "{\"id\":") || !di_string_copy(&p, id, &out, 64)) goto done;
  int pid = di_field(&p, state, "Pid");
  if (pid < 0 || nodes[pid].kind != 'd') goto done;
  uint64_t number = 0;
  for (size_t i = nodes[pid].start; i < nodes[pid].end; i++) {
    if (body[i] < '0' || body[i] > '9' || number > 214748364) goto done;
    number = number * 10 + body[i] - '0';
    if (number > 2147483647) goto done;
  }
  if (!di_text(&out, ",\"pid\":") || !di_add(&out, body + nodes[pid].start, nodes[pid].end - nodes[pid].start) ||
    !di_boolean(&p, state, "Running", ",\"running\":", &out) ||
    !di_boolean(&p, state, "Paused", ",\"paused\":", &out) ||
    !di_boolean(&p, state, "Restarting", ",\"restarting\":", &out) ||
    !di_boolean(&p, state, "Dead", ",\"dead\":", &out) ||
    !di_property(&p, 0, "Image", ",\"imageId\":", &out, 71)) goto done;
  int labels = di_field(&p, config, "Labels");
  if (!di_property(&p, labels, "takoserver.identity", ",\"identityLabel\":", &out, 71) ||
    !di_property(&p, labels, "takoserver.revision", ",\"revisionLabel\":", &out, 71) ||
    !di_property(&p, labels, "takoserver.create-claim", ",\"claimId\":", &out, 64) ||
    !di_property(&p, host, "NetworkMode", ",\"networkMode\":", &out, 256) ||
    !di_optional(&p, network, "SandboxID", ",\"sandboxId\":", &out, 64)) goto done;
  int dns = di_field(&p, host, "Dns");
  if (dns == -2 || (dns >= 0 && nodes[dns].kind != '[' && nodes[dns].kind != 'n') || !di_text(&out, ",\"dns\":[")) goto done;
  unsigned count = 0;
  if (dns >= 0 && nodes[dns].kind == '[') for (int i = nodes[dns].child; i >= 0 && i < nodes[dns].next; i = nodes[i].next) {
    if (++count > 3 || (count > 1 && !di_text(&out, ",")) || !di_string_copy(&p, i, &out, 64)) goto done;
  }
  if (!di_text(&out, "]") || !di_security(&p, host, &out, &safe_host) || !di_text(&out, ",\"networks\":[")) goto done;
  int networks = di_field(&p, network, "Networks");
  if (networks < 0 || nodes[networks].kind != '{') goto done;
  count = 0;
  for (int k = nodes[networks].child; k >= 0 && k < nodes[networks].next;) {
    int value = nodes[k].next;
    if (++count > 2 || (count > 1 && !di_text(&out, ",")) || !di_text(&out, "{\"name\":") ||
      !di_string_copy(&p, k, &out, 256) ||
      !di_property(&p, value, "NetworkID", ",\"networkId\":", &out, 64) ||
      !di_optional(&p, value, "EndpointID", ",\"endpointId\":", &out, 64) ||
      !di_optional(&p, value, "IPAddress", ",\"ipv4\":", &out, 64) ||
      !di_optional(&p, value, "GlobalIPv6Address", ",\"ipv6\":", &out, 64) ||
      !di_optional(&p, value, "MacAddress", ",\"mac\":", &out, 32) || !di_text(&out, "}")) goto done;
    k = nodes[value].next;
  }
  ok = di_text(&out, "]}") && di_live(&p);
  if (ok && capture) {
    memset(capture, 0, sizeof(*capture));
    capture->pid = (uint32_t)number;
    capture->network_count = count;
    capture->safe_host_config = safe_host;
    if (count == 1) {
      int key = nodes[networks].child, endpoint = nodes[key].next;
      if (!di_copy_c(&p, key, capture->network_name, sizeof(capture->network_name)) ||
        !di_copy_c(&p, di_field(&p, endpoint, "NetworkID"), capture->network_id, sizeof(capture->network_id))) { ok = false; goto done; }
      int ep = di_field(&p, endpoint, "EndpointID");
      if (ep != -1 && !di_copy_c(&p, ep, capture->endpoint_id, sizeof(capture->endpoint_id))) { ok = false; goto done; }
    }
    capture->healthy = p.nodes[di_field(&p, state, "Running")].kind == 't' &&
      p.nodes[di_field(&p, state, "Paused")].kind == 'f' &&
      p.nodes[di_field(&p, state, "Restarting")].kind == 'f' &&
      p.nodes[di_field(&p, state, "Dead")].kind == 'f';
    ok = di_copy_c(&p, di_field(&p, network, "SandboxID"), capture->sandbox_id, sizeof(capture->sandbox_id)) &&
      di_copy_c(&p, di_field(&p, network, "SandboxKey"), capture->sandbox_key, sizeof(capture->sandbox_key)) &&
      di_copy_c(&p, di_field(&p, 0, "Image"), capture->image_id, sizeof(capture->image_id)) &&
      di_copy_c(&p, di_field(&p, labels, "takoserver.identity"), capture->identity, sizeof(capture->identity)) &&
      di_copy_c(&p, di_field(&p, labels, "takoserver.revision"), capture->revision, sizeof(capture->revision)) &&
      di_copy_c(&p, di_field(&p, labels, "takoserver.create-claim"), capture->claim, sizeof(capture->claim)) &&
      di_copy_c(&p, di_field(&p, host, "NetworkMode"), capture->network_mode, sizeof(capture->network_mode));
  }
done:
  free(nodes);
  if (!ok) output[0] = 0;
  return ok;
}
#endif
