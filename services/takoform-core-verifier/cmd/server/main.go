package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/tako0614/takoserver/services/takoform-core-verifier/server"
	"github.com/tako0614/takoserver/services/takoform-core-verifier/verifier"
)

func main() {
	artifactDigest := os.Getenv("TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST")
	if !verifier.ValidArtifactDigest(artifactDigest) {
		log.Fatal("TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST must be one canonical sha256 digest")
	}
	service := verifier.New(verifier.ReleasedCore{}, verifier.Identity{ArtifactDigest: artifactDigest})
	httpServer := &http.Server{
		Addr:              ":8080",
		Handler:           server.NewHandler(service),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       30 * time.Second,
	}
	log.Fatal(httpServer.ListenAndServe())
}
