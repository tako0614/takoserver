# Takoserver Cloud

Takoserver turns provider capacity into independently managed cloud resources. Takoform
describes resource meaning and relationships; Takoserver owns placement, commercial
availability, provider execution, credentials, metering, and migration.

## Resource model

**Form**:
The provider-neutral meaning and lifecycle of one resource class, such as
`SqliteDatabase`, `PostgresDatabase`, or `S3Bucket`.
_Avoid_: Provider Form, Cloudflare Form, product SKU

**Interface**:
A versioned data-plane contract a Resource provides to consumers, independent of how
the Resource is deployed.
_Avoid_: Protocol flag, provider API name

**Logical Resource**:
A customer-owned resource identity with its own UID and revision, independent of any
one provider instance.
_Avoid_: Provider resource, native resource

**Deployment**:
One provider-backed realization of a Logical Resource under one exact Offering. A
Logical Resource may have multiple Deployments while migrating.
_Avoid_: Resource, placement record

**Attachment**:
A declared connection from one Logical Resource to an Interface provided by another
Logical Resource.
_Avoid_: Raw binding, embedded credential, child resource

**Migration**:
An explicit operation that creates and verifies a candidate Deployment, cuts
Attachments over, and retains or deletes the previous Deployment.
_Avoid_: Provider update, transparent move

## Supply model

**Provider Pack**:
A technical implementation of provisioning, attachment, transfer, credential,
metering, and cost capabilities for a provider family.
_Avoid_: Provider Form, Offering

**Provider Installation**:
One configured upstream account, project, or self-hosted substrate usable by a
Provider Pack.
_Avoid_: Provider Pack, customer account

**Supply Contract**:
The operator's authority to sell specified provider capacity through specified
delivery modes and regions.
_Avoid_: API credential, provider capability

**Offering**:
A customer-orderable product that binds one exact Form to a Provider Pack,
Provider Installation, Supply Contract, price plan, regions, isolation, and
portability claims.
_Avoid_: Form, provider, deployment

**Price Plan**:
The recurring and usage meters applied to an Offering.
_Avoid_: Unit price, provider invoice

## Access model

**Credential Grant**:
A bounded authority issued for an Attachment or direct Interface session without
placing a long-lived credential in Resource outputs.
_Avoid_: Password output, native access key output

**Binding Resolution**:
The act of resolving an Attachment against the provider Resource's active Deployment
and the consumer Deployment to choose a concrete connection method.
_Avoid_: Hard-coded Worker binding
