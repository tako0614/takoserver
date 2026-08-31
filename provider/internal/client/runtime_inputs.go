// Package client implements the narrow Takoserver control API used by this
// provider. It is intentionally separate from the stable Takoform Host API.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"time"
)

const (
	runtimeInputPreparationFormat = "takoserver.worker-runtime-input-preparation@v1"
	maxResponseBytes              = 64 * 1024
)

var opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// ErrNotFound means no durable preparation exists for the exact operation.
var ErrNotFound = errors.New("runtime input preparation not found")

// Client addresses one Takoserver organization control boundary.
type Client struct {
	endpoint       *url.URL
	token          string
	organizationID string
	httpClient     *http.Client
}

// RuntimeInputPreparationInput contains the one sealed preparation request.
// Bindings are request-only and must never be copied into provider state.
type RuntimeInputPreparationInput struct {
	MaterialSetID         string
	Space                 string
	WorkerName            string
	BundleName            string
	OriginResourceUID     string
	CanonicalPublicOrigin string
	Bindings              map[string]string
}

// RuntimeInputPreparation is the value-free preparation projection returned
// by Takoserver and safe to retain in provider state.
type RuntimeInputPreparation struct {
	OperationID           string
	PreparationID         string
	Status                string
	ExpiresAt             time.Time
	Space                 string
	WorkerName            string
	BundleName            string
	OriginResourceUID     string
	CanonicalPublicOrigin string
	BindingNames          []string
}

type runtimeInputPreparationRequest struct {
	Format                string            `json:"format"`
	MaterialSetID         string            `json:"materialSetId"`
	Target                preparationTarget `json:"target"`
	CanonicalPublicOrigin string            `json:"canonicalPublicOrigin"`
	Bindings              map[string]string `json:"bindings"`
}

type runtimeInputPreparationResponse struct {
	Format                string            `json:"format"`
	OperationID           string            `json:"operationId"`
	PreparationID         string            `json:"preparationId"`
	Status                string            `json:"status"`
	ExpiresAt             time.Time         `json:"expiresAt"`
	Target                preparationTarget `json:"target"`
	CanonicalPublicOrigin string            `json:"canonicalPublicOrigin"`
	BindingNames          []string          `json:"bindingNames"`
}

type preparationTarget struct {
	Space             string `json:"space"`
	WorkerName        string `json:"workerName"`
	BundleName        string `json:"bundleName"`
	OriginResourceUID string `json:"originResourceUid"`
}

// New constructs one exact organization client. HTTP is accepted only for a
// loopback endpoint so local OpenTofu tests need no TLS exception elsewhere.
func New(endpoint, token, organizationID string, httpClient *http.Client) (*Client, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("Takoserver endpoint must be one absolute origin")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return nil, errors.New("Takoserver endpoint must use HTTPS outside loopback")
	}
	if token == "" {
		return nil, errors.New("Takoserver token is required")
	}
	if !opaqueIDPattern.MatchString(organizationID) {
		return nil, errors.New("Takoserver organization identity is invalid")
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	transport := *httpClient
	transport.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{
		endpoint:       parsed,
		token:          token,
		organizationID: organizationID,
		httpClient:     &transport,
	}, nil
}

// PutRuntimeInputPreparation creates or adopts one idempotent preparation.
func (c *Client) PutRuntimeInputPreparation(ctx context.Context, operationID string, input RuntimeInputPreparationInput) (RuntimeInputPreparation, error) {
	if !opaqueIDPattern.MatchString(operationID) {
		return RuntimeInputPreparation{}, errors.New("runtime input operation identity is invalid")
	}
	requestBody := runtimeInputPreparationRequest{
		Format:        runtimeInputPreparationFormat,
		MaterialSetID: input.MaterialSetID,
		Target: preparationTarget{
			Space:             input.Space,
			WorkerName:        input.WorkerName,
			BundleName:        input.BundleName,
			OriginResourceUID: input.OriginResourceUID,
		},
		CanonicalPublicOrigin: input.CanonicalPublicOrigin,
		Bindings:              input.Bindings,
	}
	encoded, err := json.Marshal(requestBody)
	if err != nil {
		return RuntimeInputPreparation{}, errors.New("runtime input preparation request cannot be encoded")
	}

	target := c.endpoint.JoinPath("v1", "organizations", c.organizationID, "worker-runtime-input-preparations", operationID)
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, target.String(), bytes.NewReader(encoded))
	if err != nil {
		return RuntimeInputPreparation{}, errors.New("runtime input preparation request cannot be created")
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Cache-Control", "no-store")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		return RuntimeInputPreparation{}, fmt.Errorf("Takoserver runtime input preparation returned HTTP %d", response.StatusCode)
	}

	var wire runtimeInputPreparationResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation returned an invalid response")
	}
	if err := requireEOF(decoder); err != nil {
		return RuntimeInputPreparation{}, err
	}
	if wire.Format != runtimeInputPreparationFormat || wire.OperationID != operationID || wire.PreparationID == "" || wire.Status != "prepared" || wire.ExpiresAt.IsZero() {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation returned mismatched identity or state")
	}
	if wire.Target.Space != input.Space || wire.Target.WorkerName != input.WorkerName || wire.Target.BundleName != input.BundleName || wire.Target.OriginResourceUID != input.OriginResourceUID || wire.CanonicalPublicOrigin != input.CanonicalPublicOrigin {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation returned a mismatched target")
	}
	wantNames := sortedBindingNames(input.Bindings)
	if !equalStrings(wire.BindingNames, wantNames) {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation returned mismatched binding names")
	}

	return RuntimeInputPreparation{
		OperationID:           wire.OperationID,
		PreparationID:         wire.PreparationID,
		Status:                wire.Status,
		ExpiresAt:             wire.ExpiresAt,
		Space:                 wire.Target.Space,
		WorkerName:            wire.Target.WorkerName,
		BundleName:            wire.Target.BundleName,
		OriginResourceUID:     wire.Target.OriginResourceUID,
		CanonicalPublicOrigin: wire.CanonicalPublicOrigin,
		BindingNames:          append([]string(nil), wire.BindingNames...),
	}, nil
}

