import { randomUUID } from "node:crypto";

// A caller-driven protocol probe, not a Host, SDK, or complete qualification.
const api = "forms.takoform.com/v2";
const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const operationStates = new Set(["queued", "running", "waiting_input", "reconciling", "succeeded", "failed"]);
const resourcePhases = new Set(["pending", "idle", "deleting", "error"]);

function isToken(value) { return typeof value === "string" && token.test(value); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isUtcTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

class BaselineFailure extends Error {}

function requireThat(condition, step, reason) {
  if (!condition) throw new BaselineFailure(`v2 HTTP baseline ${step}: ${reason}`);
}

function httpsUrl(value, step) {
  requireThat(typeof value === "string" && /^[\x21-\x7e]+$/u.test(value) &&
    !/[\\?#]/u.test(value), step, "expected a serialized ASCII HTTPS URL without query or fragment");
  const authority = /^https:\/\/([^/]+)(?:\/.*)?$/iu.exec(value)?.[1];
  requireThat(authority && !authority.includes("@"), step, "userinfo is forbidden");
  let url;
  try { url = new URL(value); } catch { requireThat(false, step, "expected an absolute HTTPS URL"); }
  requireThat(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
    step, "expected an ASCII HTTPS URL without userinfo, query, or fragment");
  return url;
}

function documentationUrl(value, step) {
  let url;
  try { url = new URL(value); } catch { requireThat(false, step, "expected an absolute HTTPS URL"); }
  requireThat(url.protocol === "https:", step, "expected an absolute HTTPS URL");
}

function validFixture(fixture) {
  requireThat(fixture && fixture.disposable === true, "fixture", "explicit disposable fixture is required");
  requireThat(typeof fixture.form === "string" && typeof fixture.unknownForm === "string" &&
    fixture.form !== fixture.unknownForm, "fixture", "distinct supported and unsupported Form URLs are required");
  httpsUrl(fixture.form, "fixture.form");
  httpsUrl(fixture.unknownForm, "fixture.unknownForm");
  requireThat(isToken(fixture.space) && isToken(fixture.name) && fixture.name.length <= 110,
    "fixture", "valid Space and a short disposable name are required");
  requireThat(fixture.spec && typeof fixture.spec === "object" && !Array.isArray(fixture.spec),
    "fixture", "a Form-valid spec object is required");
  if (fixture.privateInputs !== undefined) {
    requireThat(fixture.privateInputs && typeof fixture.privateInputs === "object" &&
      !Array.isArray(fixture.privateInputs) && Object.values(fixture.privateInputs).every((v) => typeof v === "string"),
    "fixture", "privateInputs must be a string map");
  }
  requireThat(fixture.assertResource === undefined || typeof fixture.assertResource === "function",
    "fixture", "assertResource must be a function");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function validDiscovery(value, origin) {
  requireThat(value?.api === api, "discovery", "wrong API identity");
  const base = httpsUrl(value.baseUrl, "discovery.baseUrl");
  requireThat(base.origin === origin && !value.baseUrl.endsWith("/"), "discovery", "invalid baseUrl");
  documentationUrl(value.documentation, "discovery.documentation");
  documentationUrl(value.authentication?.documentation, "discovery.authentication.documentation");
  requireThat(Array.isArray(value.authentication?.schemes) && value.authentication.schemes.length > 0 &&
    value.authentication.schemes.every((s) => typeof s === "string" && s.length > 0),
  "discovery", "missing authentication schemes");
  requireThat(["offerings", "previews", "privateInputs"].every((k) => typeof value.capabilities?.[k] === "boolean"),
    "discovery", "missing capability declarations");
  requireThat(["maxRequestBytes", "maxPageSize", "replayWindowSeconds"].every((k) =>
    Number.isSafeInteger(value.limits?.[k]) && value.limits[k] > 0), "discovery", "invalid limits");
  return value.baseUrl;
}

function inspectResource(resource, fixture, uid, generation, operationId, step) {
  requireThat(isToken(resource?.uid) && resource.uid === uid && resource.form === fixture.form && resource.space === fixture.space &&
    resource.name === fixture.name, step, "Resource identity changed");
  requireThat(resource.generation === generation && resource.lastOperation === operationId,
    step, "Resource generation or lastOperation changed");
  requireThat(Number.isSafeInteger(resource.observedGeneration) && resource.observedGeneration >= 0 &&
    resource.observedGeneration <= generation && isRecord(resource.spec) && isRecord(resource.observed) &&
    isRecord(resource.output) && resourcePhases.has(resource.phase) &&
    (resource.observedAt === null || isUtcTimestamp(resource.observedAt)),
    step, "invalid Resource observation");
  if (fixture.expectedSpec !== undefined) {
    requireThat(JSON.stringify(canonicalJson(resource.spec)) === JSON.stringify(canonicalJson(fixture.expectedSpec)),
      step, "Resource spec differs from caller-expected spec");
  }
  if (fixture.assertResource !== undefined) {
    let passed = false;
    try { passed = fixture.assertResource(resource) === true; } catch { /* caller detail may contain private data */ }
    requireThat(passed, step, "caller Resource assertion failed");
  }
}

function inspectOperation(op, action, uid, generation, step) {
  requireThat(isToken(op?.id) && isToken(op.resourceUid) && op.resourceUid === uid &&
    op.action === action && op.generation === generation && operationStates.has(op.status),
    step, "Operation identity, generation, or state is invalid");
  requireThat(["none", "unknown", "partial", "complete"].includes(op.effect), step, "invalid Operation effect");
  for (const field of ["createdAt", "updatedAt", "retainUntil"]) {
    requireThat(isUtcTimestamp(op[field]),
      step, `invalid ${field}`);
  }
  if (op.status === "succeeded") requireThat(op.effect === "complete", step, "successful Operation has incomplete effect");
  if (op.status === "failed") requireThat(["none", "partial"].includes(op.effect) && op.error?.code,
    step, "failed Operation has invalid effect or missing error");
  if (op.status === "reconciling") requireThat(op.effect !== "none", step, "reconciling Operation has known absent effect");
}

/**
 * Probe one caller-owned disposable Form fixture using HTTP-shaped Response objects.
 * `transport` receives {method,url,headers,body}; it owns authentication and network access.
 * A passing baseline never means full Host or Form conformance.
 */
export async function runHostApiV2({ origin, transport, fixture, maxPolls = 10, timeoutMs = 10000, pollDelayMs = 0, wait } = {}) {
  requireThat(typeof transport === "function", "setup", "an injected transport is required");
  validFixture(fixture);
  const originUrl = httpsUrl(origin, "setup.origin");
  requireThat(originUrl.origin === origin && originUrl.pathname === "/", "setup.origin", "expected a bare HTTPS origin");
  requireThat(Number.isSafeInteger(maxPolls) && maxPolls >= 1 && maxPolls <= 100 &&
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000 &&
    Number.isSafeInteger(pollDelayMs) && pollDelayMs >= 0 && pollDelayMs <= 60000,
    "setup", "invalid finite polling bounds");
  const sleep = wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  requireThat(typeof sleep === "function", "setup", "wait must be a function");

  async function request(step, method, url, { headers = {}, body, statuses = [200] } = {}) {
    const controller = new AbortController();
    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error(`v2 HTTP baseline ${step}: transport deadline exceeded`)), timeoutMs);
    });
    let result;
    try {
      result = await Promise.race([(async () => {
        const response = await transport({ method, url, headers, body,
          authenticated: step !== "discovery", signal: controller.signal });
        requireThat(response instanceof Response, step, "transport must return a Response");
        requireThat(statuses.includes(response.status), step, `unexpected HTTP ${response.status}`);
        const media = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        requireThat(media === (response.status >= 400 ? "application/problem+json" : "application/json"),
          step, "wrong response media type");
        const value = await response.json();
        return { response, value };
      })(), deadline]);
    } catch (cause) {
      if (cause instanceof BaselineFailure) throw cause;
      throw new Error(`v2 HTTP baseline ${step}: transport, status, or body failed`);
    } finally { clearTimeout(deadlineTimer); controller.abort(); }
    return result;
  }

  async function error(step, method, url, options, status, code) {
    const { value } = await request(step, method, url, { ...options, statuses: [status] });
    requireThat(value?.type === "about:blank" && typeof value.title === "string" &&
      value.status === status && value.code === code, step, `expected Problem ${code}`);
  }

  const discovery = (await request("discovery", "GET", `${origin}/.well-known/takoform/v2`)).value;
  const base = validDiscovery(discovery, origin);
  const supportUrl = (form) => `${base}/support?form=${encodeURIComponent(form)}`;
  const support = (await request("support", "GET", supportUrl(fixture.form))).value;
  requireThat(support?.form === fixture.form && support.supported === true &&
    Array.isArray(support.operations) && ["create", "read", "update", "delete"].every((op) => support.operations.includes(op)),
    "support", "fixture Form lacks mandatory operations");
  const unknown = (await request("unknown-support", "GET", supportUrl(fixture.unknownForm))).value;
  requireThat(unknown?.form === fixture.unknownForm && unknown.supported === false &&
    Array.isArray(unknown.operations) && unknown.operations.length === 0 && unknown.privateInputs === false,
    "unknown-support", "unknown Form must be unsupported");
  if (fixture.privateInputs !== undefined) {
    requireThat(discovery.capabilities.privateInputs && support.privateInputs === true,
      "fixture", "private inputs require both capability declarations");
  }

  let offering;
  if (discovery.capabilities.offerings) {
    requireThat(fixture.offering && isToken(fixture.offering.id) &&
      typeof fixture.offering.revision === "string" && fixture.offering.revision.length > 0,
      "fixture", "Host requires a caller-selected Offering");
    offering = fixture.offering;
    const query = new URLSearchParams({ form: fixture.form, space: fixture.space });
    let cursor;
    let found = false;
    for (let page = 0; page < 20 && !found; page++) {
      if (cursor) query.set("cursor", cursor);
      const offerings = (await request("offerings", "GET", `${base}/offerings?${query}`)).value;
      requireThat(Array.isArray(offerings?.items) &&
        (offerings.nextCursor === null || typeof offerings.nextCursor === "string"),
        "offerings", "invalid Offering page");
      found = offerings.items.some((item) => item.id === offering.id &&
        item.revision === offering.revision && item.form === fixture.form);
      cursor = offerings.nextCursor;
      if (!cursor) break;
    }
    requireThat(found, "offerings", "selected Offering not found within page bound");
  } else {
    requireThat(fixture.offering === undefined, "fixture", "offering supplied to a Host without Offerings");
  }

  const createBody = { form: fixture.form, space: fixture.space, name: fixture.name,
    ...(offering && { offering }), spec: fixture.spec,
    ...(fixture.privateInputs !== undefined && { privateInputs: fixture.privateInputs }) };
  const key = () => randomUUID();
  const unknownBody = { ...createBody, form: fixture.unknownForm, name: `${fixture.name}-unknown` };
  await error("unknown-create", "POST", `${base}/resources`,
    { headers: { "Content-Type": "application/json", "Idempotency-Key": key() }, body: unknownBody },
    422, "unsupported_form");

  async function mutation(step, method, url, headers, body, action, uid, generation) {
    const { response, value } = await request(step, method, url, { headers, body, statuses: [200, 202] });
    inspectOperation(value, action, uid ?? value.resourceUid, generation, step);
    requireThat((response.status === 200) === ["succeeded", "failed"].includes(value.status),
      step, "HTTP status does not match Operation terminality");
    requireThat(response.headers.get("location") === `${base}/operations/${value.id}`, step, "invalid Location");
    if (response.status === 202) requireThat(Number(response.headers.get("retry-after")) > 0,
      step, "202 requires positive Retry-After");
    return value;
  }
  async function settle(step, initial, action, uid, generation) {
    let op = initial;
    for (let index = 0; index < maxPolls; index++) {
      if (index > 0 && pollDelayMs) await sleep(pollDelayMs);
      op = (await request(`${step}-poll`, "GET", `${base}/operations/${initial.id}`)).value;
      inspectOperation(op, action, uid, generation, `${step}-poll`);
      requireThat(op.id === initial.id, `${step}-poll`, "Operation ID changed");
      if (["succeeded", "failed"].includes(op.status)) break;
    }
    requireThat(op.status === "succeeded", step, "Operation did not succeed within polling bound");
    requireThat(Date.parse(op.retainUntil) - Date.parse(op.updatedAt) >=
      discovery.limits.replayWindowSeconds * 1000, step, "terminal retention shorter than replay window");
    return op;
  }

  const createHeaders = { "Content-Type": "application/json", "Idempotency-Key": key() };
  const created = await mutation("create", "POST", `${base}/resources`, createHeaders, createBody, "create", undefined, 1);
  requireThat(isToken(created.resourceUid), "create", "invalid Resource UID");
  await settle("create", created, "create", created.resourceUid, 1);
  const replay = await mutation("create-replay", "POST", `${base}/resources`, createHeaders, createBody,
    "create", created.resourceUid, 1);
  requireThat(replay.id === created.id, "create-replay", "same key created another Operation");
  await error("changed-input", "POST", `${base}/resources`, { headers: createHeaders,
    body: { ...createBody, name: `${fixture.name}-changed` } }, 409, "idempotency_conflict");

  const resourceUrl = `${base}/resources/${created.resourceUid}`;
  const read = (await request("read", "GET", resourceUrl)).value;
  inspectResource(read, fixture, created.resourceUid, 1, created.id, "read");
  if (offering) requireThat(read.offering?.id === offering.id && read.offering.revision === offering.revision,
    "read", "selected Offering changed");
  else requireThat(read.offering === undefined, "read", "unexpected Offering");
  const listQuery = new URLSearchParams({ space: fixture.space, name: fixture.name, form: fixture.form });
  const list = (await request("list", "GET", `${base}/resources?${listQuery}`)).value;
  requireThat(Array.isArray(list?.items) && list.items.some((item) => item.uid === created.resourceUid) &&
    (list.nextCursor === null || typeof list.nextCursor === "string"), "list", "created Resource missing from list");

  const staleHeaders = { "Content-Type": "application/json", "Idempotency-Key": key(),
    "Takoform-Expected-Generation": "0" };
  const updateBody = { spec: fixture.spec,
    ...(fixture.privateInputs !== undefined && { privateInputs: fixture.privateInputs }) };
  await error("stale-generation", "PUT", resourceUrl, { headers: staleHeaders, body: updateBody },
    409, "generation_conflict");
  inspectResource((await request("read-after-stale", "GET", resourceUrl)).value,
    fixture, created.resourceUid, 1, created.id, "read-after-stale");
  const updateHeaders = { ...staleHeaders, "Idempotency-Key": key(), "Takoform-Expected-Generation": "1" };
  const updated = await mutation("update", "PUT", resourceUrl, updateHeaders, updateBody,
    "update", created.resourceUid, 2);
  await settle("update", updated, "update", created.resourceUid, 2);
  requireThat(updated.id !== created.id, "update", "new key reused prior Operation");
  inspectResource((await request("read-after-update", "GET", resourceUrl)).value,
    fixture, created.resourceUid, 2, updated.id, "read-after-update");

  const deleteHeaders = { "Idempotency-Key": key(), "Takoform-Expected-Generation": "2" };
  const deleted = await mutation("delete", "DELETE", resourceUrl, deleteHeaders, undefined,
    "delete", created.resourceUid, 3);
  await settle("delete", deleted, "delete", created.resourceUid, 3);
  requireThat(deleted.id !== updated.id, "delete", "new key reused prior Operation");
  const gone = await request("read-after-delete", "GET", resourceUrl, { statuses: [404, 410] });
  requireThat(gone.value?.type === "about:blank" && gone.value.status === gone.response.status &&
    ["not_found", "gone"].includes(gone.value.code), "read-after-delete", "invalid absence Problem");
  const afterList = (await request("list-after-delete", "GET", `${base}/resources?${listQuery}`)).value;
  requireThat(Array.isArray(afterList?.items) && !afterList.items.some((item) => item.uid === created.resourceUid),
    "list-after-delete", "deleted Resource remains listed");
  const deleteReplay = await mutation("delete-replay", "DELETE", resourceUrl, deleteHeaders, undefined,
    "delete", created.resourceUid, 3);
  requireThat(deleteReplay.id === deleted.id, "delete-replay", "same key did not recover deleted Operation");

  return {
    baseline: "passed", fullConformance: false,
    gaps: { restart: "not-tested", faultInjection: "not-tested", concurrentRequests: "not-tested",
      crossPrincipal: "not-tested", optionalFeatures: "not-tested", formSpecific: "not-tested" },
  };
}
