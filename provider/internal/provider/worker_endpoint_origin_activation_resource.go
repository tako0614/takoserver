package provider

import (
	"context"
	"errors"

	"github.com/hashicorp/terraform-plugin-framework/path"
	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	resourceschema "github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/tako0614/takoserver/provider/internal/client"
)

var (
	_ frameworkresource.Resource              = (*workerEndpointOriginActivationResource)(nil)
	_ frameworkresource.ResourceWithConfigure = (*workerEndpointOriginActivationResource)(nil)
)

type workerEndpointOriginActivationResource struct {
	data *providerData
}

type workerEndpointOriginActivationModel struct {
	OriginReservationID   types.String `tfsdk:"origin_reservation_id"`
	EndpointResourceUID   types.String `tfsdk:"endpoint_resource_uid"`
	Space                 types.String `tfsdk:"space"`
	WorkerName            types.String `tfsdk:"worker_name"`
	WorkerResourceUID     types.String `tfsdk:"worker_resource_uid"`
	EndpointName          types.String `tfsdk:"endpoint_name"`
	CanonicalPublicOrigin types.String `tfsdk:"canonical_public_origin"`
	Revision              types.String `tfsdk:"revision"`
	Status                types.String `tfsdk:"status"`
	ExpiresAt             types.String `tfsdk:"expires_at"`
}

// NewWorkerEndpointOriginActivationResource constructs the exact activation
// resource that binds an existing Takoform WorkerEndpoint to a reservation.
func NewWorkerEndpointOriginActivationResource() frameworkresource.Resource {
	return &workerEndpointOriginActivationResource{}
}

func (r *workerEndpointOriginActivationResource) Metadata(_ context.Context, request frameworkresource.MetadataRequest, response *frameworkresource.MetadataResponse) {
	response.TypeName = request.ProviderTypeName + "_worker_endpoint_origin_activation"
}

func (r *workerEndpointOriginActivationResource) Schema(_ context.Context, _ frameworkresource.SchemaRequest, response *frameworkresource.SchemaResponse) {
	response.Schema = resourceschema.Schema{
		Description: "Activates one exact Takoform WorkerEndpoint against a Takoserver-owned origin reservation.",
		Attributes: map[string]resourceschema.Attribute{
			"origin_reservation_id": resourceschema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"endpoint_resource_uid": resourceschema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"space":                   resourceschema.StringAttribute{Computed: true},
			"worker_name":             resourceschema.StringAttribute{Computed: true},
			"worker_resource_uid":     resourceschema.StringAttribute{Computed: true},
			"endpoint_name":           resourceschema.StringAttribute{Computed: true},
			"canonical_public_origin": resourceschema.StringAttribute{Computed: true},
			"revision":                resourceschema.StringAttribute{Computed: true},
			"status":                  resourceschema.StringAttribute{Computed: true},
			"expires_at":              resourceschema.StringAttribute{Computed: true},
		},
	}
}

