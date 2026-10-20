/** Authenticated staging billing journey. Importing this module has no effects. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceBillingOrganizationRef } from "../src/workspace-billing-organization.ts";
import { type DeployTarget, loadTarget } from "./deploy/target.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA = /^sha256:[0-9a-f]{64}$/u;
const HEAD = /^[0-9a-f]{40}$/u;
const JOURNAL_KIND = "takoserver.hosted-billing-business-e2e-journal@v1";
const INPUT_KIND = "takoserver.hosted-billing-business-e2e-input@v1";
// Accounts issues shared-auth Workspace refs in this namespace; their billing
// Organization is derived and created at the owner's first login, never here.
const SHARED_WORKSPACE_REF = /^wrk_[0-9a-f]{32}$/u;
type ObjectValue = Record<string, unknown>;
type Step = "personal" | "usage" | "subscription" | "topup";
type Event =
  | {
      kind: typeof JOURNAL_KIND;
      inputSha256: string;
      targetSha256: string;
      sourceHead: string;
      origin: string;
    }
  | { kind: "intent"; step: Step; organizationId: string | null; body: ObjectValue }
  | { kind: "ack"; step: Step; organizationId?: string }
  | { kind: "select"; step: "personal"; organizationId: string; source: "shared-workspace" };

export interface BusinessInput {
  readonly kind: typeof INPUT_KIND;
  readonly sourceHead: string;
  readonly targetSha256: string;
  readonly usage: {
    readonly reference: string;
    readonly meter: string;
    readonly quantityUnit: string;
    readonly quantity: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly pricingRevision: string;
    readonly expectedMicros: string;
    readonly measurementFingerprint: string;
    readonly workspaceRef: string;
  };
  readonly subscription: { readonly reference: string; readonly planKey: string };
  readonly topup: { readonly reference: string; readonly amountMinor: number };
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid input object");
  return value as ObjectValue;
}

function keys(value: ObjectValue, expected: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    throw new Error("input has missing or unexpected fields");
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid input string");
  return value;
}

function reference(value: unknown): string {
  const result = string(value);
  if (!REFERENCE.test(result)) throw new Error("invalid billing reference");
  return result;
}

export function parseBusinessInput(raw: string): BusinessInput {
  const input = object(JSON.parse(raw));
  keys(input, ["kind", "sourceHead", "targetSha256", "usage", "subscription", "topup"]);
  if (
    input.kind !== INPUT_KIND ||
    !HEAD.test(string(input.sourceHead)) ||
    !SHA.test(string(input.targetSha256))
  )
    throw new Error("invalid input identity");
  const usage = object(input.usage);
  keys(usage, [
    "reference",
    "meter",
    "quantityUnit",
    "quantity",
    "periodStart",
    "periodEnd",
    "pricingRevision",
    "expectedMicros",
    "measurementFingerprint",
    "workspaceRef",
  ]);
  reference(usage.reference);
  reference(usage.workspaceRef);
  if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(string(usage.meter)) || string(usage.meter).includes(".."))
    throw new Error("invalid meter");
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(string(usage.quantityUnit)))
    throw new Error("invalid quantity unit");
  if (
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,17}[1-9])?$/u.test(string(usage.quantity)) ||
    string(usage.quantity).length > 256
  )
    throw new Error("invalid quantity");
  for (const field of ["periodStart", "periodEnd"] as const) {
    const instant = string(usage[field]);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant) ||
      !Number.isFinite(Date.parse(instant)) ||
      new Date(instant).toISOString() !== instant
    )
      throw new Error(`invalid ${field}`);
  }
  if (string(usage.periodStart) >= string(usage.periodEnd))
    throw new Error("usage period is not closed");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(string(usage.pricingRevision)))
    throw new Error("invalid pricing revision");
  if (
    string(usage.measurementFingerprint).length > 256 ||
    Array.from(string(usage.measurementFingerprint)).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new Error("invalid measurement fingerprint");
  if (
    !/^(0|[1-9][0-9]*)$/u.test(string(usage.expectedMicros)) ||
    string(usage.expectedMicros).length > 16
  )
    throw new Error("invalid expected micros");
  const subscription = object(input.subscription);
  keys(subscription, ["reference", "planKey"]);
  reference(subscription.reference);
  string(subscription.planKey);
  const topup = object(input.topup);
  keys(topup, ["reference", "amountMinor"]);
  reference(topup.reference);
  if (!Number.isSafeInteger(topup.amountMinor) || (topup.amountMinor as number) <= 0)
    throw new Error("invalid top-up amount");
  return input as unknown as BusinessInput;
}

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function outsideRepository(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("private path must be normalized and absolute");
  if (/[\r\n\0]/u.test(path)) throw new Error("private path contains control characters");
  const rel = relative(ROOT, path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
    throw new Error("private path must be outside the repository");
}

export function readPrivateFile(path: string): string {
  outsideRepository(path);
  if (realpathSync(path) !== path) throw new Error("private file path must not traverse symlinks");
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("private file must be owned regular 0600-or-stricter file");
  return readFileSync(path, "utf8");
}

function journalParent(path: string): void {
  outsideRepository(path);
  const parent = resolve(path, "..");
  if (realpathSync(parent) !== parent) throw new Error("journal parent must not traverse symlinks");
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("journal parent must be an owned 0700-or-stricter directory");
}

function syncParent(path: string): void {
  const fd = openSync(resolve(path, ".."), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeFully(fd: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset)
      throw new Error("private file write incomplete");
    offset += written;
  }
}

function append(path: string, event: Event): void {
  const fd = openSync(path, "a", 0o600);
  try {
    if ((lstatSync(path).mode & 0o077) !== 0) throw new Error("journal permissions changed");
    writeFully(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function journal(path: string): Event[] {
  const raw = readPrivateFile(path);
  if (!raw.endsWith("\n")) throw new Error("journal has a torn final record");
  const records = raw
    .trimEnd()
    .split("\n")
    .map((line) => object(JSON.parse(line)));
  const initial = records[0];
  if (!initial || initial.kind !== JOURNAL_KIND) throw new Error("invalid journal");
  keys(initial, ["kind", "inputSha256", "targetSha256", "sourceHead", "origin"]);
  const inputSha256 = string(initial.inputSha256);
  const targetSha256 = string(initial.targetSha256);
  const sourceHead = string(initial.sourceHead);
  if (!SHA.test(inputSha256) || !SHA.test(targetSha256) || !HEAD.test(sourceHead))
    throw new Error("invalid journal identity");
  const events: Event[] = [
    {
      kind: JOURNAL_KIND,
      inputSha256,
      targetSha256,
      sourceHead,
      origin: string(initial.origin),
    },
  ];
  const steps: readonly Step[] = ["personal", "usage", "subscription", "topup"];
  let next = 0;
  let pending: Step | undefined;
  let organizationId: string | undefined;
  for (const event of records.slice(1)) {
    if (event.kind === "intent") {
      keys(event, ["kind", "step", "organizationId", "body"]);
      const step = steps[next];
      if (!step || pending !== undefined || event.step !== step)
        throw new Error("invalid journal mutation sequence");
      const selectedOrg = step === "personal" ? null : organizationId;
      if (selectedOrg === undefined || event.organizationId !== selectedOrg)
        throw new Error("journal Organization binding differs");
      events.push({
        kind: "intent",
        step,
        organizationId: selectedOrg,
        body: object(event.body),
      });
      pending = step;
    } else if (event.kind === "select") {
      // A shared-auth Workspace's derived Organization is selected, not created.
      keys(event, ["kind", "step", "organizationId", "source"]);
      if (next !== 0 || pending !== undefined || event.step !== "personal")
        throw new Error("invalid journal selection sequence");
      if (event.source !== "shared-workspace") throw new Error("invalid journal selection");
      organizationId = reference(event.organizationId);
      if (!organizationId.startsWith("org_wb_")) throw new Error("invalid journal Organization");
      events.push({
        kind: "select",
        step: "personal",
        organizationId,
        source: "shared-workspace",
      });
      next++;
    } else if (event.kind === "ack") {
      if (pending === undefined || event.step !== pending)
        throw new Error("orphan or out-of-order mutation acknowledgement");
      if (pending === "personal") {
        keys(event, ["kind", "step", "organizationId"]);
        organizationId = reference(event.organizationId);
        if (!organizationId.startsWith("org_")) throw new Error("invalid journal Organization");
        events.push({ kind: "ack", step: pending, organizationId });
      } else {
        keys(event, ["kind", "step"]);
        events.push({ kind: "ack", step: pending });
      }
      pending = undefined;
      next++;
    } else throw new Error("invalid journal event");
  }
  return events;
}

function lockJournal<T>(path: string, action: () => Promise<T>): Promise<T> {
  journalParent(path);
  mkdirSync(`${path}.lock`, { mode: 0o700 });
  return action().finally(() => rmdirSync(`${path}.lock`));
}

export function assertStagingTarget(
  target: Pick<DeployTarget, "environment" | "hostedBilling" | "publicOrigin">,
): string {
  if (target.environment !== "integration" && target.environment !== "rehearsal")
    throw new Error("production target refused");
  if (
    target.hostedBilling?.selector !== "canonical-test" ||
    target.hostedBilling.stripeMode !== "test"
  )
    throw new Error("target is not canonical Stripe TEST billing");
  const origin = new URL(target.publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== target.publicOrigin ||
    origin.pathname !== "/"
  )
    throw new Error("target origin must be an exact HTTPS origin");
  return origin.origin;
}

class BillingHttpStatusError extends Error {
  readonly #diagnostic: string;

  constructor(method: "GET" | "POST", status: number) {
    super(`HTTP ${status}; original mutation must not be retried`);
    const methodLabel = method === "GET" || method === "POST" ? method : "request";
    const statusLabel =
      Number.isInteger(status) && status >= 100 && status <= 599 ? status : "unknown";
    this.#diagnostic = `HTTP ${methodLabel} ${statusLabel}.`;
  }

  static diagnostic(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && #diagnostic in error
      ? error.#diagnostic
      : undefined;
  }
}

export class BillingHttp {
  constructor(
    readonly origin: string,
    private readonly session: string,
    private readonly fetcher: (request: Request) => Promise<Response> = (request) => fetch(request),
  ) {
    if (!/^https:\/\/[^/]+$/u.test(origin) || !session || /[\r\n]/u.test(session))
      throw new Error("invalid HTTP client configuration");
  }

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<ObjectValue> {
    if (!path.startsWith("/v1/") || path.startsWith("//") || /[#]/u.test(path))
      throw new Error("invalid API path");
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error("cross-origin request refused");
    let response: Response;
    try {
      const request = new Request(url, {
        method,
        headers: {
          authorization: `Bearer ${this.session}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      response = await this.fetcher(request);
    } catch {
      throw new Error("HTTP outcome unknown; inspect journal and use verify only");
    }
    if (
      response.redirected ||
      (response.url && response.url !== url.href) ||
      (response.status >= 300 && response.status < 400)
    )
      throw new Error("redirect or response-origin mismatch refused");
    if (!response.ok) throw new BillingHttpStatusError(method, response.status);
    try {
      return object(await response.json());
    } catch {
      throw new Error("HTTP response shape unknown; original mutation must not be retried");
    }
  }
}

function orgPath(org: string, suffix: string): string {
  return `/v1/organizations/${encodeURIComponent(org)}/${suffix}`;
}

function usageProjectionMatches(
  value: unknown,
  organizationId: string,
  input: BusinessInput,
): boolean {
  const receipt = object(value);
  const usage = input.usage;
  return (
    receipt.organizationId === organizationId &&
    receipt.reference === usage.reference &&
    receipt.workspaceRef === usage.workspaceRef &&
    receipt.meter === usage.meter &&
    receipt.quantityUnit === usage.quantityUnit &&
    receipt.quantity === usage.quantity &&
    receipt.periodStart === usage.periodStart &&
    receipt.periodEnd === usage.periodEnd &&
    receipt.pricingRevision === usage.pricingRevision &&
    receipt.amountMicros === usage.expectedMicros
  );
}

function subscriptionCheckout(value: unknown): { readonly url?: string } {
  const checkout = object(value);
  const state = checkout.state;
  string(checkout.id);
  if (state === "open") {
    keys(checkout, ["state", "id", "url"]);
    string(checkout.url);
    return checkout as { readonly url: string };
  }
  if (state === "associated") {
    keys(
      checkout,
      checkout.url === undefined
        ? ["state", "id", "subscriptionRef"]
        : ["state", "id", "subscriptionRef", "url"],
    );
    string(checkout.subscriptionRef);
    if (checkout.url !== undefined) string(checkout.url);
    return checkout as { readonly url?: string };
  }
  if (state === "pending" || state === "expired") {
    keys(checkout, ["state", "id"]);
    return checkout as { readonly url?: string };
  }
  throw new Error("subscription Checkout response invalid");
}

async function mutate(
  path: string,
  step: Step,
  client: BillingHttp,
  endpoint: string,
  body: ObjectValue,
  organizationId: string | null,
): Promise<ObjectValue> {
  append(path, { kind: "intent", step, organizationId, body });
  return await client.request("POST", endpoint, body);
}

function ack(path: string, step: Step, organizationId?: string): void {
  append(path, { kind: "ack", step, ...(organizationId === undefined ? {} : { organizationId }) });
}

/**
 * The Organization a shared-auth Workspace bills: derived from the target's
 * billing authority and the Workspace ref, and present in the session's own
 * Organizations because the owner's first login created it. Personal
 * Organizations are only for google/github principals, so a shared-auth
 * session never creates one. Returns null for an ordinary opaque Workspace ref.
 */
