package main

import (
	"context"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/tako0614/takoserver/provider/internal/provider"
)

var version = "dev"

func main() {
	if err := providerserver.Serve(
		context.Background(),
		provider.New(version),
		providerserver.ServeOpts{Address: "registry.terraform.io/tako0614/takoserver"},
	); err != nil {
		log.Fatal(err)
	}
}
