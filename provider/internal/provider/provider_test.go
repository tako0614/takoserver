package provider_test

import (
	"context"
	"testing"

	frameworkprovider "github.com/hashicorp/terraform-plugin-framework/provider"
	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	resourceschema "github.com/hashicorp/terraform-plugin-framework/resource/schema"

	takoserverprovider "github.com/tako0614/takoserver/provider/internal/provider"
)

func TestProviderExposesRuntimePreparationAndOriginActivationResources(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	candidate := takoserverprovider.New("test")()

	var metadata frameworkprovider.MetadataResponse
	candidate.Metadata(ctx, frameworkprovider.MetadataRequest{}, &metadata)
	if metadata.TypeName != "takoserver" || metadata.Version != "test" {
		t.Fatalf("provider metadata = %#v", metadata)
	}

	var providerSchema frameworkprovider.SchemaResponse
	candidate.Schema(ctx, frameworkprovider.SchemaRequest{}, &providerSchema)
	if providerSchema.Diagnostics.HasError() {
		t.Fatalf("provider schema diagnostics = %v", providerSchema.Diagnostics)
	}
	if token := providerSchema.Schema.Attributes["token"]; token == nil || !token.IsSensitive() {
		t.Fatal("provider token must be the one sensitive configuration input")
	}

	factories := candidate.Resources(ctx)
	if len(factories) != 2 {
		t.Fatalf("resource count = %d, want 2", len(factories))
	}
	seen := make(map[string]resourceschema.Schema)
	for _, factory := range factories {
		resource := factory()
		var resourceMetadata frameworkresource.MetadataResponse
		resource.Metadata(ctx, frameworkresource.MetadataRequest{ProviderTypeName: "takoserver"}, &resourceMetadata)
		var resourceSchema frameworkresource.SchemaResponse
		resource.Schema(ctx, frameworkresource.SchemaRequest{}, &resourceSchema)
		if resourceSchema.Diagnostics.HasError() {
			t.Fatalf("resource %s schema diagnostics = %v", resourceMetadata.TypeName, resourceSchema.Diagnostics)
		}
		seen[resourceMetadata.TypeName] = resourceSchema.Schema
	}

	runtimeSchema, ok := seen["takoserver_worker_runtime_inputs"]
	if !ok {
		t.Fatal("runtime input resource was not registered")
	}
	for _, name := range []string{"space", "worker_name", "worker_resource_uid", "bundle_name", "endpoint_name", "binding_names", "material_set_id", "origin_reservation_id", "canonical_public_origin", "operation_id", "runtime_input_reference", "status", "expires_at"} {
		if _, ok := runtimeSchema.Attributes[name]; !ok {
			t.Errorf("runtime schema omits %q", name)
		}
	}
	for _, forbidden := range []string{"origin_resource_uid", "token", "credential_file", "binding_values", "secrets", "value_digest", "preparation_id"} {
		if _, ok := runtimeSchema.Attributes[forbidden]; ok {
			t.Errorf("runtime schema exposes forbidden attribute %q", forbidden)
		}
	}
	for _, name := range []string{"space", "worker_name", "worker_resource_uid", "bundle_name", "endpoint_name"} {
		attribute, ok := runtimeSchema.Attributes[name].(resourceschema.StringAttribute)
		if !ok || !attribute.Required || len(attribute.PlanModifiers) == 0 {
			t.Errorf("%s must be a required replacement identity", name)
		}
	}
	for _, name := range []string{"material_set_id", "origin_reservation_id", "canonical_public_origin", "operation_id", "runtime_input_reference", "status", "expires_at"} {
		attribute, ok := runtimeSchema.Attributes[name].(resourceschema.StringAttribute)
		if !ok || !attribute.Computed {
			t.Errorf("%s must be computed", name)
		}
	}

	activationSchema, ok := seen["takoserver_worker_endpoint_origin_activation"]
	if !ok {
		t.Fatal("origin activation resource was not registered")
	}
	for _, name := range []string{"origin_reservation_id", "endpoint_resource_uid", "space", "worker_name", "worker_resource_uid", "endpoint_name", "canonical_public_origin", "revision", "status", "expires_at"} {
		if _, ok := activationSchema.Attributes[name]; !ok {
			t.Errorf("activation schema omits %q", name)
		}
	}
	for _, name := range []string{"origin_reservation_id", "endpoint_resource_uid"} {
		attribute, ok := activationSchema.Attributes[name].(resourceschema.StringAttribute)
		if !ok || !attribute.Required || len(attribute.PlanModifiers) == 0 {
			t.Errorf("activation %s must be a required replacement identity", name)
		}
	}
}
