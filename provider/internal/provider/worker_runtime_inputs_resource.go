package provider

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
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
	_ frameworkresource.Resource               = (*workerRuntimeInputsResource)(nil)
	_ frameworkresource.ResourceWithConfigure  = (*workerRuntimeInputsResource)(nil)
	_ frameworkresource.ResourceWithModifyPlan = (*workerRuntimeInputsResource)(nil)
)

type workerRuntimeInputsResource struct {
	data *providerData
}

type workerRuntimeInputsModel struct {
	Space                 types.String `tfsdk:"space"`
	WorkerName            types.String `tfsdk:"worker_name"`
	WorkerResourceUID     types.String `tfsdk:"worker_resource_uid"`
	BundleName            types.String `tfsdk:"bundle_name"`
	EndpointName          types.String `tfsdk:"endpoint_name"`
	BindingNames          types.Set    `tfsdk:"binding_names"`
	MaterialSetID         types.String `tfsdk:"material_set_id"`
	OriginReservationID   types.String `tfsdk:"origin_reservation_id"`
	CanonicalPublicOrigin types.String `tfsdk:"canonical_public_origin"`
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
			"endpoint_name": resourceschema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
				Description:   "Logical WorkerEndpoint name committed by the preflight origin reservation.",
			},
			"binding_names": resourceschema.SetAttribute{
				Required:    true,
				ElementType: types.StringType,
				Description: "Exact non-secret binding name set expected in the run-scoped credential file.",
				PlanModifiers: []planmodifier.Set{
					setplanmodifier.RequiresReplace(),
				},
			},
			"material_set_id":         resourceschema.StringAttribute{Computed: true},
			"origin_reservation_id":   resourceschema.StringAttribute{Computed: true},
			"canonical_public_origin": resourceschema.StringAttribute{Computed: true},
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

// ModifyPlan resolves the preflight-only runtime input reference before the
// ordinary apply. The reference commits the nonce, logical target, origin
// reservation, canonical origin, and binding values, but deliberately omits
// the Worker UID that is created later in the same apply. No credential values
// or file paths are copied into the plan.
func (r *workerRuntimeInputsResource) ModifyPlan(ctx context.Context, request frameworkresource.ModifyPlanRequest, response *frameworkresource.ModifyPlanResponse) {
	if request.Plan.Raw.IsNull() {
		return
	}
	if r.data == nil {
		response.Diagnostics.AddError("Takoserver provider is not configured", "Configure the Takoserver provider before resolving the runtime input preflight reference.")
		return
	}
	var plan workerRuntimeInputsModel
	response.Diagnostics.Append(response.Plan.Get(ctx, &plan)...)
	if response.Diagnostics.HasError() || !preflightTargetKnown(&plan) {
		return
	}
	var bindingNames []string
	if plan.BindingNames.IsUnknown() || plan.BindingNames.IsNull() {
		return
	}
	for _, element := range plan.BindingNames.Elements() {
		if element.IsUnknown() || element.IsNull() {
			return
		}
	}
	response.Diagnostics.Append(plan.BindingNames.ElementsAs(ctx, &bindingNames, false)...)
	if response.Diagnostics.HasError() {
		return
	}
	sort.Strings(bindingNames)
	var prior workerRuntimeInputsModel
	priorStateAvailable := false
	if !request.State.Raw.IsNull() {
		response.Diagnostics.Append(request.State.Get(ctx, &prior)...)
		if response.Diagnostics.HasError() {
			return
		}
		priorStateAvailable = reusablePreflightState(ctx, &plan, &prior, bindingNames)
	}
	if !credentialFilePresent(r.data.credentialFilePath) {
		if priorStateAvailable {
			response.Diagnostics.Append(response.Plan.SetAttribute(ctx, path.Root("runtime_input_reference"), prior.RuntimeInputReference)...)
			return
		}
		response.Diagnostics.AddError("Runtime input credential file is required", "A fresh run-scoped credential file is required for a new, replaced, or rotated runtime input preparation.")
		return
	}
	envelope, err := credentialfile.LoadForTarget(r.data.credentialFilePath, credentialfile.Target{
		Space:        plan.Space.ValueString(),
		WorkerName:   plan.WorkerName.ValueString(),
		BundleName:   plan.BundleName.ValueString(),
		EndpointName: plan.EndpointName.ValueString(),
	}, "", bindingNames)
	if err != nil {
		response.Diagnostics.AddError("Invalid runtime input credential file", err.Error())
		return
	}
	runtimeInputReference, err := credentialfile.ComputeRuntimeInputReference(envelope)
	if err != nil {
		response.Diagnostics.AddError("Cannot derive runtime input preflight reference", err.Error())
		return
	}
	if priorStateAvailable {
		if prior.RuntimeInputReference.ValueString() != runtimeInputReference && !response.RequiresReplace.Contains(path.Root("runtime_input_reference")) {
			response.RequiresReplace = append(response.RequiresReplace, path.Root("runtime_input_reference"))
		}
	}
	response.Diagnostics.Append(response.Plan.SetAttribute(ctx, path.Root("runtime_input_reference"), types.StringValue(runtimeInputReference))...)
}