// GetRuntimeInputPreparation reads the value-free durable projection for one
// exact operation identity.
func (c *Client) GetRuntimeInputPreparation(ctx context.Context, operationID string) (RuntimeInputPreparation, error) {
	if !opaqueIDPattern.MatchString(operationID) {
		return RuntimeInputPreparation{}, errors.New("runtime input operation identity is invalid")
	}
	target := c.endpoint.JoinPath("v1", "organizations", c.organizationID, "worker-runtime-input-preparations", operationID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return RuntimeInputPreparation{}, errors.New("runtime input preparation read request cannot be created")
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Cache-Control", "no-store")
	request.Header.Set("Accept", "application/json")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation read failed")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		return RuntimeInputPreparation{}, ErrNotFound
	}
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		return RuntimeInputPreparation{}, fmt.Errorf("Takoserver runtime input preparation read returned HTTP %d", response.StatusCode)
	}

	wire, err := decodeRuntimeInputPreparation(response.Body)
	if err != nil {
		return RuntimeInputPreparation{}, err
	}
	if wire.OperationID != operationID || wire.PreparationID == "" || wire.ExpiresAt.IsZero() || !validPreparationStatus(wire.Status) {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation read returned mismatched identity or state")
	}
	if wire.Target.Space == "" || wire.Target.WorkerName == "" || wire.Target.BundleName == "" || wire.Target.OriginResourceUID == "" || wire.CanonicalPublicOrigin == "" || len(wire.BindingNames) == 0 {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation read returned an incomplete projection")
	}
	if !sort.StringsAreSorted(wire.BindingNames) || hasDuplicateStrings(wire.BindingNames) {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation read returned non-canonical binding names")
	}
	return runtimeInputPreparationFromWire(wire), nil
}

// DeleteRuntimeInputPreparation revokes an unconsumed preparation. A missing
// operation is already at the desired state and is therefore successful.
func (c *Client) DeleteRuntimeInputPreparation(ctx context.Context, operationID string) error {
	if !opaqueIDPattern.MatchString(operationID) {
		return errors.New("runtime input operation identity is invalid")
	}
	target := c.endpoint.JoinPath("v1", "organizations", c.organizationID, "worker-runtime-input-preparations", operationID)
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, target.String(), nil)
	if err != nil {
		return errors.New("runtime input preparation revoke request cannot be created")
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Cache-Control", "no-store")
	request.Header.Set("Accept", "application/json")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return errors.New("Takoserver runtime input preparation revoke failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
	if response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusNotFound {
		return nil
	}
	return fmt.Errorf("Takoserver runtime input preparation revoke returned HTTP %d", response.StatusCode)
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("Takoserver runtime input preparation response contains trailing JSON")
	}
	return nil
}

func decodeRuntimeInputPreparation(reader io.Reader) (runtimeInputPreparationResponse, error) {
	var wire runtimeInputPreparationResponse
	decoder := json.NewDecoder(io.LimitReader(reader, maxResponseBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return runtimeInputPreparationResponse{}, errors.New("Takoserver runtime input preparation returned an invalid response")
	}
	if err := requireEOF(decoder); err != nil {
		return runtimeInputPreparationResponse{}, err
	}
	if wire.Format != runtimeInputPreparationFormat {
		return runtimeInputPreparationResponse{}, errors.New("Takoserver runtime input preparation returned an unsupported format")
	}
	return wire, nil
}

func runtimeInputPreparationFromWire(wire runtimeInputPreparationResponse) RuntimeInputPreparation {
	return RuntimeInputPreparation{
		OperationID:           wire.OperationID,
		PreparationID:         wire.PreparationID,
		Status:                wire.Status,
		ExpiresAt:             wire.ExpiresAt,
		Space:                 wire.Target.Space,
		WorkerName:            wire.Target.WorkerName,
		BundleName:            wire.Target.BundleName,
		OriginResourceUID:     wire.Target.OriginResourceUID,
		CanonicalPublicOrigin: wire.CanonicalPublicOrigin,
		BindingNames:          append([]string(nil), wire.BindingNames...),
	}
}

func validPreparationStatus(status string) bool {
	switch status {
	case "prepared", "claimed", "dispatched", "consumed", "revoked", "expired", "indeterminate":
		return true
	default:
		return false
	}
}

func hasDuplicateStrings(values []string) bool {
	for index := 1; index < len(values); index++ {
		if values[index-1] == values[index] {
			return true
		}
	}
	return false
}

func sortedBindingNames(bindings map[string]string) []string {
	names := make([]string, 0, len(bindings))
	for name := range bindings {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
