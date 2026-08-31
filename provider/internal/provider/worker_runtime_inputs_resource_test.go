package provider

import (
	"context"
	"fmt"
	"io"
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
	resourceschema "github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"github.com/tako0614/takoserver/provider/internal/client"
)

func TestWorkerRuntimeInputsCreateKeepsValuesAndFilePathOutOfState(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const (
		operationID = "wri-5aa4823e81c7f50ba621a607fb3b5829"
		secretOne   = "placeholder-encryption-value"
		secretTwo   = "placeholder-client-id"
	)

	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	if err := os.WriteFile(credentialPath, []byte(`{
      "format":"takosumi.provider-credential-file@v1",
      "materialSetId":"material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5",
      "materialSetNonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "target":{
        "space":"default",
        "workerName":"yurucommu",
        "workerResourceUid":"uid-worker-01",
        "bundleName":"bundle-01",
        "originResourceUid":"uid-origin-01"
      },
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
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		if strings.Contains(string(body), "materialSetNonce") {
			t.Error("credential-file nonce was sent over the Takoserver API")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":%q,
          "preparationId":"prep-01",
          "runtimeInputReference":"rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000",
          "status":"prepared",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","workerResourceUid":"uid-worker-01","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
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
	setPlanAttribute(t, ctx, &plan, "worker_resource_uid", types.StringValue("uid-worker-01"))
	setPlanAttribute(t, ctx, &plan, "bundle_name", types.StringValue("bundle-01"))
	setPlanAttribute(t, ctx, &plan, "origin_resource_uid", types.StringValue("uid-origin-01"))
	setPlanAttribute(t, ctx, &plan, "canonical_public_origin", types.StringValue("https://community.example.test"))
	setPlanAttribute(t, ctx, &plan, "material_set_id", types.StringValue("material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5"))
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
	if state.OperationID.ValueString() != operationID || state.RuntimeInputReference.ValueString() != "rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000" || state.MaterialSetID.ValueString() != "material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5" || state.Status.ValueString() != "prepared" || state.ExpiresAt.ValueString() != "2026-08-31T18:30:00Z" {
		t.Fatalf("value-free state identity = %#v", state)
	}
	serialized := fmt.Sprintf("%#v", response.State.Raw)
	for _, forbidden := range []string{secretOne, secretTwo, credentialPath, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
		if strings.Contains(serialized, forbidden) {
			t.Errorf("state contains forbidden runtime material %q", forbidden)
		}
	}
}

func TestWorkerRuntimeInputsCreateRejectsMissingWorkerResourceUIDBeforeHTTP(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api}}
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
	setPlanAttribute(t, ctx, &plan, "material_set_id", types.StringValue("material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5"))
	setPlanAttribute(t, ctx, &plan, "binding_names", types.SetValueMust(types.StringType, []attr.Value{
		types.StringValue("ENCRYPTION_KEY"),
	}))

	response := frameworkresource.CreateResponse{
		State: tfsdk.State{
			Schema: schemaResponse.Schema,
			Raw:    tftypes.NewValue(schemaResponse.Schema.Type().TerraformType(ctx), nil),
		},
	}
	candidate.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &response)
	if !response.Diagnostics.HasError() {
		t.Fatal("Create() accepted a plan without worker_resource_uid")
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("HTTP requests = %d, want 0 for missing worker resource identity", got)
	}
}

func TestWorkerRuntimeInputsCreateRejectsPlannedMaterialSetDriftBeforeHTTP(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const fileMaterialSetID = "material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5"

	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	if err := os.WriteFile(credentialPath, []byte(`{
      "format":"takosumi.provider-credential-file@v1",
      "materialSetId":"`+fileMaterialSetID+`",
      "materialSetNonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "target":{
        "space":"default",
        "workerName":"yurucommu",
        "workerResourceUid":"uid-worker-01",
        "bundleName":"bundle-01",
        "originResourceUid":"uid-origin-01"
      },
      "canonicalPublicOrigin":"https://community.example.test",
      "values":{
        "ENCRYPTION_KEY":"placeholder-encryption-value",
        "TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id"
      }
    }`), 0o600); err != nil {
		t.Fatalf("write credential fixture: %v", err)
	}

	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
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
	setPlanAttribute(t, ctx, &plan, "worker_resource_uid", types.StringValue("uid-worker-01"))
	setPlanAttribute(t, ctx, &plan, "bundle_name", types.StringValue("bundle-01"))
	setPlanAttribute(t, ctx, &plan, "origin_resource_uid", types.StringValue("uid-origin-01"))
	setPlanAttribute(t, ctx, &plan, "canonical_public_origin", types.StringValue("https://community.example.test"))
	setPlanAttribute(t, ctx, &plan, "material_set_id", types.StringValue("material-set:v1:0000000000000000000000000000000000000000000000000000000000000000"))
	setPlanAttribute(t, ctx, &plan, "binding_names", types.SetValueMust(types.StringType, []attr.Value{
		types.StringValue("ENCRYPTION_KEY"),
		types.StringValue("TAKOSUMI_ACCOUNTS_CLIENT_ID"),
	}))

	response := frameworkresource.CreateResponse{
		State: tfsdk.State{
			Schema: schemaResponse.Schema,
			Raw:    tftypes.NewValue(schemaResponse.Schema.Type().TerraformType(ctx), nil),
		},
	}
	candidate.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &response)
	if !response.Diagnostics.HasError() {
		t.Fatal("Create() accepted a planned material set identity that differs from the credential file")
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("HTTP requests = %d, want 0 for planned material set drift", got)
	}
}

func TestWorkerRuntimeInputsCreateRejectsMaterialSetContentDriftBeforeHTTP(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const materialSetID = "material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5"

	tests := []struct {
		name       string
		nonce      string
		workerName string
		encryption string
	}{
		{name: "value", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", workerName: "yurucommu", encryption: "placeholder-encryption-value-v2"},
		{name: "nonce", nonce: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", workerName: "yurucommu", encryption: "placeholder-encryption-value"},
		{name: "target", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", workerName: "other-worker", encryption: "placeholder-encryption-value"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
			contents := fmt.Sprintf(`{
      "format":"takosumi.provider-credential-file@v1",
      "materialSetId":%q,
      "materialSetNonce":%q,
      "target":{
        "space":"default",
        "workerName":%q,
        "workerResourceUid":"uid-worker-01",
        "bundleName":"bundle-01",
        "originResourceUid":"uid-origin-01"
      },
      "canonicalPublicOrigin":"https://community.example.test",
      "values":{
        "ENCRYPTION_KEY":%q,
        "TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id"
      }
    }`, materialSetID, test.nonce, test.workerName, test.encryption)
			if err := os.WriteFile(credentialPath, []byte(contents), 0o600); err != nil {
				t.Fatalf("write credential fixture: %v", err)
			}

			var requests atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusInternalServerError)
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
			setPlanAttribute(t, ctx, &plan, "worker_resource_uid", types.StringValue("uid-worker-01"))
			setPlanAttribute(t, ctx, &plan, "bundle_name", types.StringValue("bundle-01"))
			setPlanAttribute(t, ctx, &plan, "origin_resource_uid", types.StringValue("uid-origin-01"))
			setPlanAttribute(t, ctx, &plan, "canonical_public_origin", types.StringValue("https://community.example.test"))
			setPlanAttribute(t, ctx, &plan, "material_set_id", types.StringValue(materialSetID))
			setPlanAttribute(t, ctx, &plan, "binding_names", types.SetValueMust(types.StringType, []attr.Value{
				types.StringValue("ENCRYPTION_KEY"),
				types.StringValue("TAKOSUMI_ACCOUNTS_CLIENT_ID"),
			}))

			response := frameworkresource.CreateResponse{
				State: tfsdk.State{
					Schema: schemaResponse.Schema,
					Raw:    tftypes.NewValue(schemaResponse.Schema.Type().TerraformType(ctx), nil),
				},
			}
			candidate.Create(ctx, frameworkresource.CreateRequest{Plan: plan}, &response)
			if !response.Diagnostics.HasError() {
				t.Fatal("Create() accepted material-set content drift")
			}
			if got := requests.Load(); got != 0 {
				t.Fatalf("HTTP requests = %d, want 0 for material-set content drift", got)
			}
		})
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
          "runtimeInputReference":"rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000",
          "status":"consumed",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","workerResourceUid":"uid-worker-01","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
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
		WorkerResourceUID:     types.StringValue("uid-worker-01"),
		BundleName:            types.StringValue("bundle-01"),
		OriginResourceUID:     types.StringValue("uid-origin-01"),
		CanonicalPublicOrigin: types.StringValue("https://community.example.test"),
		MaterialSetID:         types.StringValue("material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5"),
		BindingNames: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("ENCRYPTION_KEY"),
			types.StringValue("TAKOSUMI_ACCOUNTS_CLIENT_ID"),
		}),
		OperationID:           types.StringValue(operationID),
		RuntimeInputReference: types.StringValue("rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000"),
		Status:                types.StringValue("prepared"),
		ExpiresAt:             types.StringValue("2026-08-31T18:30:00Z"),
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

func TestWorkerRuntimeInputsReadRejectsWorkerResourceUIDDrift(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const operationID = "wri-3030edef9c891ef23fbde77a79b9928c"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":%q,
          "preparationId":"prep-01",
          "runtimeInputReference":"rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000",
          "status":"prepared",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","workerResourceUid":"uid-worker-02","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
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
	state := seededWorkerRuntimeInputsState(t, ctx, schemaResponse.Schema, operationID)
	response := frameworkresource.ReadResponse{State: state}
	candidate.Read(ctx, frameworkresource.ReadRequest{State: state}, &response)
	if !response.Diagnostics.HasError() {
		t.Fatal("Read() accepted worker resource identity drift")
	}
	if response.State.Raw.IsNull() {
		t.Fatal("Read() removed state after worker resource identity drift")
	}
}

func TestWorkerRuntimeInputsReadRejectsRuntimeInputReferenceDrift(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const operationID = "wri-3030edef9c891ef23fbde77a79b9928c"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":%q,
          "preparationId":"prep-02",
          "runtimeInputReference":"rip1.prep-02.0000000000000000000000000000000000000000000000000000000000000000",
          "status":"prepared",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","workerResourceUid":"uid-worker-01","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
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
	state := seededWorkerRuntimeInputsState(t, ctx, schemaResponse.Schema, operationID)
	response := frameworkresource.ReadResponse{State: state}
	candidate.Read(ctx, frameworkresource.ReadRequest{State: state}, &response)
	if !response.Diagnostics.HasError() {
		t.Fatal("Read() accepted runtime input reference drift")
	}
	if response.State.Raw.IsNull() {
		t.Fatal("Read() removed state after runtime input reference drift")
	}
}

func TestWorkerRuntimeInputsReadExpiresOrRevokesStateForSafeReplacement(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const operationID = "wri-3030edef9c891ef23fbde77a79b9928c"

	for _, status := range []string{"expired", "revoked"} {
		status := status
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Errorf("method = %s", r.Method)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprintf(w, `{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":%q,
          "preparationId":"prep-01",
          "runtimeInputReference":"rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000",
          "status":%q,
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","workerResourceUid":"uid-worker-01","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
          "canonicalPublicOrigin":"https://community.example.test",
          "bindingNames":["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]
        }`, operationID, status)
			}))
			defer server.Close()

			api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
			if err != nil {
				t.Fatalf("client.New() error = %v", err)
			}
			candidate := &workerRuntimeInputsResource{data: &providerData{client: api}}
			schemaResponse := workerRuntimeInputsSchema(t, candidate)
			state := seededWorkerRuntimeInputsState(t, ctx, schemaResponse.Schema, operationID)
			response := frameworkresource.ReadResponse{State: state}
			candidate.Read(ctx, frameworkresource.ReadRequest{State: state}, &response)
			if response.Diagnostics.HasError() {
				t.Fatalf("Read() diagnostics = %v", response.Diagnostics)
			}
			if !response.State.Raw.IsNull() {
				t.Fatalf("state raw = %s, want null after %s preparation", response.State.Raw, status)
			}
		})
	}
}

func TestWorkerRuntimeInputsReadFailsClosedForIndeterminateState(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const operationID = "wri-3030edef9c891ef23fbde77a79b9928c"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":%q,
          "preparationId":"prep-01",
          "runtimeInputReference":"rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000",
          "status":"indeterminate",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","workerResourceUid":"uid-worker-01","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
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
	state := seededWorkerRuntimeInputsState(t, ctx, schemaResponse.Schema, operationID)
	response := frameworkresource.ReadResponse{State: state}
	candidate.Read(ctx, frameworkresource.ReadRequest{State: state}, &response)
	if !response.Diagnostics.HasError() {
		t.Fatal("Read() did not fail closed for indeterminate preparation")
	}
	if response.State.Raw.IsNull() {
		t.Fatal("Read() removed state for indeterminate preparation")
	}
}

func TestWorkerRuntimeInputsPartialApplyExpiryThenFreshMaterial(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const (
		initialMaterialSetID = "material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5"
		freshMaterialSetID   = "material-set:v1:50528a97f19d7e42cd510b8dee12abd171ac483ad231866ac1b08e7d22faa62d"
		initialOperationID   = "wri-5aa4823e81c7f50ba621a607fb3b5829"
		freshOperationID     = "wri-296e323f4c0a2ff4f1b9f648a4cd4342"
	)

	credentialPath := filepath.Join(t.TempDir(), "runtime-inputs.json")
	writeCredential := func(t *testing.T, materialSetID, nonce, encryption string) {
		t.Helper()
		contents := fmt.Sprintf(`{
      "format":"takosumi.provider-credential-file@v1",
      "materialSetId":%q,
      "materialSetNonce":%q,
      "target":{
        "space":"default",
        "workerName":"yurucommu",
        "workerResourceUid":"uid-worker-01",
        "bundleName":"bundle-01",
        "originResourceUid":"uid-origin-01"
      },
      "canonicalPublicOrigin":"https://community.example.test",
      "values":{
        "ENCRYPTION_KEY":%q,
        "TAKOSUMI_ACCOUNTS_CLIENT_ID":"placeholder-client-id"
      }
    }`, materialSetID, nonce, encryption)
		if err := os.WriteFile(credentialPath, []byte(contents), 0o600); err != nil {
			t.Fatalf("write credential fixture: %v", err)
		}
	}
	writeCredential(t, initialMaterialSetID, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "placeholder-encryption-value")

	var puts atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":%q,
          "preparationId":"prep-01",
          "runtimeInputReference":"rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000",
          "status":"expired",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","workerResourceUid":"uid-worker-01","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
          "canonicalPublicOrigin":"https://community.example.test",
          "bindingNames":["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]
        }`, initialOperationID)
			return
		}
		if r.Method != http.MethodPut {
			t.Errorf("method = %s", r.Method)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		call := puts.Add(1)
		operationID := initialOperationID
		if call == 2 {
			operationID = freshOperationID
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{
          "format":"takoserver.worker-runtime-input-preparation@v1",
          "operationId":%q,
          "preparationId":"prep-%d",
          "runtimeInputReference":"rip1.prep-%d.0000000000000000000000000000000000000000000000000000000000000000",
          "status":"prepared",
          "expiresAt":"2026-08-31T18:30:00Z",
          "target":{"space":"default","workerName":"yurucommu","workerResourceUid":"uid-worker-01","bundleName":"bundle-01","originResourceUid":"uid-origin-01"},
          "canonicalPublicOrigin":"https://community.example.test",
          "bindingNames":["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]
        }`, operationID, call, call)
	}))
	defer server.Close()

	api, err := client.New(server.URL, "provider-token", "org-01", server.Client())
	if err != nil {
		t.Fatalf("client.New() error = %v", err)
	}
	candidate := &workerRuntimeInputsResource{data: &providerData{client: api, credentialFilePath: credentialPath}}
	schemaResponse := workerRuntimeInputsSchema(t, candidate)
	initialPlan := runtimeInputCreatePlan(t, ctx, schemaResponse.Schema, initialMaterialSetID)
	initialResponse := frameworkresource.CreateResponse{
		State: tfsdk.State{
			Schema: schemaResponse.Schema,
			Raw:    tftypes.NewValue(schemaResponse.Schema.Type().TerraformType(ctx), nil),
		},
	}
	candidate.Create(ctx, frameworkresource.CreateRequest{Plan: initialPlan}, &initialResponse)
	if initialResponse.Diagnostics.HasError() {
		t.Fatalf("initial Create() diagnostics = %v", initialResponse.Diagnostics)
	}

	var initialState workerRuntimeInputsModel
	if diagnostics := initialResponse.State.Get(ctx, &initialState); diagnostics.HasError() {
		t.Fatalf("read initial state: %v", diagnostics)
	}
	readResponse := frameworkresource.ReadResponse{State: initialResponse.State}
	candidate.Read(ctx, frameworkresource.ReadRequest{State: initialResponse.State}, &readResponse)
	if readResponse.Diagnostics.HasError() {
		t.Fatalf("expired Read() diagnostics = %v", readResponse.Diagnostics)
	}
	if !readResponse.State.Raw.IsNull() {
		t.Fatal("expired preparation remained in state")
	}

	writeCredential(t, freshMaterialSetID, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "placeholder-encryption-value-v2")
	freshPlan := runtimeInputCreatePlan(t, ctx, schemaResponse.Schema, freshMaterialSetID)
	freshResponse := frameworkresource.CreateResponse{
		State: tfsdk.State{
			Schema: schemaResponse.Schema,
			Raw:    tftypes.NewValue(schemaResponse.Schema.Type().TerraformType(ctx), nil),
		},
	}
	candidate.Create(ctx, frameworkresource.CreateRequest{Plan: freshPlan}, &freshResponse)
	if freshResponse.Diagnostics.HasError() {
		t.Fatalf("fresh Create() diagnostics = %v", freshResponse.Diagnostics)
	}
	if got := puts.Load(); got != 2 {
		t.Fatalf("PUT requests = %d, want initial plus fresh material", got)
	}
	var freshState workerRuntimeInputsModel
	if diagnostics := freshResponse.State.Get(ctx, &freshState); diagnostics.HasError() {
		t.Fatalf("read fresh state: %v", diagnostics)
	}
	if freshState.MaterialSetID.ValueString() != freshMaterialSetID || freshState.OperationID.ValueString() != freshOperationID {
		t.Fatalf("fresh state identity = %#v", freshState)
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
		WorkerResourceUID:     types.StringValue("uid-worker-01"),
		BundleName:            types.StringValue("bundle-01"),
		OriginResourceUID:     types.StringValue("uid-origin-01"),
		CanonicalPublicOrigin: types.StringValue("https://community.example.test"),
		MaterialSetID:         types.StringValue("material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5"),
		BindingNames: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("ENCRYPTION_KEY"),
			types.StringValue("TAKOSUMI_ACCOUNTS_CLIENT_ID"),
		}),
		OperationID:           types.StringValue(operationID),
		RuntimeInputReference: types.StringValue("rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000"),
		Status:                types.StringValue("prepared"),
		ExpiresAt:             types.StringValue("2026-08-31T18:30:00Z"),
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

func seededWorkerRuntimeInputsState(t *testing.T, ctx context.Context, schema resourceschema.Schema, operationID string) tfsdk.State {
	t.Helper()
	state := tfsdk.State{
		Schema: schema,
		Raw:    tftypes.NewValue(schema.Type().TerraformType(ctx), nil),
	}
	initial := workerRuntimeInputsModel{
		Space:                 types.StringValue("default"),
		WorkerName:            types.StringValue("yurucommu"),
		WorkerResourceUID:     types.StringValue("uid-worker-01"),
		BundleName:            types.StringValue("bundle-01"),
		OriginResourceUID:     types.StringValue("uid-origin-01"),
		CanonicalPublicOrigin: types.StringValue("https://community.example.test"),
		MaterialSetID:         types.StringValue("material-set:v1:99d9cd8119da6244a528128b04077c06ade70382d7c064a0f600ba6405b81bc5"),
		BindingNames: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("ENCRYPTION_KEY"),
			types.StringValue("TAKOSUMI_ACCOUNTS_CLIENT_ID"),
		}),
		OperationID:           types.StringValue(operationID),
		RuntimeInputReference: types.StringValue("rip1.prep-01.0000000000000000000000000000000000000000000000000000000000000000"),
		Status:                types.StringValue("prepared"),
		ExpiresAt:             types.StringValue("2026-08-31T18:30:00Z"),
	}
	if diagnostics := state.Set(ctx, &initial); diagnostics.HasError() {
		t.Fatalf("seed state: %v", diagnostics)
	}
	return state
}

func runtimeInputCreatePlan(t *testing.T, ctx context.Context, schema resourceschema.Schema, materialSetID string) tfsdk.Plan {
	t.Helper()
	plan := tfsdk.Plan{
		Schema: schema,
		Raw:    tftypes.NewValue(schema.Type().TerraformType(ctx), nil),
	}
	setPlanAttribute(t, ctx, &plan, "space", types.StringValue("default"))
	setPlanAttribute(t, ctx, &plan, "worker_name", types.StringValue("yurucommu"))
	setPlanAttribute(t, ctx, &plan, "worker_resource_uid", types.StringValue("uid-worker-01"))
	setPlanAttribute(t, ctx, &plan, "bundle_name", types.StringValue("bundle-01"))
	setPlanAttribute(t, ctx, &plan, "origin_resource_uid", types.StringValue("uid-origin-01"))
	setPlanAttribute(t, ctx, &plan, "canonical_public_origin", types.StringValue("https://community.example.test"))
	setPlanAttribute(t, ctx, &plan, "material_set_id", types.StringValue(materialSetID))
	setPlanAttribute(t, ctx, &plan, "binding_names", types.SetValueMust(types.StringType, []attr.Value{
		types.StringValue("ENCRYPTION_KEY"),
		types.StringValue("TAKOSUMI_ACCOUNTS_CLIENT_ID"),
	}))
	return plan
}