func (r *workerRuntimeInputsResource) Create(ctx context.Context, request frameworkresource.CreateRequest, response *frameworkresource.CreateResponse) {
	if r.data == nil || r.data.client == nil {
		response.Diagnostics.AddError("Takoserver provider is not configured", "Configure the Takoserver provider before preparing runtime inputs.")
		return
	}

	var plan workerRuntimeInputsModel
	response.Diagnostics.Append(request.Plan.Get(ctx, &plan)...)
	if response.Diagnostics.HasError() || !requireKnownPlan(&plan, response) {
		return
	}
	var bindingNames []string
	response.Diagnostics.Append(plan.BindingNames.ElementsAs(ctx, &bindingNames, false)...)
	if response.Diagnostics.HasError() {
		return
	}
	sort.Strings(bindingNames)

	envelope, err := credentialfile.LoadForTarget(r.data.credentialFilePath, credentialfile.Target{
		Space:        plan.Space.ValueString(),
		WorkerName:   plan.WorkerName.ValueString(),
		BundleName:   plan.BundleName.ValueString(),
		EndpointName: plan.EndpointName.ValueString(),
	}, "", bindingNames)
	if err != nil {
		response.Diagnostics.AddError("Invalid runtime input credential file", err.Error())
		return
	}

	// The reservation is the only origin authority. Do not send values or
	// materialSetId until its closed projection has been validated completely.
	reservation, err := r.data.client.GetWorkerEndpointOriginReservation(ctx, envelope.OriginReservationID)
	if err != nil {
		response.Diagnostics.AddError("Takoserver origin reservation validation failed", err.Error())
		return
	}
	if !runtimePreparationReservationUsable(reservation) || reservation.ReservationID != envelope.OriginReservationID || reservation.Space != plan.Space.ValueString() || reservation.WorkerName != plan.WorkerName.ValueString() || reservation.EndpointName != plan.EndpointName.ValueString() || envelope.CanonicalPublicOrigin != reservation.CanonicalPublicOrigin || reservation.WorkerResourceUID != plan.WorkerResourceUID.ValueString() {
		response.Diagnostics.AddError("Takoserver origin reservation does not match the runtime input target", "The closed reservation projection, credential envelope, and realized Worker identity must agree before any binding value is sent.")
		return
	}
	runtimeInputReference, err := credentialfile.ComputeRuntimeInputReference(envelope)
	if err != nil {
		response.Diagnostics.AddError("Cannot derive runtime input preflight reference", err.Error())
		return
	}
	if !plan.RuntimeInputReference.IsNull() && !plan.RuntimeInputReference.IsUnknown() && plan.RuntimeInputReference.ValueString() != "" && plan.RuntimeInputReference.ValueString() != runtimeInputReference {
		response.Diagnostics.AddAttributeError(path.Root("runtime_input_reference"), "Runtime input preflight reference drift", "The plan reference no longer matches the exact preflight credential envelope.")
		return
	}
	plan.RuntimeInputReference = types.StringValue(runtimeInputReference)

	materialSetID, err := credentialfile.ComputeMaterialSetID(envelope, plan.WorkerResourceUID.ValueString())
	if err != nil {
		response.Diagnostics.AddError("Cannot derive runtime input material set identity", err.Error())
		return
	}
	plan.OriginReservationID = types.StringValue(envelope.OriginReservationID)
	operationID, err := deriveOperationID(plan, materialSetID, bindingNames)
	if err != nil {
		response.Diagnostics.AddError("Cannot derive runtime input operation identity", err.Error())
		return
	}
	prepared, err := r.data.client.PutRuntimeInputPreparation(ctx, operationID, client.RuntimeInputPreparationInput{
		MaterialSetID:         materialSetID,
		MaterialSetNonce:      envelope.MaterialSetNonce,
		RuntimeInputReference: runtimeInputReference,
		Space:                 plan.Space.ValueString(),
		WorkerName:            plan.WorkerName.ValueString(),
		WorkerResourceUID:     plan.WorkerResourceUID.ValueString(),
		BundleName:            plan.BundleName.ValueString(),
		EndpointName:          plan.EndpointName.ValueString(),
		OriginReservationID:   envelope.OriginReservationID,
		Bindings:              envelope.Values,
	})
	if err != nil {
		response.Diagnostics.AddError("Takoserver runtime input preparation failed", err.Error())
		return
	}
	if prepared.CanonicalPublicOrigin != reservation.CanonicalPublicOrigin {
		response.Diagnostics.AddError("Takoserver runtime input origin authority drift", "Takoserver returned a canonical origin different from the validated reservation projection; refusing to retain the preparation state.")
		return
	}

	plan.MaterialSetID = types.StringValue(materialSetID)
	plan.OriginReservationID = types.StringValue(prepared.OriginReservationID)
	plan.CanonicalPublicOrigin = types.StringValue(prepared.CanonicalPublicOrigin)
	plan.RuntimeInputReference = types.StringValue(prepared.RuntimeInputReference)
	plan.OperationID = types.StringValue(prepared.OperationID)
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
	if observed.Space != state.Space.ValueString() || observed.WorkerName != state.WorkerName.ValueString() || observed.WorkerResourceUID != state.WorkerResourceUID.ValueString() || observed.BundleName != state.BundleName.ValueString() || observed.OriginReservationID != state.OriginReservationID.ValueString() || observed.CanonicalPublicOrigin != state.CanonicalPublicOrigin.ValueString() || observed.RuntimeInputReference != state.RuntimeInputReference.ValueString() || !equalStringSlices(observed.BindingNames, stateNames) {
		response.Diagnostics.AddError("Takoserver runtime input state drift", "The durable value-free preparation projection no longer matches the OpenTofu state identity.")
		return
	}
	expectedOperationID, err := deriveOperationID(state, state.MaterialSetID.ValueString(), stateNames)
	if err != nil || expectedOperationID != state.OperationID.ValueString() {
		response.Diagnostics.AddError("Takoserver runtime input operation identity drift", "The durable operation identity no longer matches the computed material-set identity.")
		return
	}
	reservation, err := r.data.client.GetWorkerEndpointOriginReservation(ctx, state.OriginReservationID.ValueString())
	if err != nil {
		response.Diagnostics.AddError("Takoserver origin reservation read failed", err.Error())
		return
	}
	if !runtimePreparationReservationUsable(reservation) || reservation.ReservationID != state.OriginReservationID.ValueString() || reservation.Space != state.Space.ValueString() || reservation.WorkerName != state.WorkerName.ValueString() || reservation.EndpointName != state.EndpointName.ValueString() || reservation.CanonicalPublicOrigin != state.CanonicalPublicOrigin.ValueString() || reservation.WorkerResourceUID != state.WorkerResourceUID.ValueString() {
		response.Diagnostics.AddError("Takoserver origin reservation state drift", "The closed origin reservation projection no longer matches the OpenTofu runtime input identity.")
		return
	}
	state.Status = types.StringValue(observed.Status)
	state.ExpiresAt = types.StringValue(observed.ExpiresAt.UTC().Format(time.RFC3339))
	response.Diagnostics.Append(response.State.Set(ctx, &state)...)
}

