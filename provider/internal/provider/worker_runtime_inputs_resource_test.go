package provider

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/path"
	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"github.com/tako0614/takoserver/provider/internal/client"
)

func TestWorkerRuntimeInputsCreateKeepsValuesAndFilePathOutOfState(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const (
		operationID = "wri-3030edef9c891ef23fbde77a79b9928c"
		secretOne   = "placeholder-encryption-value"
		secretTwo   = "placeholder-client-id"
	)

	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	if err := os.WriteFile(credentialPath, []byte(`{
      "format":"takosumi.provider-credential-file@v1",
      "materialSetId":"material-set-01",
      "canonicalPublicOrigin":"https://community.example.test",
      "values":{
        "ENCRYPTION_KEY":"`+secretOne+`",
        "TAKOSUMI_ACCOUNTS_CLIENT_ID":"`+secretTwo+`"
      }
    }`), 0o600); err != nil {
		t.Fatalf("write credential fixture: %v", err)
	}

	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.EscapedPath() != "/v1/organizations/org-01/worker-runtime-input-preparations/"+operationID {
			t.Errorf("request path = %s", r.URL.EscapedPath())
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":%q,
          "preparationId":"prep-01",
          "status":"prepared",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
          "canonicalPublicOrigin":"https://community.example.test",
          "bindingNames":["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]
        }`, operationID)
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api, credentialFilePath: credentialPath}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	plan := tfsdk.Plan{
		Schema: schemaResponse.Schema,
		Raw:    tftypes.NewValue(schemaResponse.Schema.Type().TerraformType(ctx), nil),
	}
	setPlanAttribute(t, ctx, &plan, "space", types.StringValue("default"))
	setPlanAttribute(t, ctx, &plan, "worker_name", types.StringValue("yurucommu"))
	setPlanAttribute(t, ctx, &plan, "bundle_name", types.StringValue("bundle-01"))
	setPlanAttribute(t, ctx, &plan, "origin_resource_uid", types.StringValue("uid-origin-01"))
	setPlanAttribute(t, ctx, &plan, "canonical_public_origin", types.StringValue("https://community.example.test"))
	setPlanAttribute(t, ctx, &plan, "binding_names", types.SetValueMust(types.StringType, []attr.Value{
		types.StringValue("TAKOSUMI_ACCOUNTS_CLIENT_ID"),
		types.StringValue("ENCRYPTION_KEY"),
	}))

	response := frameworkresource.CreateResponse{
		State: tfsdk.State{
			Schema: schemaResponse.Schema,
			Raw:    tftypes.NewValue(schemaResponse.Schema.Type().TerraformType(ctx), nil),
		},
	}
	candidate.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("Create() diagnostics = %v", response.Diagnostics)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("HTTP requests = %d, want 1", got)
	}

	var state workerRuntimeInputsModel
	if diagnostics := response.State.Get(ctx, &state); diagnostics.HasError() {
		t.Fatalf("read state: %v", diagnostics)
	}
	if state.OperationID.ValueString() != operationID || state.PreparationID.ValueString() != "prep-01" || state.Status.ValueString() != "prepared" || state.ExpiresAt.ValueString() != "2026-08-31T18:30:00Z" {
		t.Fatalf("value-free state identity = %#v", state)
	}
	serialized := fmt.Sprintf("%#v", response.State.Raw)
	for _, forbidden := range []string{secretOne, secretTwo, credentialPath, "material-set-01"} {
		if strings.Contains(serialized, forbidden) {
			t.Errorf("state contains forbidden runtime material %q", forbidden)
		}
	}
}

func TestWorkerRuntimeInputsReadAdoptsTheValueFreeDurableStatus(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const operationID = "wri-3030edef9c891ef23fbde77a79b9928c"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":%q,
          "preparationId":"prep-01",
          "status":"consumed",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
          "canonicalPublicOrigin":"https://community.example.test",
          "bindingNames":["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]
        }`, operationID)
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	state := tfsdk.State{
		Schema: schemaResponse.Schema,
		Raw:    tftypes.NewValue(schemaResponse.Schema.Type().TerraformType(ctx), nil),
	}
	initial := workerRuntimeInputsModel{
		Space:                 types.StringValue("default"),
		WorkerName:            types.StringValue("yurucommu"),
		BundleName:            types.StringValue("bundle-01"),
		OriginResourceUID:     types.StringValue("uid-origin-01"),
		CanonicalPublicOrigin: types.StringValue("https://community.example.test"),
		BindingNames: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("ENCRYPTION_KEY"),
			types.StringValue("TAKOSUMI_ACCOUNTS_CLIENT_ID"),
		}),
		OperationID:   types.StringValue(operationID),
		PreparationID: types.StringValue("prep-01"),
		Status:        types.StringValue("prepared"),
		ExpiresAt:     types.StringValue("2026-08-31T18:30:00Z"),
	}
	if diagnostics := state.Set(ctx, &initial); diagnostics.HasError() {
		t.Fatalf("seed state: %v", diagnostics)
	}
	response := frameworkresource.ReadResponse{State: state}
	candidate.Read(ctx, frameworkresource.ReadRequest{State: state}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("Read() diagnostics = %v", response.Diagnostics)
	}
	var got workerRuntimeInputsModel
	if diagnostics := response.State.Get(ctx, &got); diagnostics.HasError() {
		t.Fatalf("read state: %v", diagnostics)
	}
	if got.Status.ValueString() != "consumed" {
		t.Fatalf("status = %q, want consumed", got.Status.ValueString())
	}
}

