# Qualify one public AI inference

`scripts/ai-live-qualification.ts` checks a selected public AI model and one
idempotent completion replay. It is an opt-in operator client, not a deploy
surface, readiness gate, credential issuer, or wallet-funding tool.

## Inputs

Choose the exact Host origin, organization, public model, pricing revision and
maximum permitted charge. Obtain the pricing revision and advertised maximum
from the authenticated `/v1/ai/models` response. The selected API key needs
`ai:invoke` and `wallet:read` for that same organization.

Keep the key in a current-user-owned `0600` regular file in a current-user-owned
`0700` directory outside every Git checkout. Neither the path nor its ancestors
may be symlinks. The file contains only the key, without a trailing newline.
Do not pass the secret on the command line or commit it. This client does not
search environment variables, operator targets, or credential stores.

## Run

Inspect the actual CLI without network access:

```sh
bun scripts/ai-live-qualification.ts --help
```

Replace the placeholders below. Without `--execute-live`, this validates inputs
and returns `execution_not_requested`; it does not read the key or make any
request. This dry run is not evidence of a working deployment.

```sh
bun scripts/ai-live-qualification.ts \
  --origin https://api.example.test \
  --organization-id org_example \
  --public-model-id example-model \
  --pricing-revision 'sha256:REPLACE_WITH_64_HEX_DIGITS' \
  --maximum-charge-minor 1 \
  --idempotency-key qualification-unique-caller-chosen-key \
  --api-key-file /absolute/private/directory/api-key
```

Add `--execute-live` only when the paid probe is intended. The client checks
same-origin discovery, exact model/pricing, the model's advertised ceiling
against your budget, and the organization's available wallet balance. It then
sends one fixed non-streaming text prompt with `max_tokens: 1`. Only a valid
successful text completion permits one byte-identical request replay using the
same caller-chosen idempotency key. Replay must have identical response bytes,
request ID and billed amount. A model that returns no text does not pass this
particular text-inference check, even if it supports other valid completion modes.

## Interpret the result

- `passed`: this exact text completion and replay matched. It does not qualify
  every model, pricing plan, recovery case or application binding.
- `failed`: an input, contract, response or replay check failed. Inspect the
  reported stage and reason; the client makes no automatic recovery attempt.
- `unknown`: a request or response stream failed after the paid POST began.
  The server may already have processed it. Do not use a new idempotency key to
  blindly repeat it; investigate the original request through the Host's owning
  operational procedure.
- `skipped`: live execution was not requested; nothing was verified remotely.

The JSON result omits the bearer, credential path, raw idempotency key, prompt,
completion text and provider errors. Completion and request identifiers are
represented by digests. The wallet balance is a preflight observation, not proof
that no concurrent charge occurred. No live evidence file is written by this
client; store operator results outside the repository if retaining them.
