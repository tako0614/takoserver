package verifier

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"
)

func TestVerifySetRejectsDuplicatePackageAndPathBeforeCore(t *testing.T) {
	core := &fakeCore{}
	service := New(core, Identity{ArtifactDigest: testDigest("a")})
	request := validRequest()
	request.Packages = append(request.Packages, request.Packages[0])

	if _, err := service.VerifySet(context.Background(), request); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("VerifySet duplicate package error = %v, want ErrInvalidRequest", err)
	}
	if core.calls != 0 {
		t.Fatalf("Core calls = %d, want 0", core.calls)
	}

	request = validRequest()
	request.Packages[0].Files = append(request.Packages[0].Files, request.Packages[0].Files[0])
	if _, err := service.VerifySet(context.Background(), request); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("VerifySet duplicate path error = %v, want ErrInvalidRequest", err)
	}
	if core.calls != 0 {
		t.Fatalf("Core calls after duplicate path = %d, want 0", core.calls)
	}
}

func TestVerifySetReturnsNoPartialResultWhenOnePackageFails(t *testing.T) {
	core := &fakeCore{failPackageDigest: testDigest("b")}
	service := New(core, Identity{ArtifactDigest: testDigest("a")})
	request := validRequest()
	second := request.Packages[0]
	second.PackageDigest = testDigest("b")
	second.FormRef = []byte(`{"apiVersion":"forms.example/v1","kind":"Second","schemaDigest":"` + testDigest("c") + `"}`)
	request.Packages = append(request.Packages, second)

	response, err := service.VerifySet(context.Background(), request)
	if err == nil {
		t.Fatal("VerifySet succeeded, want package verification failure")
	}
	if !reflect.DeepEqual(response, Response{}) {
		t.Fatalf("VerifySet returned partial response: %#v", response)
	}
}

func TestVerifySetPassesDurablePreviousPinAndChecksEveryPackageRevocation(t *testing.T) {
	core := &fakeCore{}
	service := New(core, Identity{ArtifactDigest: testDigest("a")})
	request := validRequest()
	request.PreviousCheckpoint = &CheckpointPin{
		CheckpointAPIVersion: "revocations.forms.takoform.com/v1",
		Sequence:             4,
		Digest:               testDigest("d"),
		EntriesDigest:        testDigest("e"),
	}

	response, err := service.VerifySet(context.Background(), request)
	if err != nil {
		t.Fatalf("VerifySet error = %v", err)
	}
	if core.previous == nil || core.previous.Digest != testDigest("d") {
		t.Fatalf("previous pin = %#v, want durable pin", core.previous)
	}
	if core.revocationChecks != len(request.Packages) {
		t.Fatalf("revocation checks = %d, want %d", core.revocationChecks, len(request.Packages))
	}
	if response.Identity.CoreVersion != CoreVersion || response.Identity.CoreCommit != CoreCommit {
		t.Fatalf("identity = %#v", response.Identity)
	}
}

func TestReleasedCoreVerifyPackageClosureUsesVerifyFS(t *testing.T) {
	index, err := os.ReadFile("testdata/range-gauge/package-index.json")
	if err != nil {
		t.Fatal(err)
	}
	definition, err := os.ReadFile("testdata/range-gauge/definition.json")
	if err != nil {
		t.Fatal(err)
	}
	report, err := verifyPackageClosure(Package{
		Index: index,
		Files: []File{{Path: "definition.json", Bytes: definition}},
	})
	if err != nil {
		t.Fatalf("released Core VerifyFS error = %v", err)
	}
	if report.FormRef.Kind != "RangeGauge" || report.FileCount != 1 {
		t.Fatalf("released Core report = %#v", report)
	}
}

type fakeCore struct {
	calls             int
	failPackageDigest string
	previous          *CheckpointPin
	revocationChecks  int
}

func (core *fakeCore) Verify(input CoreInput) (CoreResult, error) {
	core.calls++
	if input.PreviousCheckpoint != nil {
		copy := *input.PreviousCheckpoint
		core.previous = &copy
	}
	packages := make([]VerifiedPackage, 0, len(input.Packages))
	for _, candidate := range input.Packages {
		if candidate.PackageDigest == core.failPackageDigest {
			return CoreResult{}, errors.New("package verification refused")
		}
		core.revocationChecks++
		packages = append(packages, VerifiedPackage{
			PackageDigest: candidate.PackageDigest,
			FormRef:       append([]byte(nil), candidate.FormRef...),
			BundleDigest:  testDigest("f"),
		})
	}
	return CoreResult{
		Publisher: PublisherVerification{
			PolicyDigest:      testDigest("1"),
			TrustedRootDigest: testDigest("2"),
			OIDCIssuer:        "https://token.actions.githubusercontent.com",
			SourceRepository:  "https://github.com/tako0614/takoform-forms",
			Workflow:          "https://github.com/tako0614/takoform-forms/.github/workflows/publish.yml",
			Ref:               "refs/heads/main",
			Identity:          "fixture",
			SourceCommit:      input.ExpectedSourceCommit,
			WorkflowCommit:    input.ExpectedSourceCommit,
			BuildConfigCommit: input.ExpectedSourceCommit,
		},
		Checkpoint: CheckpointVerification{
			CheckpointAPIVersion: "revocations.forms.takoform.com/v1",
			Sequence:             5,
			Digest:               testDigest("3"),
			EntriesDigest:        testDigest("4"),
			PreviousDigest:       testDigest("d"),
			BundleDigest:         testDigest("5"),
		},
		Packages: packages,
	}, nil
}

func validRequest() Request {
	commit := "0123456789abcdef0123456789abcdef01234567"
	return Request{
		Protocol:             Protocol,
		ExpectedSourceCommit: commit,
		PublisherPolicy:      []byte(`{"policy":true}`),
		TrustedRoot:          []byte(`{"root":true}`),
		Checkpoint:           []byte(`{"checkpoint":true}`),
		CheckpointBundle:     []byte(`{"bundle":true}`),
		Packages: []Package{{
			PackageDigest: testDigest("9"),
			FormRef:       []byte(`{"apiVersion":"forms.example/v1","kind":"First","schemaDigest":"` + testDigest("8") + `"}`),
			Index:         []byte(`{"index":true}`),
			Bundle:        []byte(`{"bundle":true}`),
			Files:         []File{{Path: "definition.json", Bytes: []byte(`{"ok":true}`)}},
		}},
	}
}

func testDigest(character string) string {
	result := "sha256:"
	for range 64 {
		result += character
	}
	return result
}