func TestWorkerRuntimeInputsDeleteRevokesTheExactOperation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const operationID = "wri-3030edef9c891ef23fbde77a79b9928c"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("method = %s", r.Method)
		}
		if r.URL.EscapedPath() != "/v1/organizations/org-01/worker-runtime-input-preparations/"+operationID {
			t.Errorf("path = %s", r.URL.EscapedPath())
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	state := tfsdk.State{
		Schema: schemaResponse.Schema,
		Raw:    tftypes.NewValue(schemaResponse.Schema.Type().TerraformType(ctx), nil),
	}
	initial := workerRuntimeInputsModel{
		Space:                 types.StringValue("default"),
		WorkerName:            types.StringValue("yurucommu"),
		BundleName:            types.StringValue("bundle-01"),
		OriginResourceUID:     types.StringValue("uid-origin-01"),
		CanonicalPublicOrigin: types.StringValue("https://community.example.test"),
		BindingNames: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("ENCRYPTION_KEY"),
			types.StringValue("TAKOSUMI_ACCOUNTS_CLIENT_ID"),
		}),
		OperationID:   types.StringValue(operationID),
		PreparationID: types.StringValue("prep-01"),
		Status:        types.StringValue("prepared"),
		ExpiresAt:     types.StringValue("2026-08-31T18:30:00Z"),
	}
	if diagnostics := state.Set(ctx, &initial); diagnostics.HasError() {
		t.Fatalf("seed state: %v", diagnostics)
	}
	var response frameworkresource.DeleteResponse
	candidate.Delete(ctx, frameworkresource.DeleteRequest{State: state}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("Delete() diagnostics = %v", response.Diagnostics)
	}
}

func workerRuntimeInputsSchema(t *testing.T, candidate frameworkresource.Resource) frameworkresource.SchemaResponse {
	t.Helper()
	var response frameworkresource.SchemaResponse
	candidate.Schema(context.Background(), frameworkresource.SchemaRequest{}, &response)
	if response.Diagnostics.HasError() {
		t.Fatalf("schema diagnostics = %v", response.Diagnostics)
	}
	return response
}

func setPlanAttribute(t *testing.T, ctx context.Context, plan *tfsdk.Plan, name string, value attr.Value) {
	t.Helper()
	if diagnostics := plan.SetAttribute(ctx, path.Root(name), value); diagnostics.HasError() {
		t.Fatalf("set plan %s: %v", name, diagnostics)
	}
}