export async function sharedWorkspaceOrganization(
  input: BusinessInput,
  billingAuthority: string | undefined,
  organizations: unknown,
): Promise<string | null> {
  if (!SHARED_WORKSPACE_REF.test(input.usage.workspaceRef)) return null;
  if (billingAuthority === undefined)
    throw new Error("shared Workspace journey requires the target billing authority");
  const derived = await workspaceBillingOrganizationRef(billingAuthority, input.usage.workspaceRef);
  if (
    !Array.isArray(organizations) ||
    !organizations.some((organization) => object(organization).id === derived)
  )
    throw new Error("session does not own the shared Workspace billing Organization");
  return derived;
}

export async function runStart(options: {
  readonly journalPath: string;
  readonly inputRaw: string;
  readonly targetSha256: string;
  readonly origin: string;
  readonly client: BillingHttp;
  readonly handoffPath: string;
  readonly billingAuthority?: string;
}): Promise<void> {
  const { journalPath: path, inputRaw, targetSha256, origin, client, handoffPath } = options;
  const input = parseBusinessInput(inputRaw);
  await lockJournal(path, async () => {
    if (existsSync(path)) throw new Error("journal already exists; only verify is allowed");
    for (const suffix of ["subscription", "topup"]) {
      const handoff = `${handoffPath}.${suffix}.url`;
      journalParent(handoff);
      if (existsSync(handoff)) throw new Error("Checkout handoff already exists");
    }
    const me = await client.request("GET", "/v1/me");
    object(me.principal);
    if (!Array.isArray(me.organizations)) throw new Error("session preflight response invalid");
    const shared = await sharedWorkspaceOrganization(
      input,
      options.billingAuthority,
      me.organizations,
    );
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    append(path, {
      kind: JOURNAL_KIND,
      inputSha256: digest(inputRaw),
      targetSha256,
      sourceHead: input.sourceHead,
      origin,
    });
    syncParent(path);
    let org: string;
    if (shared !== null) {
      append(path, {
        kind: "select",
        step: "personal",
        organizationId: shared,
        source: "shared-workspace",
      });
      org = shared;
    } else {
      const personal = await mutate(
        path,
        "personal",
        client,
        "/v1/organizations/personal",
        {},
        null,
      );
      org = reference(object(personal.organization).id);
      if (!org.startsWith("org_")) throw new Error("personal Organization response invalid");
      ack(path, "personal", org);
    }
    await client.request("GET", orgPath(org, "wallet"));
    await client.request("GET", orgPath(org, "wallet/usage-summary"));
    await client.request("GET", orgPath(org, "wallet/usage-summary/workspaces"));
    const subscription = await client.request("GET", orgPath(org, "payments/subscription"));
    if (
      !Array.isArray(object(subscription.planTable).plans) ||
      !(subscription.planTable as { plans: ObjectValue[] }).plans.some(
        (plan) => plan.planId === input.subscription.planKey,
      )
    )
      throw new Error("selected plan is absent from the target plan table");
    const usage = await mutate(
      path,
      "usage",
      client,
      orgPath(org, "wallet/usage-records"),
      input.usage,
      org,
    );
    if (!usageProjectionMatches(usage.usageRecord, org, input))
      throw new Error("usage acknowledgement mismatch");
    ack(path, "usage");
    const started = await mutate(
      path,
      "subscription",
      client,
      orgPath(org, "payments/subscription"),
      input.subscription,
      org,
    );
    const checkout = subscriptionCheckout(started.checkout);
    checkoutUrl(checkout, checkout.url !== undefined);
    ack(path, "subscription");
    saveCheckoutHandoff(`${handoffPath}.subscription.url`, checkout);
    const topup = await mutate(
      path,
      "topup",
      client,
      orgPath(org, "wallet/checkout"),
      input.topup,
      org,
    );
    checkoutUrl(topup.checkout, true);
    ack(path, "topup");
    saveCheckoutHandoff(`${handoffPath}.topup.url`, topup.checkout);
  });
}