func (r *workerEndpointOriginActivationResource) Configure(_ context.Context, request frameworkresource.ConfigureRequest, response *frameworkresource.ConfigureResponse) {
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

func (r *workerEndpointOriginActivationResource) Create(ctx context.Context, request frameworkresource.CreateRequest, response *frameworkresource.CreateResponse) {
	if r.data == nil || r.data.client == nil {
		response.Diagnostics.AddError("Takoserver provider is not configured", "Configure the Takoserver provider before activating a WorkerEndpoint origin.")
		return
	}
	var plan workerEndpointOriginActivationModel
	response.Diagnostics.Append(request.Plan.Get(ctx, &plan)...)
	if response.Diagnostics.HasError() {
		return
	}
	if !requireKnownActivationPlan(&plan, response) {
		return
	}
	activated, err := r.data.client.PutWorkerEndpointOriginActivation(ctx, plan.OriginReservationID.ValueString(), plan.EndpointResourceUID.ValueString())
	if err != nil {
		response.Diagnostics.AddError("Takoserver WorkerEndpoint origin activation failed", err.Error())
		return
	}
	setActivationProjection(&plan, activated)
	response.Diagnostics.Append(response.State.Set(ctx, &plan)...)
}

func (r *workerEndpointOriginActivationResource) Read(ctx context.Context, request frameworkresource.ReadRequest, response *frameworkresource.ReadResponse) {
	if r.data == nil || r.data.client == nil {
		response.Diagnostics.AddError("Takoserver provider is not configured", "Configure the Takoserver provider before reading WorkerEndpoint origin activation.")
		return
	}
	var state workerEndpointOriginActivationModel
	response.Diagnostics.Append(request.State.Get(ctx, &state)...)
	if response.Diagnostics.HasError() {
		return
	}
	if state.OriginReservationID.IsNull() || state.OriginReservationID.IsUnknown() || state.OriginReservationID.ValueString() == "" || state.EndpointResourceUID.IsNull() || state.EndpointResourceUID.IsUnknown() || state.EndpointResourceUID.ValueString() == "" {
		response.Diagnostics.AddError("Takoserver WorkerEndpoint origin activation identity is missing", "The exact reservation and endpoint resource identities are required to read activation state.")
		return
	}
	for _, candidate := range []struct {
		name  string
		value types.String
	}{
		{name: "space", value: state.Space},
		{name: "worker_name", value: state.WorkerName},
		{name: "worker_resource_uid", value: state.WorkerResourceUID},
		{name: "endpoint_name", value: state.EndpointName},
		{name: "canonical_public_origin", value: state.CanonicalPublicOrigin},
		{name: "revision", value: state.Revision},
		{name: "status", value: state.Status},
	} {
		if candidate.value.IsNull() || candidate.value.IsUnknown() || candidate.value.ValueString() == "" {
			response.Diagnostics.AddAttributeError(path.Root(candidate.name), "WorkerEndpoint origin activation projection is missing", "The value-free projection identity is required to read activation state safely.")
			return
		}
	}
	reservation, err := r.data.client.GetWorkerEndpointOriginReservation(ctx, state.OriginReservationID.ValueString())
	if errors.Is(err, client.ErrOriginReservationNotFound) {
		response.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		response.Diagnostics.AddError("Takoserver WorkerEndpoint origin activation read failed", err.Error())
		return
	}
	if reservation.ReservationID != state.OriginReservationID.ValueString() || reservation.EndpointResourceUID != state.EndpointResourceUID.ValueString() || reservation.WorkerResourceUID != state.WorkerResourceUID.ValueString() || reservation.Space != state.Space.ValueString() || reservation.WorkerName != state.WorkerName.ValueString() || reservation.EndpointName != state.EndpointName.ValueString() || reservation.CanonicalPublicOrigin != state.CanonicalPublicOrigin.ValueString() {
		response.Diagnostics.AddError("Takoserver WorkerEndpoint origin activation state drift", "The closed reservation projection no longer matches the exact activated endpoint state.")
		return
	}
	if reservation.Status == "bound" {
		// DELETE may have reached Takoserver even when its response did not reach
		// Terraform. The retained exact endpoint UID is the authoritative proof
		// that this activation is absent; removing only this resource state lets
		// the ordinary destroy continue to endpoint deletion and origin release.
		response.State.RemoveResource(ctx)
		return
	}
	if reservation.Status != "activated" || reservation.Revision != state.Revision.ValueString() {
		response.Diagnostics.AddError("Takoserver WorkerEndpoint origin activation state drift", "The closed reservation projection no longer matches the exact activated endpoint state.")
		return
	}
	state.ExpiresAt = stringValueOrUnknown(reservation.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z07:00"))
	state.Status = types.StringValue(reservation.Status)
	response.Diagnostics.Append(response.State.Set(ctx, &state)...)
}

func (r *workerEndpointOriginActivationResource) Update(_ context.Context, _ frameworkresource.UpdateRequest, response *frameworkresource.UpdateResponse) {
	response.Diagnostics.AddError("Takoserver WorkerEndpoint origin activation update is not implemented", "Activation identity is immutable and must be replaced when either resource identity changes.")
}

func (r *workerEndpointOriginActivationResource) Delete(ctx context.Context, request frameworkresource.DeleteRequest, response *frameworkresource.DeleteResponse) {
	if r.data == nil || r.data.client == nil {
		response.Diagnostics.AddError("Takoserver provider is not configured", "Configure the Takoserver provider before deactivating a WorkerEndpoint origin.")
		return
	}
	var state workerEndpointOriginActivationModel
	response.Diagnostics.Append(request.State.Get(ctx, &state)...)
	if response.Diagnostics.HasError() {
		return
	}
	if state.OriginReservationID.IsNull() || state.OriginReservationID.IsUnknown() || state.OriginReservationID.ValueString() == "" || state.EndpointResourceUID.IsNull() || state.EndpointResourceUID.IsUnknown() || state.EndpointResourceUID.ValueString() == "" {
		response.Diagnostics.AddError("Takoserver WorkerEndpoint origin activation identity is missing", "The exact reservation and endpoint resource identities are required to deactivate state.")
		return
	}
	if err := r.data.client.DeleteWorkerEndpointOriginActivation(ctx, state.OriginReservationID.ValueString(), state.EndpointResourceUID.ValueString()); err != nil {
		response.Diagnostics.AddError("Takoserver WorkerEndpoint origin deactivation failed", err.Error())
	}
}

func requireKnownActivationPlan(plan *workerEndpointOriginActivationModel, response *frameworkresource.CreateResponse) bool {
	known := true
	for _, candidate := range []struct {
		name  string
		value types.String
	}{
		{name: "origin_reservation_id", value: plan.OriginReservationID},
		{name: "endpoint_resource_uid", value: plan.EndpointResourceUID},
	} {
		if candidate.value.IsUnknown() || candidate.value.IsNull() || candidate.value.ValueString() == "" {
			response.Diagnostics.AddAttributeError(path.Root(candidate.name), "WorkerEndpoint origin activation identity must be known", "The exact reservation and endpoint resource identities must be known before activation.")
			known = false
		}
	}
	return known
}

func setActivationProjection(plan *workerEndpointOriginActivationModel, projection client.WorkerEndpointOriginActivation) {
	plan.OriginReservationID = types.StringValue(projection.ReservationID)
	plan.Space = types.StringValue(projection.Space)
	plan.WorkerName = types.StringValue(projection.WorkerName)
	plan.WorkerResourceUID = types.StringValue(projection.WorkerResourceUID)
	plan.EndpointName = types.StringValue(projection.EndpointName)
	plan.CanonicalPublicOrigin = types.StringValue(projection.CanonicalPublicOrigin)
	plan.Revision = types.StringValue(projection.Revision)
	plan.Status = types.StringValue(projection.Status)
	plan.ExpiresAt = types.StringValue(projection.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z07:00"))
}

func stringValueOrUnknown(value string) types.String {
	if value == "" {
		return types.StringNull()
	}
	return types.StringValue(value)
}
