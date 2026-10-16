import { expect, test } from "bun:test";
import { ApiError, createApi } from "../console/src/api.ts";
import { explain } from "../console/src/ui.ts";

const DETAIL =
  "A WorkerEndpoint needs its Worker's active WorkerDeployment, not being deleted, whose every weighted WorkerVersion declares fetch or serves assets, and no other WorkerEndpoint on that Worker. Create the WorkerDeployment first, then send this request again.";

/** What the console makes of one refused Host API v2 read. */
async function refused(body: unknown, status = 409): Promise<ApiError> {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/problem+json" },
      }),
    { preconnect: original.preconnect },
  );
  try {
    const api = createApi({
      origin: "https://api.example.test",
      token: () => null,
      onSessionLost: () => undefined,
    });
    await api.resource("org-console", "uid-one");
  } catch (error) {
    return error as ApiError;
  } finally {
    globalThis.fetch = original;
  }
  throw new Error("the read was not refused");
}

test("keeps the Host's own explanation of a refusal", async () => {
  const problem = { type: "about:blank", title: "Conflict", status: 409 };
  const explained = await refused({ ...problem, code: "dependency_conflict", detail: DETAIL });
  expect(explained.code).toBe("dependency_conflict");
  expect(explained.detail).toBe(DETAIL);
  expect((await refused({ ...problem, code: "resource_busy" })).detail).toBeNull();
  // Anything but a bounded string is not shown to a person.
  expect((await refused({ ...problem, code: "resource_busy", detail: 7 })).detail).toBeNull();
  expect(
    (await refused({ ...problem, code: "resource_busy", detail: "x".repeat(1025) })).detail,
  ).toBeNull();
});

test("says what to do for the refusals a Resource change meets", () => {
  const said = (code: string) => explain(new ApiError(code, 409, "/apis/forms.takoform.com/v2"));
  expect(said("name_conflict")).toBe(
    "Another Resource in this organization already has that name, whatever its Form. Choose another name.",
  );
  expect(said("resource_busy")).toBe(
    "This Resource, or one it depends on, is still applying an earlier change. Try again once it finishes.",
  );
  expect(said("idempotency_conflict")).toBe(
    "A different request was already sent under the same key. Close this dialog and start again; a new one uses a new key.",
  );
  expect(said("generation_conflict")).toBe(
    "This Resource changed after the page read it. Reload, check it, and try again.",
  );
  expect(said("dependency_conflict")).toStartWith(
    "Another Resource stands in the way of this change. For example, one it names does not exist yet",
  );
  expect(said("invalid_spec")).toStartWith("This Host does not accept that spec for the Form.");
  expect(said("unsupported_form")).toBe("This Host does not serve that exact Form.");
  // A code the console does not know is still shown, so it can be quoted.
  expect(said("private_inputs_conflict")).toBe("The server refused this: private_inputs_conflict");
});

test("lets the Host's explanation speak for itself, with its code", () => {
  const error = new ApiError("dependency_conflict", 409, "/apis/forms.takoform.com/v2", DETAIL);
  expect(explain(error)).toBe(`${DETAIL} (dependency_conflict)`);
});

test("keeps an explanation the Host's limit allows", async () => {
  const long = "x".repeat(1024);
  const explained = await refused({ status: 409, code: "dependency_conflict", detail: long });
  expect(explained.detail).toBe(long);
  // An unknown code with a detail still names its code.
  expect(explain(new ApiError("private_inputs_conflict", 409, "/v2", "Why."))).toBe(
    "Why. (private_inputs_conflict)",
  );
});
