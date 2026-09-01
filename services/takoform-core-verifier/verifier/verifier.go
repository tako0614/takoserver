// Package verifier owns the bounded, set-level adapter around released Takoform Core.
package verifier

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
)

const (
	Protocol    = "takoserver.takoform-core-verifier@v1"
	CoreVersion = "v1.1.0"
	CoreCommit  = "e0e48b864de2a127a255cb0574d37bbb0f1cac29"

	MaxPackages        = 32
	MaxFilesPerPackage = 512
	MaxPackageBytes    = 16 << 20
	MaxSetBytes        = 32 << 20
)

var (
	ErrInvalidRequest = errors.New("invalid verifier request")
	commitPattern     = regexp.MustCompile(`^[0-9a-f]{40}$`)
	digestPattern     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

type Identity struct {
	Protocol       string `json:"protocol"`
	CoreVersion    string `json:"coreVersion"`
	CoreCommit     string `json:"coreCommit"`
	ArtifactDigest string `json:"artifactDigest"`
}

type CheckpointPin struct {
	CheckpointAPIVersion string `json:"checkpointApiVersion,omitempty"`
	Sequence             uint64 `json:"sequence"`
	Digest               string `json:"digest"`
	EntriesDigest        string `json:"entriesDigest"`
}

type File struct {
	Path  string `json:"path"`
	Bytes []byte `json:"bytes"`
}

type Package struct {
	PackageDigest string          `json:"packageDigest"`
	FormRef       json.RawMessage `json:"formRef"`
	Index         []byte          `json:"index"`
	Bundle        []byte          `json:"bundle"`
	Files         []File          `json:"files"`
}

type Request struct {
	Protocol             string         `json:"protocol"`
	ExpectedSourceCommit string         `json:"expectedSourceCommit"`
	PublisherPolicy      []byte         `json:"publisherPolicy"`
	TrustedRoot          []byte         `json:"trustedRoot"`
	Checkpoint           []byte         `json:"checkpoint"`
	CheckpointBundle     []byte         `json:"checkpointBundle"`
	PreviousCheckpoint   *CheckpointPin `json:"previousCheckpoint,omitempty"`
	Packages             []Package      `json:"packages"`
}

type PublisherVerification struct {
	PolicyDigest      string `json:"policyDigest"`
	TrustedRootDigest string `json:"trustedRootDigest"`
	OIDCIssuer        string `json:"oidcIssuer"`
	SourceRepository  string `json:"sourceRepository"`
	Workflow          string `json:"workflow"`
	Ref               string `json:"ref"`
	Identity          string `json:"identity"`
	SourceCommit      string `json:"sourceCommit"`
	WorkflowCommit    string `json:"workflowCommit"`
	BuildConfigCommit string `json:"buildConfigCommit"`
}

type CheckpointVerification struct {
	CheckpointAPIVersion  string   `json:"checkpointApiVersion"`
	Sequence              uint64   `json:"sequence"`
	Digest                string   `json:"digest"`
	EntriesDigest         string   `json:"entriesDigest"`
	PreviousDigest        string   `json:"previousDigest,omitempty"`
	BundleDigest          string   `json:"bundleDigest"`
	RevokedPackageDigests []string `json:"revokedPackageDigests"`
}

type VerifiedPackage struct {
	PackageDigest string          `json:"packageDigest"`
	FormRef       json.RawMessage `json:"formRef"`
	BundleDigest  string          `json:"bundleDigest"`
}

type CoreInput struct {
	ExpectedSourceCommit string
	PublisherPolicy      []byte
	TrustedRoot          []byte
	Checkpoint           []byte
	CheckpointBundle     []byte
	PreviousCheckpoint   *CheckpointPin
	Packages             []Package
}

type CoreResult struct {
	Publisher  PublisherVerification  `json:"publisher"`
	Checkpoint CheckpointVerification `json:"checkpoint"`
	Packages   []VerifiedPackage      `json:"packages"`
}

type Response struct {
	Identity   Identity               `json:"identity"`
	Publisher  PublisherVerification  `json:"publisher"`
	Checkpoint CheckpointVerification `json:"checkpoint"`
	Packages   []VerifiedPackage      `json:"packages"`
}

type Core interface {
	Verify(CoreInput) (CoreResult, error)
}

type Service struct {
	core     Core
	identity Identity
}

func New(core Core, identity Identity) *Service {
	identity.Protocol = Protocol
	identity.CoreVersion = CoreVersion
	identity.CoreCommit = CoreCommit
	return &Service{core: core, identity: identity}
}

func ValidArtifactDigest(value string) bool { return digestPattern.MatchString(value) }

func (service *Service) Identity() Identity { return service.identity }

func (service *Service) VerifySet(ctx context.Context, request Request) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	if service == nil || service.core == nil || !digestPattern.MatchString(service.identity.ArtifactDigest) {
		return Response{}, fmt.Errorf("%w: verifier identity is incomplete", ErrInvalidRequest)
	}
	if err := validateRequest(request); err != nil {
		return Response{}, err
	}
	result, err := service.core.Verify(CoreInput{
		ExpectedSourceCommit: request.ExpectedSourceCommit,
		PublisherPolicy:      append([]byte(nil), request.PublisherPolicy...),
		TrustedRoot:          append([]byte(nil), request.TrustedRoot...),
		Checkpoint:           append([]byte(nil), request.Checkpoint...),
		CheckpointBundle:     append([]byte(nil), request.CheckpointBundle...),
		PreviousCheckpoint:   clonePin(request.PreviousCheckpoint),
		Packages:             clonePackages(request.Packages),
	})
	if err != nil {
		return Response{}, err
	}
	if len(result.Packages) != len(request.Packages) {
		return Response{}, fmt.Errorf("Core returned an incomplete package set")
	}
	return Response{
		Identity:   service.identity,
		Publisher:  result.Publisher,
		Checkpoint: result.Checkpoint,
		Packages:   result.Packages,
	}, nil
}

