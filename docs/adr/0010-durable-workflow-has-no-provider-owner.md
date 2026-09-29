# ADR 0010 — DurableWorkflow provider ownership: implementation observation

**Status:** dated implementation observation, 2026-09-29

This record captures the implementation and composition inspected on
2026-09-29. It is not a permanent decision that no backend or execution
primitive can support the published Form, and it does not reinterpret or amend
that Form's published contract. The current product contract remains owned by
the published Takoform specification.

## Observation

On the observation date, the inspected provider implementations did not claim
the published `edge.forms.takoform.com/DurableWorkflow@0.1.0` identity. The
credential-free `GET /v1/forms` route fixture used by the contract test listed
the identity and reported its availability fields as false. This describes
those inspected sources and that fixture, not every lane, future composition,
or possible implementation.

The source evidence inspected on that date was:

| Observation | Evidence |
| --- | --- |
| The publisher projection included `DurableWorkflow@0.1.0` | `src/takoform/current-candidates.ts` and generated publisher package projection |
| Provider availability was derived from intrinsic handlers and composed offerings | `src/provider-driver.ts` (`createProviderFormAvailability`) |
| The in-tree self-host and Cloudflare provider implementations refused the workflow binding | `src/providers/selfhost.ts` and `src/providers/cloudflare.ts` |
| Internal workflow execution components existed but were documented as inactive and not composed into a serving entrypoint | `src/workflow-execution.ts`, `src/workflow-runtime.ts`, and `docs/workflow-runtime.md` |
| The control catalogue projected optional availability fields from the resolver when present | `src/control.ts` and `src/app.ts` |

The available source also identified a contract question around a host
acknowledging that one identified execution has stopped. That is evidence
about the inspected implementation's qualification gap; it does not establish
that no existing or future primitive can provide the behavior.

## Follow-up contract surface

The control-plane `GET /v1/forms` response is described in its OpenAPI document
as a catalogue of published Form profiles. The profile's optional
`executable`, `activated`, and `availableToPrincipal` fields are separate
answers. In particular, `executable` reports composed execution support; it
does not guarantee activation, principal authorization, or successful
execution. The endpoint is not the frozen Takoform Host API under
`/apis/forms.takoform.com/v1/...`.

The implementation-level observation should be rechecked against current
source before reuse. A change in provider composition or runtime qualification
can make it stale without changing the published Form contract.
