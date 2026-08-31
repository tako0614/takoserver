package provider

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/hashicorp/terraform-plugin-framework/path"
	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	resourceschema "github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/tako0614/takoserver/provider/internal/client"
	"github.com/tako0614/takoserver/provider/internal/credentialfile"
)

var (
	_ frameworkresource.Resource              = (*workerRuntimeInputsResource)(nil)
	_ frameworkresource.ResourceWithConfigure = (*workerRuntimeInputsResource)(nil)
)

type workerRuntimeInputsResource struct {
	data *providerData
}

type workerRuntimeInputsModel struct {
	Space                 types.String `tfsdk:"space"`
	WorkerName            types.String `tfsdk:"worker_name"`
	WorkerResourceUID     types.String `tfsdk:"worker_resource_uid"`
	BundleName            types.String `tfsdk:"bundle_name"`
	OriginResourceUID     types.String `tfsdk:"origin_resource_uid"`
	CanonicalPublicOrigin types.String `tfsdk:"canonical_public_origin"`
	BindingNames          types.Set    `tfsdk:"binding_names"`
	MaterialSetID         types.String `tfsdk:"material_set_id"`
	OperationID           types.String `tfsdk:"operation_id"`
	RuntimeInputReference types.String `tfsdk:"runtime_input_reference"`
	Status                types.String `tfsdk:"status"`
	ExpiresAt             types.String `tfsdk:"expires_at"`
}

// NewWorkerRuntimeInputsResource constructs the one Takoserver control resource.
func NewWorkerRuntimeInputsResource() frameworkresource.Resource {
	return &workerRuntimeInputsResource{}
}

func (r *workerRuntimeInputsResource) Metadata(_ context.Context, request frameworkresource.MetadataRequest, response *frameworkresource.MetadataResponse) {
	response.TypeName = request.ProviderTypeName + "_worker_runtime_inputs"
}

func (r *workerRuntimeInputsResource) Schema(_ context.Context, _ frameworkresource.SchemaRequest, response *frameworkresource.SchemaResponse) {
	response.Schema = resourceschema.Schema{
		Description: "Prepares one exact, run-scoped Worker runtime input set in Takoserver without retaining values in OpenTofu state.",
		Attributes: map[string]resourceschema.Attribute{
			"space": resourceschema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"worker_name": resourceschema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"worker_resource_uid": resourceschema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
				Description:   "Exact identity of the Worker resource realization targeted by this run-scoped material set.",
			},
			"bundle_name": resourceschema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"origin_resource_uid": resourceschema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"canonical_public_origin": resourceschema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"binding_names": resourceschema.SetAttribute{
				Required:    true,
				ElementType: types.StringType,
				Description: "Exact non-secret binding name set expected in the run-scoped credential file.",
				PlanModifiers: []planmodifier.Set{
					setplanmodifier.RequiresReplace(),
				},
			},
			"material_set_id": resourceschema.StringAttribute{
				Required: true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
				Description: "Non-secret identity of the exact material set expected in the run-scoped credential file.",
			},
			"operation_id":            resourceschema.StringAttribute{Computed: true},
			"runtime_input_reference": resourceschema.StringAttribute{Computed: true, Description: "Opaque runtime-input reference returned by Takoserver for the downstream Host operation idempotency key."},
			"status":                  resourceschema.StringAttribute{Computed: true},
			"expires_at":              resourceschema.StringAttribute{Computed: true},
		},
	}
}

func (r *workerRuntimeInputsResource) Configure(_ context.Context, request frameworkresource.ConfigureRequest, response *frameworkresource.ConfigureResponse) {
	if request.ProviderData == nil {
		return
	}
	data, ok := request.ProviderData.(*providerData)
	if !ok {
		response.Diagnostics.AddError("Unexpected Takoserver provider data", "The configured provider data has an unexpected type.")
		return
	}
	r.data = data
}

