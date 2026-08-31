// Package provider implements the Takoserver-owned OpenTofu provider for
// Takoserver control operations that do not belong in the Takoform Provider.
package provider

import (
	"context"
	"net/http"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	frameworkprovider "github.com/hashicorp/terraform-plugin-framework/provider"
	providerschema "github.com/hashicorp/terraform-plugin-framework/provider/schema"
	frameworkresource "github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/tako0614/takoserver/provider/internal/client"
)

const (
	envEndpoint       = "TAKOSERVER_ENDPOINT"
	envToken          = "TAKOSERVER_TOKEN"
	envOrganizationID = "TAKOSERVER_ORGANIZATION_ID"
	envCredentialFile = "TAKOSERVER_RUNTIME_INPUTS_FILE"
)

var _ frameworkprovider.Provider = (*takoserverProvider)(nil)

type takoserverProvider struct {
	version string
}

type providerModel struct {
	Endpoint       types.String `tfsdk:"endpoint"`
	Token          types.String `tfsdk:"token"`
	OrganizationID types.String `tfsdk:"organization_id"`
}

type providerData struct {
	client             *client.Client
	credentialFilePath string
}

// New returns a provider factory bound to one build version.
func New(version string) func() frameworkprovider.Provider {
	return func() frameworkprovider.Provider {
		return &takoserverProvider{version: version}
	}
}

func (p *takoserverProvider) Metadata(_ context.Context, _ frameworkprovider.MetadataRequest, response *frameworkprovider.MetadataResponse) {
	response.TypeName = "takoserver"
	response.Version = p.version
}

func (p *takoserverProvider) Schema(_ context.Context, _ frameworkprovider.SchemaRequest, response *frameworkprovider.SchemaResponse) {
	response.Schema = providerschema.Schema{
		Description: "Takoserver control operations that remain outside the provider-neutral Takoform Host API.",
		Attributes: map[string]providerschema.Attribute{
			"endpoint": providerschema.StringAttribute{
				Optional:    true,
				Description: "Takoserver control origin. May also be set with " + envEndpoint + ".",
			},
			"token": providerschema.StringAttribute{
				Optional:    true,
				Sensitive:   true,
				Description: "Takoserver bearer token. May also be set with " + envToken + ".",
			},
			"organization_id": providerschema.StringAttribute{
				Optional:    true,
				Description: "Exact Takoserver organization identity. May also be set with " + envOrganizationID + ".",
			},
		},
	}
}

func (p *takoserverProvider) Configure(ctx context.Context, request frameworkprovider.ConfigureRequest, response *frameworkprovider.ConfigureResponse) {
	var config providerModel
	response.Diagnostics.Append(request.Config.Get(ctx, &config)...)
	if response.Diagnostics.HasError() {
		return
	}
	if config.Endpoint.IsUnknown() || config.Token.IsUnknown() || config.OrganizationID.IsUnknown() {
		response.Diagnostics.AddError("Unknown Takoserver provider configuration", "Endpoint, token, and organization identity must be known before planning runtime inputs.")
		return
	}

	endpoint := firstNonEmpty(config.Endpoint.ValueString(), os.Getenv(envEndpoint))
	token := firstNonEmpty(config.Token.ValueString(), os.Getenv(envToken))
	organizationID := firstNonEmpty(config.OrganizationID.ValueString(), os.Getenv(envOrganizationID))
	api, err := client.New(endpoint, token, organizationID, http.DefaultClient)
	if err != nil {
		response.Diagnostics.AddError("Invalid Takoserver provider configuration", err.Error())
		return
	}
	data := &providerData{
		client:             api,
		credentialFilePath: os.Getenv(envCredentialFile),
	}
	response.ResourceData = data
}

func (p *takoserverProvider) Resources(_ context.Context) []func() frameworkresource.Resource {
	return []func() frameworkresource.Resource{NewWorkerRuntimeInputsResource}
}

func (p *takoserverProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
