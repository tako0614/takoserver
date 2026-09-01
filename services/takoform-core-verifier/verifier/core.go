package verifier

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"testing/fstest"

	"github.com/tako0614/takoform/formpackage"
	"github.com/tako0614/takoform/trust"
)

type ReleasedCore struct{}

func (ReleasedCore) Verify(input CoreInput) (CoreResult, error) {
	policy, err := trust.ParsePublisherPolicy(input.PublisherPolicy)
	if err != nil {
		return CoreResult{}, fmt.Errorf("publisher policy: %w", err)
	}
	previous := toCorePin(input.PreviousCheckpoint)
	checkpointVerification, err := trust.VerifyRevocationCheckpoint(
		input.Checkpoint,
		input.CheckpointBundle,
		input.TrustedRoot,
		policy,
		previous,
	)
	if err != nil {
		return CoreResult{}, fmt.Errorf("revocation checkpoint: %w", err)
	}
	checkpoint, err := formpackage.ValidateRevocationCheckpoint(input.Checkpoint)
	if err != nil {
		return CoreResult{}, fmt.Errorf("validated revocation checkpoint: %w", err)
	}

	verifiedPackages := make([]VerifiedPackage, 0, len(input.Packages))
	var publisher PublisherVerification
	for index, candidate := range input.Packages {
		packageReport, err := verifyPackageClosure(candidate)
		if err != nil {
			return CoreResult{}, fmt.Errorf("package %s: %w", candidate.PackageDigest, err)
		}
		if packageReport.PackageDigest != candidate.PackageDigest {
			return CoreResult{}, fmt.Errorf("package %s: Core package digest mismatch", candidate.PackageDigest)
		}
		verifiedFormRef, err := json.Marshal(packageReport.FormRef)
		if err != nil {
			return CoreResult{}, fmt.Errorf("package %s FormRef: %w", candidate.PackageDigest, err)
		}
		if !sameCanonicalJSON(candidate.FormRef, verifiedFormRef) {
			return CoreResult{}, fmt.Errorf("package %s: Core FormRef mismatch", candidate.PackageDigest)
		}
		bundleReport, err := trust.VerifyBundle(candidate.Index, candidate.Bundle, input.TrustedRoot, policy)
		if err != nil {
			return CoreResult{}, fmt.Errorf("package %s bundle: %w", candidate.PackageDigest, err)
		}
		if bundleReport.SubjectDigest != candidate.PackageDigest {
			return CoreResult{}, fmt.Errorf("package %s: signed subject digest mismatch", candidate.PackageDigest)
		}
		if err := requireExpectedSource(bundleReport, input.ExpectedSourceCommit); err != nil {
			return CoreResult{}, fmt.Errorf("package %s provenance: %w", candidate.PackageDigest, err)
		}
		if err := checkpointVerification.CheckNotRevoked(candidate.PackageDigest, packageReport.FormRef); err != nil {
			return CoreResult{}, fmt.Errorf("package %s revocation: %w", candidate.PackageDigest, err)
		}
		candidatePublisher := publisherFromBundle(input.PublisherPolicy, bundleReport)
		if index == 0 {
			publisher = candidatePublisher
		} else if publisher != candidatePublisher {
			return CoreResult{}, fmt.Errorf("package %s: publisher evidence differs within set", candidate.PackageDigest)
		}
		verifiedPackages = append(verifiedPackages, VerifiedPackage{
			PackageDigest: candidate.PackageDigest,
			FormRef:       append(json.RawMessage(nil), verifiedFormRef...),
			BundleDigest:  bundleReport.BundleDigest,
		})
	}
	if err := requireExpectedSource(checkpointVerification.Bundle, input.ExpectedSourceCommit); err != nil {
		return CoreResult{}, fmt.Errorf("checkpoint provenance: %w", err)
	}
	if publisher != publisherFromBundle(input.PublisherPolicy, checkpointVerification.Bundle) {
		return CoreResult{}, fmt.Errorf("checkpoint publisher evidence differs from package set")
	}

	revoked := make([]string, 0, len(checkpoint.Entries))
	seen := make(map[string]struct{}, len(checkpoint.Entries))
	for _, entry := range checkpoint.Entries {
		if _, duplicate := seen[entry.PackageDigest]; duplicate {
			continue
		}
		seen[entry.PackageDigest] = struct{}{}
		revoked = append(revoked, entry.PackageDigest)
	}
	sort.Strings(revoked)
	previousDigest := ""
	if checkpoint.PreviousCheckpointDigest != nil {
		previousDigest = *checkpoint.PreviousCheckpointDigest
	}
	return CoreResult{
		Publisher: publisher,
		Checkpoint: CheckpointVerification{
			CheckpointAPIVersion:  checkpointVerification.Pin.CheckpointAPIVersion,
			Sequence:              checkpointVerification.Pin.Sequence,
			Digest:                checkpointVerification.Pin.Digest,
			EntriesDigest:         checkpointVerification.Pin.EntriesDigest,
			PreviousDigest:        previousDigest,
			BundleDigest:          checkpointVerification.Bundle.BundleDigest,
			RevokedPackageDigests: revoked,
		},
		Packages: verifiedPackages,
	}, nil
}

func verifyPackageClosure(candidate Package) (formpackage.VerificationReport, error) {
	closure := fstest.MapFS{
		"package/package-index.json": &fstest.MapFile{Data: append([]byte(nil), candidate.Index...), Mode: 0o444},
	}
	for _, file := range candidate.Files {
		closure["package/"+file.Path] = &fstest.MapFile{Data: append([]byte(nil), file.Bytes...), Mode: 0o444}
	}
	return formpackage.VerifyFS(closure, "package")
}

func toCorePin(pin *CheckpointPin) *formpackage.RevocationCheckpointPin {
	if pin == nil {
		return nil
	}
	return &formpackage.RevocationCheckpointPin{
		CheckpointAPIVersion: pin.CheckpointAPIVersion,
		Sequence:             pin.Sequence,
		Digest:               pin.Digest,
		EntriesDigest:        pin.EntriesDigest,
	}
}

func publisherFromBundle(policy []byte, report trust.BundleVerification) PublisherVerification {
	return PublisherVerification{
		PolicyDigest:      formpackage.DigestBytes(policy),
		TrustedRootDigest: report.TrustedRootDigest,
		OIDCIssuer:        report.OIDCIssuer,
		SourceRepository:  report.SourceRepository,
		Workflow:          report.Workflow,
		Ref:               report.Ref,
		Identity:          report.PublisherIdentity,
		SourceCommit:      report.SourceCommit,
		WorkflowCommit:    report.WorkflowCommit,
		BuildConfigCommit: report.BuildConfigCommit,
	}
}

func requireExpectedSource(report trust.BundleVerification, expected string) error {
	if report.SourceCommit != expected || report.WorkflowCommit != expected || report.BuildConfigCommit != expected {
		return fmt.Errorf("authenticated source/workflow/build commits do not equal expected source commit")
	}
	return nil
}

func sameCanonicalJSON(left, right []byte) bool {
	leftCanonical, leftErr := formpackage.Canonicalize(left)
	rightCanonical, rightErr := formpackage.Canonicalize(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftCanonical, rightCanonical)
}
