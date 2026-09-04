# Published seams

Takoserver currently publishes no private HTTP product seam.

Hosted sponsorship is a route-less Cloudflare service binding to the dedicated
`takoserver-sponsorship-authority` Worker. The consumer owns a structural RPC
type for its single operation; Takoserver owns the implementation and binding
closure. There is intentionally no HTTP recording or compatibility artifact to
vendor.