function checkoutUrl(checkout: unknown, required: boolean): string | null {
  if (checkout === null || checkout === undefined) {
    if (required) throw new Error("Checkout URL missing");
    return null;
  }
  const candidate = object(checkout).url;
  if (candidate === undefined || candidate === null) {
    if (required) throw new Error("Checkout URL missing");
    return null;
  }
  const url = string(candidate);
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://checkout.stripe.com" ||
    !parsed.pathname.startsWith("/c/pay/") ||
    parsed.pathname === "/c/pay/" ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Checkout URL is not an expected Stripe HTTPS URL");
  return url;
}

function saveCheckoutHandoff(path: string, checkout: unknown): void {
  const url = checkoutUrl(checkout, false);
  if (url === null) return;
  journalParent(path);
  if (existsSync(path)) {
    if (readPrivateFile(path) !== `${url}\n`)
      throw new Error("existing Checkout handoff differs from original receipt");
    return;
  }
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFully(fd, `${url}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncParent(path);
}

export async function runVerify(options: {
  readonly journalPath: string;
  readonly inputRaw: string;
  readonly targetSha256: string;
  readonly origin: string;
  readonly client: BillingHttp;
  readonly handoffPath: string;
}): Promise<ObjectValue> {
  const { journalPath: path, inputRaw, targetSha256, origin, client, handoffPath } = options;
  const input = parseBusinessInput(inputRaw);
  return await lockJournal(path, async () => {
    journalParent(`${handoffPath}.subscription.url`);
    journalParent(`${handoffPath}.topup.url`);
    const events = journal(path);
    const initial = events[0];
    if (
      initial?.kind !== JOURNAL_KIND ||
      initial.inputSha256 !== digest(inputRaw) ||
      initial.targetSha256 !== targetSha256 ||
      initial.sourceHead !== input.sourceHead ||
      initial.origin !== origin
    )
      throw new Error("original input, source, or target differs from journal");
    for (const event of events) {
      if (event.kind !== "intent") continue;
      const expected =
        event.step === "personal"
          ? {}
          : event.step === "usage"
            ? input.usage
            : event.step === "subscription"
              ? input.subscription
              : input.topup;
      if (JSON.stringify(event.body) !== JSON.stringify(expected))
        throw new Error("original command body differs from journal");
    }
    const personalAck = events.find(
      (event): event is Extract<Event, { kind: "ack" }> =>
        event.kind === "ack" && event.step === "personal",
    );
    const selected = events.find(
      (event): event is Extract<Event, { kind: "select" }> => event.kind === "select",
    );
    const org = personalAck?.organizationId ?? selected?.organizationId;
    if (!org) return { state: "unresolved-personal-ack", webhookProven: false };
    await client.request("GET", "/v1/me");
    const wallet = await client.request("GET", orgPath(org, "wallet"));
    const summary = await client.request("GET", orgPath(org, "wallet/usage-summary"));
    const workspace = await client.request(
      "GET",
      orgPath(
        org,
        `wallet/usage-summary/workspaces?workspaceRef=${encodeURIComponent(input.usage.workspaceRef)}`,
      ),
    );
    const subscription = await client.request("GET", orgPath(org, "payments/subscription"));
    const result: ObjectValue = {
      state: "readback-incomplete",
      organizationId: org,
      walletRead: object(wallet.wallet).organizationId === org,
      summaryRead: object(summary.usageSummary).organizationId === org,
      workspaceRead:
        Array.isArray(workspace.workspaces) &&
        workspace.workspaces.some((row) => object(row).workspaceRef === input.usage.workspaceRef),
      subscriptionRead: Object.hasOwn(subscription, "subscription"),
      webhookProven: false,
    };
    if (events.some((event) => event.kind === "intent" && event.step === "usage")) {
      let cursor: string | undefined;
      result.usagePublicFieldsMatch = false;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await client.request(
          "GET",
          orgPath(
            org,
            `wallet/usage-records?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        );
        if (!Array.isArray(page.usageRecords)) throw new Error("usage list response invalid");
        const original = page.usageRecords.find(
          (record) => object(record).reference === input.usage.reference,
        );
        if (original) {
          if (!usageProjectionMatches(original, org, input))
            throw new Error("usage receipt differs from original public fields");
          result.usagePublicFieldsMatch = true;
          break;
        }
        if (page.cursor === null || page.cursor === undefined) break;
        cursor = string(page.cursor);
      }
    }
    if (events.some((event) => event.kind === "intent" && event.step === "subscription")) {
      let command: ObjectValue | undefined;
      try {
        command = await client.request(
          "GET",
          orgPath(
            org,
            `payments/subscription/commands/start/${encodeURIComponent(input.subscription.reference)}`,
          ),
        );
      } catch {
        result.subscriptionCommandState = "unresolved";
      }
      if (command) {
        const receipt = object(command.receipt);
        if (
          receipt.reference !== input.subscription.reference ||
          receipt.organizationId !== org ||
          receipt.planKey !== input.subscription.planKey
        )
          throw new Error("subscription command readback differs from original");
        result.subscriptionCommandState = string(receipt.state);
        saveCheckoutHandoff(`${handoffPath}.subscription.url`, receipt.checkout);
      }
    }
    if (events.some((event) => event.kind === "intent" && event.step === "topup")) {
      const amountProven = events.some((event) => event.kind === "ack" && event.step === "topup");
      result.topupAmountProven = amountProven;
      let receipt: ObjectValue | undefined;
      try {
        // This GET may perform the owning service's Stripe readback and local acknowledgement.
        receipt = await client.request(
          "GET",
          orgPath(org, `wallet/checkout/${encodeURIComponent(input.topup.reference)}`),
        );
      } catch {
        result.topupState = "unresolved";
      }
      if (receipt) {
        if (receipt.reference !== input.topup.reference)
          throw new Error("top-up receipt readback differs from original");
        result.topupState = string(receipt.state);
        if (amountProven) saveCheckoutHandoff(`${handoffPath}.topup.url`, receipt.checkout);
      }
    }
    return result;
  });
}