func (r *workerRuntimeInputsResource) Create(ctx context.Context, request frameworkresource.CreateRequest, response *frameworkresource.CreateResponse) {
	if r.data == nil || r.data.client == nil {
		response.Diagnostics.AddError("Takoserver provider is not configured", "Configure the Takoserver provider before preparing runtime inputs.")
		return
	}

	var plan workerRuntimeInputsModel
	response.Diagnostics.Append(request.Plan.Get(ctx, &plan)...)
	if response.Diagnostics.HasError() {
		return
	}
	if !requireKnownPlan(&plan, response) {
		return
	}
	var bindingNames []string
	response.Diagnostics.Append(plan.BindingNames.ElementsAs(ctx, &bindingNames, false)...)
	if response.Diagnostics.HasError() {
		return
	}
	sort.Strings(bindingNames)

	envelope, err := credentialfile.LoadForTarget(r.data.credentialFilePath, credentialfile.Target{
		Space:             plan.Space.ValueString(),
		WorkerName:        plan.WorkerName.ValueString(),
		WorkerResourceUID: plan.WorkerResourceUID.ValueString(),
		BundleName:        plan.BundleName.ValueString(),
		OriginResourceUID: plan.OriginResourceUID.ValueString(),
	}, plan.CanonicalPublicOrigin.ValueString(), bindingNames)
	if err != nil {
		response.Diagnostics.AddError("Invalid runtime input credential file", err.Error())
		return
	}
	if plan.MaterialSetID.ValueString() != envelope.MaterialSetID {
		response.Diagnostics.AddAttributeError(path.Root("material_set_id"), "Runtime input material set does not match the credential file", "The planned non-secret material set identity must exactly match the credential file before Takoserver receives any material.")
		return
	}
	operationID, err := deriveOperationID(plan, plan.MaterialSetID.ValueString(), bindingNames)
	if err != nil {
		response.Diagnostics.AddError("Cannot derive runtime input operation identity", err.Error())
		return
	}
	prepared, err := r.data.client.PutRuntimeInputPreparation(ctx, operationID, client.RuntimeInputPreparationInput{
		MaterialSetID:         envelope.MaterialSetID,
		Space:                 plan.Space.ValueString(),
		WorkerName:            plan.WorkerName.ValueString(),
		WorkerResourceUID:     plan.WorkerResourceUID.ValueString(),
		BundleName:            plan.BundleName.ValueString(),
		OriginResourceUID:     plan.OriginResourceUID.ValueString(),
		CanonicalPublicOrigin: plan.CanonicalPublicOrigin.ValueString(),
		Bindings:              envelope.Values,
	})
	if err != nil {
		response.Diagnostics.AddError("Takoserver runtime input preparation failed", err.Error())
		return
	}

	plan.OperationID = types.StringValue(prepared.OperationID)
	plan.RuntimeInputReference = types.StringValue(prepared.RuntimeInputReference)
	plan.Status = types.StringValue(prepared.Status)
	plan.ExpiresAt = types.StringValue(prepared.ExpiresAt.UTC().Format(time.RFC3339))
	response.Diagnostics.Append(response.State.Set(ctx, &plan)...)
}

func (r *workerRuntimeInputsResource) Read(ctx context.Context, request frameworkresource.ReadRequest, response *frameworkresource.ReadResponse) {
	if r.data == nil || r.data.client == nil {
		response.Diagnostics.AddError("Takoserver provider is not configured", "Configure the Takoserver provider before reading runtime inputs.")
		return
	}
	var state workerRuntimeInputsModel
	response.Diagnostics.Append(request.State.Get(ctx, &state)...)
	if response.Diagnostics.HasError() {
		return
	}
	if state.OperationID.IsNull() || state.OperationID.IsUnknown() || state.OperationID.ValueString() == "" {
		response.Diagnostics.AddAttributeError(path.Root("operation_id"), "Runtime input operation identity is missing", "The value-free operation identity is required to read Takoserver state.")
		return
	}
	observed, err := r.data.client.GetRuntimeInputPreparation(ctx, state.OperationID.ValueString())
	if errors.Is(err, client.ErrNotFound) {
		response.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		response.Diagnostics.AddError("Takoserver runtime input read failed", err.Error())
		return
	}
	if observed.Status == "expired" || observed.Status == "revoked" {
		response.State.RemoveResource(ctx)
		return
	}
	if observed.Status == "indeterminate" {
		response.Diagnostics.AddError("Takoserver runtime input state is indeterminate", "The durable preparation outcome is unknown; refusing to clear or reuse the resource state.")
		return
	}
	var stateNames []string
	response.Diagnostics.Append(state.BindingNames.ElementsAs(ctx, &stateNames, false)...)
	if response.Diagnostics.HasError() {
		return
	}
	sort.Strings(stateNames)
	if observed.Space != state.Space.ValueString() || observed.WorkerName != state.WorkerName.ValueString() || observed.WorkerResourceUID != state.WorkerResourceUID.ValueString() || observed.BundleName != state.BundleName.ValueString() || observed.OriginResourceUID != state.OriginResourceUID.ValueString() || observed.CanonicalPublicOrigin != state.CanonicalPublicOrigin.ValueString() || observed.RuntimeInputReference != state.RuntimeInputReference.ValueString() || !equalStringSlices(observed.BindingNames, stateNames) {
		response.Diagnostics.AddError("Takoserver runtime input state drift", "The durable value-free preparation projection no longer matches the OpenTofu state identity.")
		return
	}
	state.Status = types.StringValue(observed.Status)
	state.ExpiresAt = types.StringValue(observed.ExpiresAt.UTC().Format(time.RFC3339))
	response.Diagnostics.Append(response.State.Set(ctx, &state)...)
}