func validateRequest(request Request) error {
	if request.Protocol != Protocol || !commitPattern.MatchString(request.ExpectedSourceCommit) {
		return fmt.Errorf("%w: protocol or source commit", ErrInvalidRequest)
	}
	if len(request.PublisherPolicy) == 0 || len(request.TrustedRoot) == 0 || len(request.Checkpoint) == 0 || len(request.CheckpointBundle) == 0 {
		return fmt.Errorf("%w: trust closure is incomplete", ErrInvalidRequest)
	}
	if len(request.Packages) == 0 || len(request.Packages) > MaxPackages {
		return fmt.Errorf("%w: package count", ErrInvalidRequest)
	}
	if request.PreviousCheckpoint != nil && (!digestPattern.MatchString(request.PreviousCheckpoint.Digest) || !digestPattern.MatchString(request.PreviousCheckpoint.EntriesDigest)) {
		return fmt.Errorf("%w: previous checkpoint pin", ErrInvalidRequest)
	}
	total := len(request.PublisherPolicy) + len(request.TrustedRoot) + len(request.Checkpoint) + len(request.CheckpointBundle)
	packageKeys := make(map[string]struct{}, len(request.Packages))
	for _, candidate := range request.Packages {
		if !digestPattern.MatchString(candidate.PackageDigest) || len(candidate.FormRef) == 0 || len(candidate.Index) == 0 || len(candidate.Bundle) == 0 {
			return fmt.Errorf("%w: package closure is incomplete", ErrInvalidRequest)
		}
		key := candidate.PackageDigest + "\x00" + string(candidate.FormRef)
		if _, duplicate := packageKeys[key]; duplicate {
			return fmt.Errorf("%w: duplicate package", ErrInvalidRequest)
		}
		packageKeys[key] = struct{}{}
		if len(candidate.Files) == 0 || len(candidate.Files) > MaxFilesPerPackage {
			return fmt.Errorf("%w: file count", ErrInvalidRequest)
		}
		packageBytes := len(candidate.Index) + len(candidate.Bundle)
		paths := map[string]struct{}{"package-index.json": {}}
		for _, file := range candidate.Files {
			if file.Path == "" || !fs.ValidPath(file.Path) || file.Path == "." || file.Path == "package-index.json" || len(file.Bytes) == 0 {
				return fmt.Errorf("%w: package path", ErrInvalidRequest)
			}
			if _, duplicate := paths[file.Path]; duplicate {
				return fmt.Errorf("%w: duplicate package path", ErrInvalidRequest)
			}
			paths[file.Path] = struct{}{}
			packageBytes += len(file.Bytes)
		}
		if packageBytes > MaxPackageBytes {
			return fmt.Errorf("%w: package bytes", ErrInvalidRequest)
		}
		total += packageBytes
		if total > MaxSetBytes {
			return fmt.Errorf("%w: set bytes", ErrInvalidRequest)
		}
	}
	return nil
}

func clonePin(pin *CheckpointPin) *CheckpointPin {
	if pin == nil {
		return nil
	}
	copy := *pin
	return &copy
}

func clonePackages(packages []Package) []Package {
	result := make([]Package, len(packages))
	for index, candidate := range packages {
		result[index] = Package{
			PackageDigest: candidate.PackageDigest,
			FormRef:       append(json.RawMessage(nil), candidate.FormRef...),
			Index:         append([]byte(nil), candidate.Index...),
			Bundle:        append([]byte(nil), candidate.Bundle...),
			Files:         make([]File, len(candidate.Files)),
		}
		for fileIndex, file := range candidate.Files {
			result[index].Files[fileIndex] = File{Path: file.Path, Bytes: append([]byte(nil), file.Bytes...)}
		}
	}
	return result
}
