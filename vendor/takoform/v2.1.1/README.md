# Retained Takoform provider v2.1.1 release data

Takoserver retains these exact JSON files only to observe and drain already
recorded beta Deployments. They are not current `forms.takoform.com/v1` sale or
provision authority. The files are copied from the released
`registry.terraform.io/tako0614/takoform` provider at
`https://github.com/tako0614/terraform-provider-takoform.git` tag `v2.1.1`, commit
`9810570d542434efcf177543de9d463bbfda0d09`:

- `release/provider-form-identities.json`
- `forms/candidates/edge/v1beta1/object-bucket/definition.json`
- `forms/candidates/edge/v1beta1/object-bucket/package-index.json`

`bun run check:official-forms` verifies their exact source byte digests and the
resulting installed catalog. Adding a Takoserver-local Form or changing a
released definition behind its identity fails that gate. S3 is the data-plane
protocol of the official ObjectBucket Form; ordinary APIs such as the
OpenAI-compatible AI service are not represented as Forms.