func (r *workerRuntimeInputsResource) Update(_ context.Context, _ frameworkresource.UpdateRequest, response *frameworkresource.UpdateResponse) {
	response.Diagnostics.AddError("Takoserver runtime input update is not implemented", "The provider tracer has not connected this lifecycle operation yet.")
}

func (r *workerRuntimeInputsResource) Delete(ctx context.Context, request frameworkresource.DeleteRequest, response *frameworkresource.DeleteResponse) {
	if r.data == nil || r.data.client == nil {
		response.Diagnostics.AddError("Takoserver provider is not configured", "Configure the Takoserver provider before revoking runtime inputs.")
		return
	}
	var state workerRuntimeInputsModel
	response.Diagnostics.Append(request.State.Get(ctx, &state)...)
	if response.Diagnostics.HasError() {
		return
	}
	if state.OperationID.IsNull() || state.OperationID.IsUnknown() || state.OperationID.ValueString() == "" {
		response.Diagnostics.AddAttributeError(path.Root("operation_id"), "Runtime input operation identity is missing", "The value-free operation identity is required to revoke Takoserver state.")
		return
	}
	if err := r.data.client.DeleteRuntimeInputPreparation(ctx, state.OperationID.ValueString()); err != nil {
		response.Diagnostics.AddError("Takoserver runtime input revoke failed", err.Error())
	}
}

type operationIdentityDocument struct {
	Format                string                  `json:"format"`
	MaterialSetID         string                  `json:"materialSetId"`
	Target                operationIdentityTarget `json:"target"`
	CanonicalPublicOrigin string                  `json:"canonicalPublicOrigin"`
	BindingNames          []string                `json:"bindingNames"`
}

type operationIdentityTarget struct {
	Space             string `json:"space"`
	WorkerName        string `json:"workerName"`
	WorkerResourceUID string `json:"workerResourceUid"`
	BundleName        string `json:"bundleName"`
	OriginResourceUID string `json:"originResourceUid"`
}

func deriveOperationID(plan workerRuntimeInputsModel, materialSetID string, bindingNames []string) (string, error) {
	document := operationIdentityDocument{
		Format:        "takoserver.worker-runtime-input-operation@v1",
		MaterialSetID: materialSetID,
		Target: operationIdentityTarget{
			Space:             plan.Space.ValueString(),
			WorkerName:        plan.WorkerName.ValueString(),
			WorkerResourceUID: plan.WorkerResourceUID.ValueString(),
			BundleName:        plan.BundleName.ValueString(),
			OriginResourceUID: plan.OriginResourceUID.ValueString(),
		},
		CanonicalPublicOrigin: plan.CanonicalPublicOrigin.ValueString(),
		BindingNames:          append([]string(nil), bindingNames...),
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return "", errors.New("non-secret operation identity cannot be encoded")
	}
	digest := sha256.Sum256(encoded)
	return "wri-" + hex.EncodeToString(digest[:16]), nil
}

func requireKnownPlan(plan *workerRuntimeInputsModel, response *frameworkresource.CreateResponse) bool {
	known := true
	for _, candidate := range []struct {
		name  string
		value types.String
	}{
		{name: "space", value: plan.Space},
		{name: "worker_name", value: plan.WorkerName},
		{name: "worker_resource_uid", value: plan.WorkerResourceUID},
		{name: "bundle_name", value: plan.BundleName},
		{name: "origin_resource_uid", value: plan.OriginResourceUID},
		{name: "canonical_public_origin", value: plan.CanonicalPublicOrigin},
		{name: "material_set_id", value: plan.MaterialSetID},
	} {
		if candidate.value.IsUnknown() || candidate.value.IsNull() || candidate.value.ValueString() == "" {
			response.Diagnostics.AddAttributeError(path.Root(candidate.name), "Runtime input target must be known", "The runtime input target and origin must be exact before Takoserver receives any material.")
			known = false
		}
	}
	if plan.BindingNames.IsUnknown() || plan.BindingNames.IsNull() {
		response.Diagnostics.AddAttributeError(path.Root("binding_names"), "Runtime input binding names must be known", "The exact non-secret binding name set must be known before Takoserver receives any material.")
		known = false
	}
	return known
}

func equalStringSlices(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