func (r *workerRuntimeInputsResource) Update(_ context.Context, _ frameworkresource.UpdateRequest, response *frameworkresource.UpdateResponse) {
	response.Diagnostics.AddError("Takoserver runtime input update is not implemented", "Runtime input preparations are immutable and must be replaced when any identity changes.")
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
	Format        string                  `json:"format"`
	MaterialSetID string                  `json:"materialSetId"`
	Target        operationIdentityTarget `json:"target"`
	BindingNames  []string                `json:"bindingNames"`
}

type operationIdentityTarget struct {
	Space               string `json:"space"`
	WorkerName          string `json:"workerName"`
	WorkerResourceUID   string `json:"workerResourceUid"`
	BundleName          string `json:"bundleName"`
	OriginReservationID string `json:"originReservationId"`
}

func deriveOperationID(plan workerRuntimeInputsModel, materialSetID string, bindingNames []string) (string, error) {
	canonicalBindingNames := append([]string(nil), bindingNames...)
	sort.Strings(canonicalBindingNames)
	document := operationIdentityDocument{
		Format:        "takoserver.worker-runtime-input-operation@v1",
		MaterialSetID: materialSetID,
		Target: operationIdentityTarget{
			Space:               plan.Space.ValueString(),
			WorkerName:          plan.WorkerName.ValueString(),
			WorkerResourceUID:   plan.WorkerResourceUID.ValueString(),
			BundleName:          plan.BundleName.ValueString(),
			OriginReservationID: plan.OriginReservationID.ValueString(),
		},
		BindingNames: canonicalBindingNames,
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
		{name: "endpoint_name", value: plan.EndpointName},
	} {
		if candidate.value.IsUnknown() || candidate.value.IsNull() || candidate.value.ValueString() == "" {
			response.Diagnostics.AddAttributeError(path.Root(candidate.name), "Runtime input target must be known", "The exact logical target and realized Worker identity must be known before Takoserver receives any material.")
			known = false
		}
	}
	if plan.BindingNames.IsUnknown() || plan.BindingNames.IsNull() {
		response.Diagnostics.AddAttributeError(path.Root("binding_names"), "Runtime input binding names must be known", "The exact non-secret binding name set must be known before Takoserver receives any material.")
		known = false
	}
	return known
}