function args(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || parsed[key]) throw new Error("invalid CLI arguments");
    parsed[key] = value;
  }
  const required = [
    "--phase",
    "--environment",
    "--target",
    "--input",
    "--session-file",
    "--journal",
    "--handoff",
  ];
  keys(parsed, required);
  return parsed;
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(
      "bun --no-env-file scripts/hosted-billing-business-e2e.ts --phase start|verify --environment integration|rehearsal --target ABS --input ABS --session-file ABS --journal ABS --handoff ABS\n",
    );
    return;
  }
  const flags = args(argv);
  const phase = flags["--phase"];
  const environment = flags["--environment"];
  if (
    (phase !== "start" && phase !== "verify") ||
    (environment !== "integration" && environment !== "rehearsal")
  )
    throw new Error("only explicit staging start or verify is supported");
  const targetPath = string(flags["--target"]);
  outsideRepository(targetPath);
  const targetRaw = readPrivateFile(targetPath);
  const target = loadTarget(targetPath, environment);
  if (readPrivateFile(targetPath) !== targetRaw)
    throw new Error("target descriptor changed during selection");
  const origin = assertStagingTarget(target);
  const inputRaw = readPrivateFile(string(flags["--input"]));
  const input = parseBusinessInput(inputRaw);
  const targetSha256 = digest(targetRaw);
  if (input.targetSha256 !== targetSha256)
    throw new Error("selected target differs from input pin");
  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (input.sourceHead !== actualHead) throw new Error("source HEAD differs from input pin");
  const session = readPrivateFile(string(flags["--session-file"])).trim();
  if (!session || /\s/u.test(session)) throw new Error("invalid session file");
  const options = {
    journalPath: string(flags["--journal"]),
    handoffPath: string(flags["--handoff"]),
    inputRaw,
    targetSha256,
    origin,
    client: new BillingHttp(origin, session),
    ...(target.hostedBilling === undefined
      ? {}
      : { billingAuthority: target.hostedBilling.billingAuthority }),
  };
  if (phase === "start") {
    await runStart(options);
    process.stdout.write(
      `Original commands recorded. Checkout handoffs: ${options.handoffPath}.subscription.url and ${options.handoffPath}.topup.url (when available). Complete TEST Checkout, then run verify.\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(await runVerify(options))}\n`);
  }
}

export function billingE2eFailureDiagnostic(error: unknown): string {
  const diagnostic = BillingHttpStatusError.diagnostic(error);
  return `Billing E2E refused or outcome unknown.${diagnostic ? ` ${diagnostic}` : ""} Inspect the private journal; do not repeat start.\n`;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(billingE2eFailureDiagnostic(error));
    process.exitCode = 1;
  });
}
