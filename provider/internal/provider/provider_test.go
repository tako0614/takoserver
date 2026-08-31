package provider_test

import (
	"context"
	"testing"

	frameworkprovider "github.com/hashicorp/terraform-plugin-framework/provider"
	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	resourceschema "github.com/hashicorp/terraform-plugin-framework/resource/schema"

	takoserverprovider "github.com/tako0614/takoserver/provider/internal/provider"
)

func TestProviderExposesOneValueFreeRuntimeInputResource(t *testing.T) {
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
	if len(factories) != 1 {
		t.Fatalf("resource count = %d, want 1", len(factories))
	}
	resource := factories[0]()
	var resourceMetadata frameworkresource.MetadataResponse
	resource.Metadata(ctx, frameworkresource.MetadataRequest{ProviderTypeName: "takoserver"}, &resourceMetadata)
	if resourceMetadata.TypeName != "takoserver_worker_runtime_inputs" {
		t.Fatalf("resource type = %q", resourceMetadata.TypeName)
	}

	var resourceSchema frameworkresource.SchemaResponse
	resource.Schema(ctx, frameworkresource.SchemaRequest{}, &resourceSchema)
	if resourceSchema.Diagnostics.HasError() {
		t.Fatalf("resource schema diagnostics = %v", resourceSchema.Diagnostics)
	}
	for _, name := range []string{
		"space",
		"worker_name",
		"worker_resource_uid",
		"bundle_name",
		"origin_resource_uid",
		"canonical_public_origin",
		"binding_names",
		"material_set_id",
		"operation_id",
		"runtime_input_reference",
		"status",
		"expires_at",
	} {
		if _, ok := resourceSchema.Schema.Attributes[name]; !ok {
			t.Errorf("resource schema omits %q", name)
		}
	}
	for _, forbidden := range []string{"token", "credential_file", "binding_values", "secrets", "value_digest", "preparation_id"} {
		if _, ok := resourceSchema.Schema.Attributes[forbidden]; ok {
			t.Errorf("resource state exposes forbidden attribute %q", forbidden)
		}
	}
	for _, name := range []string{"space", "worker_name", "worker_resource_uid", "bundle_name", "origin_resource_uid", "canonical_public_origin", "material_set_id"} {
		attribute, ok := resourceSchema.Schema.Attributes[name].(resourceschema.StringAttribute)
		if !ok || !attribute.Required || len(attribute.PlanModifiers) == 0 {
			t.Errorf("%s must replace instead of mutating a preparation in place", name)
		}
	}
	for _, name := range []string{"operation_id", "runtime_input_reference", "status", "expires_at"} {
		attribute, ok := resourceSchema.Schema.Attributes[name].(resourceschema.StringAttribute)
		if !ok || !attribute.Computed {
			t.Errorf("%s must be computed from the Takoserver projection", name)
		}
	}
	bindingNames, ok := resourceSchema.Schema.Attributes["binding_names"].(resourceschema.SetAttribute)
	if !ok || len(bindingNames.PlanModifiers) == 0 {
		t.Error("binding_names must replace instead of mutating a preparation in place")
	}
}