func preflightTargetKnown(plan *workerRuntimeInputsModel) bool {
	for _, value := range []types.String{
		plan.Space,
		plan.WorkerName,
		plan.BundleName,
		plan.EndpointName,
	} {
		if value.IsUnknown() || value.IsNull() || value.ValueString() == "" {
			return false
		}
	}
	return true
}

func credentialFilePresent(filePath string) bool {
	if filePath == "" {
		return false
	}
	_, err := os.Lstat(filePath)
	return err == nil || !errors.Is(err, os.ErrNotExist)
}

func reusablePreflightState(ctx context.Context, plan, prior *workerRuntimeInputsModel, plannedBindingNames []string) bool {
	if prior.RuntimeInputReference.IsNull() || prior.RuntimeInputReference.IsUnknown() || prior.RuntimeInputReference.ValueString() == "" {
		return false
	}
	if !sameLogicalTarget(plan, prior) {
		return false
	}
	if !sameBindingNames(ctx, prior.BindingNames, plannedBindingNames) {
		return false
	}
	if plan.WorkerResourceUID.IsNull() {
		return false
	}
	// An unknown planned Worker UID with a realized prior UID can represent a
	// replacement dependency. Do not reuse the old preflight envelope in that
	// case: a fresh credential file is required for every replacement.
	if plan.WorkerResourceUID.IsUnknown() && !prior.WorkerResourceUID.IsNull() && !prior.WorkerResourceUID.IsUnknown() {
		return false
	}
	if !plan.WorkerResourceUID.IsUnknown() && !prior.WorkerResourceUID.IsNull() && !prior.WorkerResourceUID.IsUnknown() && plan.WorkerResourceUID.ValueString() != prior.WorkerResourceUID.ValueString() {
		return false
	}
	if !plan.RuntimeInputReference.IsNull() && !plan.RuntimeInputReference.IsUnknown() && plan.RuntimeInputReference.ValueString() != prior.RuntimeInputReference.ValueString() {
		return false
	}
	return true
}

func sameLogicalTarget(plan, prior *workerRuntimeInputsModel) bool {
	return plan.Space.ValueString() != "" && plan.Space.ValueString() == prior.Space.ValueString() && plan.WorkerName.ValueString() != "" && plan.WorkerName.ValueString() == prior.WorkerName.ValueString() && plan.BundleName.ValueString() != "" && plan.BundleName.ValueString() == prior.BundleName.ValueString() && plan.EndpointName.ValueString() != "" && plan.EndpointName.ValueString() == prior.EndpointName.ValueString()
}

func sameBindingNames(ctx context.Context, prior types.Set, planned []string) bool {
	if prior.IsNull() || prior.IsUnknown() {
		return false
	}
	var previous []string
	if prior.ElementsAs(ctx, &previous, false).HasError() {
		return false
	}
	sort.Strings(previous)
	sort.Strings(planned)
	return equalStringSlices(previous, planned)
}

func runtimePreparationReservationUsable(reservation client.WorkerEndpointOriginReservation) bool {
	return (reservation.Status == "bound" || reservation.Status == "activated") && reservation.WorkerResourceUID != ""
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
