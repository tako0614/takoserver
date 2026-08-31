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
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	runtimeInputPreparationFormat = "takoserver.worker-runtime-input-preparation@v1"
	originReservationFormat       = "takoserver.worker-endpoint-origin-reservation.v1"
	originActivationFormat        = "takoserver.worker-endpoint-origin-reservation-activation.v1"
	maxResponseBytes              = 64 * 1024
	maxResponseJSONDepth          = 64
)

var opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

var targetNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

var bindingNamePattern = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)

var materialSetIDPattern = regexp.MustCompile(`^material-set:v1:[0-9a-f]{64}$`)

var runtimeInputReferencePattern = regexp.MustCompile(`^rip1\.(prep-[0-9a-f]{32})\.([0-9a-f]{64})$`)

var materialSetNoncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

var revisionPattern = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

// ErrNotFound means no durable preparation exists for the exact operation.
var ErrNotFound = errors.New("runtime input preparation not found")

// ErrOriginReservationNotFound means no durable origin reservation exists for
// the exact reservation identity.
var ErrOriginReservationNotFound = errors.New("worker endpoint origin reservation not found")

// ErrReservationNotFound is kept as a descriptive alias for callers that do
// not need the WorkerEndpoint-specific name.
var ErrReservationNotFound = ErrOriginReservationNotFound

// Client addresses one Takoserver organization control boundary.
type Client struct {
	endpoint       *url.URL
	token          string
	organizationID string
	httpClient     *http.Client
}

// RuntimeInputPreparationInput contains the one sealed preparation request.
// Bindings are request-only and must never be copied into provider state. The
// canonical origin is intentionally absent: Takoserver resolves it from the
// origin reservation and is the sole authority for that value.
type RuntimeInputPreparationInput struct {
	MaterialSetID         string
	MaterialSetNonce      string
	RuntimeInputReference string
	Space                 string
	WorkerName            string
	WorkerResourceUID     string
	BundleName            string
	EndpointName          string
	OriginReservationID   string
	Bindings              map[string]string
}

// RuntimeInputPreparation is the value-free preparation projection returned
// by Takoserver and safe to retain in provider state.
type RuntimeInputPreparation struct {
	OperationID           string
	PreparationID         string
	RuntimeInputReference string
	Status                string
	ExpiresAt             time.Time
	Space                 string
	WorkerName            string
	WorkerResourceUID     string
	BundleName            string
	EndpointName          string
	OriginReservationID   string
	CanonicalPublicOrigin string
	BindingNames          []string
}

// WorkerEndpointOriginReservation is a closed, value-free reservation
// projection. Optional realized UIDs are present only after the corresponding
// lifecycle step has bound them.
type WorkerEndpointOriginReservation struct {
	ReservationID         string
	CanonicalPublicOrigin string
	Revision              string
	ExpiresAt             time.Time
	Status                string
	Space                 string
	WorkerName            string
	EndpointName          string
	WorkerResourceUID     string
	EndpointResourceUID   string
}

// OriginReservation is the concise name for a WorkerEndpoint origin
// reservation projection.
type OriginReservation = WorkerEndpointOriginReservation

// WorkerEndpointOriginActivation is the closed activation projection returned
// after binding an exact Takoform WorkerEndpoint resource to a reservation.
type WorkerEndpointOriginActivation struct {
	ReservationID         string
	CanonicalPublicOrigin string
	Revision              string
	ExpiresAt             time.Time
	Status                string
	Space                 string
	WorkerName            string
	EndpointName          string
	WorkerResourceUID     string
	EndpointResourceUID   string
}

// OriginActivation is the concise name for an endpoint-origin activation
// projection.
type OriginActivation = WorkerEndpointOriginActivation

type runtimeInputPreparationRequest struct {
	Format                string            `json:"format"`
	MaterialSetID         string            `json:"materialSetId"`
	MaterialSetNonce      string            `json:"materialSetNonce"`
	RuntimeInputReference string            `json:"runtimeInputReference"`
	Target                preparationTarget `json:"target"`
	Bindings              map[string]string `json:"bindings"`
}

type runtimeInputPreparationResponse struct {
	Format                string            `json:"format"`
	OperationID           string            `json:"operationId"`
	PreparationID         string            `json:"preparationId"`
	RuntimeInputReference string            `json:"runtimeInputReference"`
	Status                string            `json:"status"`
	ExpiresAt             time.Time         `json:"expiresAt"`
	Target                preparationTarget `json:"target"`
	CanonicalPublicOrigin string            `json:"canonicalPublicOrigin"`
	BindingNames          []string          `json:"bindingNames"`
}

// preparationTarget is the exact five-field runtime preparation target. The
// endpoint name is checked through the reservation projection before PUT and
// is therefore not repeated in this API body.
type preparationTarget struct {
	Space               string `json:"space"`
	WorkerName          string `json:"workerName"`
	WorkerResourceUID   string `json:"workerResourceUid"`
	BundleName          string `json:"bundleName"`
	OriginReservationID string `json:"originReservationId"`
}

type originReservationTarget struct {
	Space        string `json:"space"`
	WorkerName   string `json:"workerName"`
	EndpointName string `json:"endpointName"`
}

type originReservationResponse struct {
	Format                string                  `json:"format"`
	ReservationID         string                  `json:"reservationId"`
	CanonicalPublicOrigin string                  `json:"canonicalPublicOrigin"`
	Revision              string                  `json:"revision"`
	ExpiresAt             time.Time               `json:"expiresAt"`
	Target                originReservationTarget `json:"target"`
	Status                string                  `json:"status"`
	WorkerResourceUID     *string                 `json:"workerResourceUid"`
	EndpointResourceUID   *string                 `json:"endpointResourceUid"`
}

type originActivationRequest struct {
	Format              string `json:"format"`
	EndpointResourceUID string `json:"endpointResourceUid"`
}

// New constructs one exact organization client. HTTP is accepted only for a
// loopback endpoint so local OpenTofu tests need no TLS exception elsewhere.
func New(endpoint, token, organizationID string, httpClient *http.Client) (*Client, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" || parsed.Path != "" || parsed.RawPath != "" || strings.HasSuffix(parsed.Host, ":") || nonCanonicalEndpointPort(parsed) || parsed.Host != strings.ToLower(parsed.Host) || parsed.String() != endpoint {
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
	if !materialSetIDPattern.MatchString(input.MaterialSetID) {
		return RuntimeInputPreparation{}, errors.New("runtime input material set identity is invalid")
	}
	if !materialSetNoncePattern.MatchString(input.MaterialSetNonce) {
		return RuntimeInputPreparation{}, errors.New("runtime input material set nonce is invalid")
	}
	preparationID, referenceDigest, ok := parseRuntimeInputReference(input.RuntimeInputReference)
	if !ok {
		return RuntimeInputPreparation{}, errors.New("runtime input reference is invalid")
	}
	if preparationID != "prep-"+referenceDigest[:32] {
		return RuntimeInputPreparation{}, errors.New("runtime input reference preparation identity is invalid")
	}
	if err := validateRuntimeInputPreparationInput(input); err != nil {
		return RuntimeInputPreparation{}, err
	}
	requestBody := runtimeInputPreparationRequest{
		Format:                runtimeInputPreparationFormat,
		MaterialSetID:         input.MaterialSetID,
		MaterialSetNonce:      input.MaterialSetNonce,
		RuntimeInputReference: input.RuntimeInputReference,
		Target: preparationTarget{
			Space:               input.Space,
			WorkerName:          input.WorkerName,
			WorkerResourceUID:   input.WorkerResourceUID,
			BundleName:          input.BundleName,
			OriginReservationID: input.OriginReservationID,
		},
		Bindings: input.Bindings,
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
	setJSONHeaders(request, c.token)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusOK {
		drainResponse(response.Body)
		return RuntimeInputPreparation{}, fmt.Errorf("Takoserver runtime input preparation returned HTTP %d", response.StatusCode)
	}

	wire, err := decodeRuntimeInputPreparation(response.Body)
	if err != nil {
		return RuntimeInputPreparation{}, err
	}
	if wire.OperationID != operationID || wire.PreparationID != preparationID || wire.RuntimeInputReference != input.RuntimeInputReference || !validRuntimeInputReference(wire.RuntimeInputReference, wire.PreparationID) || wire.Status != "prepared" || wire.ExpiresAt.IsZero() {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation returned mismatched identity or state")
	}
	if wire.Target.Space != input.Space || wire.Target.WorkerName != input.WorkerName || wire.Target.WorkerResourceUID != input.WorkerResourceUID || wire.Target.BundleName != input.BundleName || wire.Target.OriginReservationID != input.OriginReservationID {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation returned a mismatched target")
	}
	wantNames := sortedBindingNames(input.Bindings)
	if !equalStrings(wire.BindingNames, wantNames) {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation returned mismatched binding names")
	}
	if err := validateCanonicalOrigin(wire.CanonicalPublicOrigin); err != nil {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation returned a non-canonical origin")
	}

	return RuntimeInputPreparation{
		OperationID:           wire.OperationID,
		PreparationID:         wire.PreparationID,
		RuntimeInputReference: wire.RuntimeInputReference,
		Status:                wire.Status,
		ExpiresAt:             wire.ExpiresAt,
		Space:                 wire.Target.Space,
		WorkerName:            wire.Target.WorkerName,
		WorkerResourceUID:     wire.Target.WorkerResourceUID,
		BundleName:            wire.Target.BundleName,
		EndpointName:          input.EndpointName,
		OriginReservationID:   wire.Target.OriginReservationID,
		CanonicalPublicOrigin: wire.CanonicalPublicOrigin,
		BindingNames:          append([]string(nil), wire.BindingNames...),
	}, nil
}

func validateRuntimeInputPreparationInput(input RuntimeInputPreparationInput) error {
	for name, value := range map[string]string{
		"space":       input.Space,
		"worker name": input.WorkerName,
		"bundle name": input.BundleName,
	} {
		if !targetNamePattern.MatchString(value) {
			return fmt.Errorf("runtime input %s is invalid", name)
		}
	}
	for name, value := range map[string]string{
		"worker resource":    input.WorkerResourceUID,
		"origin reservation": input.OriginReservationID,
	} {
		if !opaqueIDPattern.MatchString(value) {
			return fmt.Errorf("runtime input %s identity is invalid", name)
		}
	}
	if !targetNamePattern.MatchString(input.EndpointName) {
		return errors.New("runtime input endpoint name is invalid")
	}
	if len(input.Bindings) == 0 || len(input.Bindings) > 64 {
		return errors.New("runtime input binding set is invalid")
	}
	for name, value := range input.Bindings {
		if !bindingNamePattern.MatchString(name) || value == "" || !utf8.ValidString(value) || len(value) > 32*1024 {
			return errors.New("runtime input binding set is invalid")
		}
	}
	return nil
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
	setJSONHeaders(request, c.token)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation read failed")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		drainResponse(response.Body)
		return RuntimeInputPreparation{}, ErrNotFound
	}
	if response.StatusCode != http.StatusOK {
		drainResponse(response.Body)
		return RuntimeInputPreparation{}, fmt.Errorf("Takoserver runtime input preparation read returned HTTP %d", response.StatusCode)
	}

	wire, err := decodeRuntimeInputPreparation(response.Body)
	if err != nil {
		return RuntimeInputPreparation{}, err
	}
	if wire.OperationID != operationID || wire.PreparationID == "" || !validRuntimeInputReference(wire.RuntimeInputReference, wire.PreparationID) || wire.ExpiresAt.IsZero() || !validPreparationStatus(wire.Status) {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation read returned mismatched identity or state")
	}
	if err := validatePreparationTarget(wire.Target); err != nil {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation read returned an incomplete projection")
	}
	if err := validateCanonicalOrigin(wire.CanonicalPublicOrigin); err != nil {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation read returned a non-canonical origin")
	}
	if !validBindingNames(wire.BindingNames) {
		return RuntimeInputPreparation{}, errors.New("Takoserver runtime input preparation read returned non-canonical binding names")
	}
	return runtimeInputPreparationFromWire(wire), nil
}

// GetWorkerEndpointOriginReservation reads the closed reservation projection
// that is the authority for canonicalPublicOrigin.
func (c *Client) GetWorkerEndpointOriginReservation(ctx context.Context, reservationID string) (WorkerEndpointOriginReservation, error) {
	if !opaqueIDPattern.MatchString(reservationID) {
		return WorkerEndpointOriginReservation{}, errors.New("worker endpoint origin reservation identity is invalid")
	}
	// Origin reservations are organization-scoped by the API key, not by a
	// caller-controlled path segment. Keeping the organization out of the URL
	// prevents cross-organization path confusion and matches Takoserver's
	// root-scoped reservation route.
	target := c.endpoint.JoinPath("v1", "worker-endpoint-origin-reservations", reservationID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return WorkerEndpointOriginReservation{}, errors.New("worker endpoint origin reservation read request cannot be created")
	}
	setJSONHeaders(request, c.token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return WorkerEndpointOriginReservation{}, errors.New("Takoserver worker endpoint origin reservation read failed")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		drainResponse(response.Body)
		return WorkerEndpointOriginReservation{}, ErrOriginReservationNotFound
	}
	if response.StatusCode != http.StatusOK {
		drainResponse(response.Body)
		return WorkerEndpointOriginReservation{}, fmt.Errorf("Takoserver worker endpoint origin reservation read returned HTTP %d", response.StatusCode)
	}
	wire, err := decodeOriginReservation(response.Body)
	if err != nil {
		return WorkerEndpointOriginReservation{}, err
	}
	if err := validateOriginReservationProjection(wire, reservationID); err != nil {
		return WorkerEndpointOriginReservation{}, err
	}
	return originReservationFromWire(wire), nil
}

// GetOriginReservation is a short alias for callers that already operate on
// the reservation abstraction.
func (c *Client) GetOriginReservation(ctx context.Context, reservationID string) (WorkerEndpointOriginReservation, error) {
	return c.GetWorkerEndpointOriginReservation(ctx, reservationID)
}

// GetWorkerEndpointOriginReservationProjection is an explicit projection
// alias useful to callers that want to distinguish the read from a future
// reservation mutation.
func (c *Client) GetWorkerEndpointOriginReservationProjection(ctx context.Context, reservationID string) (WorkerEndpointOriginReservation, error) {
	return c.GetWorkerEndpointOriginReservation(ctx, reservationID)
}

// PutWorkerEndpointOriginActivation activates one exact endpoint binding. A
// repeated PUT with the same reservation and endpoint is safe after lost
// acknowledgement because the server operation is idempotent.
func (c *Client) PutWorkerEndpointOriginActivation(ctx context.Context, reservationID, endpointResourceUID string) (WorkerEndpointOriginActivation, error) {
	if err := validateActivationIdentity(reservationID, endpointResourceUID); err != nil {
		return WorkerEndpointOriginActivation{}, err
	}
	body, err := json.Marshal(originActivationRequest{Format: originActivationFormat, EndpointResourceUID: endpointResourceUID})
	if err != nil {
		return WorkerEndpointOriginActivation{}, errors.New("worker endpoint origin activation request cannot be encoded")
	}
	target := c.endpoint.JoinPath("v1", "worker-endpoint-origin-reservations", reservationID, "activation")
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, target.String(), bytes.NewReader(body))
	if err != nil {
		return WorkerEndpointOriginActivation{}, errors.New("worker endpoint origin activation request cannot be created")
	}
	setJSONHeaders(request, c.token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return WorkerEndpointOriginActivation{}, errors.New("Takoserver worker endpoint origin activation request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		drainResponse(response.Body)
		return WorkerEndpointOriginActivation{}, fmt.Errorf("Takoserver worker endpoint origin activation returned HTTP %d", response.StatusCode)
	}
	wire, err := decodeOriginReservation(response.Body)
	if err != nil {
		return WorkerEndpointOriginActivation{}, err
	}
	if wire.ReservationID != reservationID || wire.Status != "activated" || optionalString(wire.EndpointResourceUID) != endpointResourceUID {
		return WorkerEndpointOriginActivation{}, errors.New("Takoserver worker endpoint origin activation returned mismatched identity or state")
	}
	if err := validateOriginReservationProjection(wire, reservationID); err != nil {
		return WorkerEndpointOriginActivation{}, err
	}
	return originActivationFromWire(wire), nil
}

// ActivateWorkerEndpointOrigin is an alias that emphasizes the resource
// operation rather than the HTTP verb.
func (c *Client) ActivateWorkerEndpointOrigin(ctx context.Context, reservationID, endpointResourceUID string) (WorkerEndpointOriginActivation, error) {
	return c.PutWorkerEndpointOriginActivation(ctx, reservationID, endpointResourceUID)
}

// ActivateWorkerEndpointOriginReservation is an alias for the idempotent
// reservation activation operation.
func (c *Client) ActivateWorkerEndpointOriginReservation(ctx context.Context, reservationID, endpointResourceUID string) (WorkerEndpointOriginActivation, error) {
	return c.PutWorkerEndpointOriginActivation(ctx, reservationID, endpointResourceUID)
}

// DeleteWorkerEndpointOriginActivation deactivates one exact endpoint binding.
// The body repeats endpointResourceUid so a stale destroy cannot detach a
// replacement endpoint. Missing reservations are already at the desired state.
func (c *Client) DeleteWorkerEndpointOriginActivation(ctx context.Context, reservationID, endpointResourceUID string) error {
	if err := validateActivationIdentity(reservationID, endpointResourceUID); err != nil {
		return err
	}
	body, err := json.Marshal(originActivationRequest{Format: originActivationFormat, EndpointResourceUID: endpointResourceUID})
	if err != nil {
		return errors.New("worker endpoint origin activation revoke request cannot be encoded")
	}
	target := c.endpoint.JoinPath("v1", "worker-endpoint-origin-reservations", reservationID, "activation")
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, target.String(), bytes.NewReader(body))
	if err != nil {
		return errors.New("worker endpoint origin activation revoke request cannot be created")
	}
	setJSONHeaders(request, c.token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return errors.New("Takoserver worker endpoint origin activation revoke failed")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		drainResponse(response.Body)
		return nil
	}
	if response.StatusCode == http.StatusOK {
		wire, decodeErr := decodeOriginReservation(response.Body)
		if decodeErr != nil {
			return decodeErr
		}
		if err := validateOriginReservationProjection(wire, reservationID); err != nil {
			return err
		}
		if wire.Status != "bound" || wire.EndpointResourceUID == nil || optionalString(wire.EndpointResourceUID) != endpointResourceUID {
			return errors.New("Takoserver worker endpoint origin deactivation returned mismatched identity or state")
		}
		return nil
	}
	drainResponse(response.Body)
	return fmt.Errorf("Takoserver worker endpoint origin activation revoke returned HTTP %d", response.StatusCode)
}

// DeleteOriginActivation is an alias for the exact deactivation operation.
func (c *Client) DeleteOriginActivation(ctx context.Context, reservationID, endpointResourceUID string) error {
	return c.DeleteWorkerEndpointOriginActivation(ctx, reservationID, endpointResourceUID)
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
	setJSONHeaders(request, c.token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return errors.New("Takoserver runtime input preparation revoke failed")
	}
	defer response.Body.Close()
	drainResponse(response.Body)
	if response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusNotFound {
		return nil
	}
	return fmt.Errorf("Takoserver runtime input preparation revoke returned HTTP %d", response.StatusCode)
}

func setJSONHeaders(request *http.Request, token string) {
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Cache-Control", "no-store")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
}

func drainResponse(reader io.Reader) {
	_, _ = io.Copy(io.Discard, io.LimitReader(reader, maxResponseBytes))
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("Takoserver response contains trailing JSON")
	}
	return nil
}

func decodeRuntimeInputPreparation(reader io.Reader) (runtimeInputPreparationResponse, error) {
	raw, err := io.ReadAll(io.LimitReader(reader, maxResponseBytes+1))
	if err != nil {
		return runtimeInputPreparationResponse{}, errors.New("Takoserver runtime input preparation returned an invalid response")
	}
	if len(raw) > maxResponseBytes {
		return runtimeInputPreparationResponse{}, errors.New("Takoserver runtime input preparation response is too large")
	}
	if err := rejectDuplicateResponseJSONKeys(raw); err != nil {
		return runtimeInputPreparationResponse{}, err
	}
	var wire runtimeInputPreparationResponse
	decoder := json.NewDecoder(bytes.NewReader(raw))
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

func decodeOriginReservation(reader io.Reader) (originReservationResponse, error) {
	raw, err := io.ReadAll(io.LimitReader(reader, maxResponseBytes+1))
	if err != nil {
		return originReservationResponse{}, errors.New("Takoserver worker endpoint origin reservation returned an invalid response")
	}
	if len(raw) > maxResponseBytes {
		return originReservationResponse{}, errors.New("Takoserver worker endpoint origin reservation response is too large")
	}
	if err := rejectDuplicateResponseJSONKeys(raw); err != nil {
		return originReservationResponse{}, err
	}
	var wire originReservationResponse
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return originReservationResponse{}, errors.New("Takoserver worker endpoint origin reservation returned an invalid response")
	}
	if err := requireEOF(decoder); err != nil {
		return originReservationResponse{}, err
	}
	if wire.Format != originReservationFormat {
		return originReservationResponse{}, errors.New("Takoserver worker endpoint origin reservation returned an unsupported format")
	}
	return wire, nil
}

func validateOriginReservationProjection(wire originReservationResponse, reservationID string) error {
	if wire.ReservationID != reservationID || wire.ExpiresAt.IsZero() || !validOriginReservationStatus(wire.Status) || !validRevision(wire.Revision) {
		return errors.New("Takoserver worker endpoint origin reservation returned mismatched identity or state")
	}
	if !targetNamePattern.MatchString(wire.Target.Space) || !targetNamePattern.MatchString(wire.Target.WorkerName) || !targetNamePattern.MatchString(wire.Target.EndpointName) {
		return errors.New("Takoserver worker endpoint origin reservation returned an incomplete projection")
	}
	if err := validateCanonicalOrigin(wire.CanonicalPublicOrigin); err != nil {
		return errors.New("Takoserver worker endpoint origin reservation returned a non-canonical origin")
	}
	if wire.WorkerResourceUID != nil && !opaqueIDPattern.MatchString(*wire.WorkerResourceUID) {
		return errors.New("Takoserver worker endpoint origin reservation returned an invalid worker resource identity")
	}
	if wire.EndpointResourceUID != nil && !opaqueIDPattern.MatchString(*wire.EndpointResourceUID) {
		return errors.New("Takoserver worker endpoint origin reservation returned an invalid endpoint resource identity")
	}
	if (wire.Status == "bound" || wire.Status == "activated") && optionalString(wire.WorkerResourceUID) == "" {
		return errors.New("Takoserver worker endpoint origin reservation returned an incomplete projection")
	}
	if wire.Status == "activated" && optionalString(wire.EndpointResourceUID) == "" {
		return errors.New("Takoserver worker endpoint origin reservation returned an incomplete projection")
	}
	return nil
}

func validRevision(value string) bool {
	if !revisionPattern.MatchString(value) {
		return false
	}
	revision, err := strconv.ParseUint(value, 10, 63)
	return err == nil && revision > 0
}

func validatePreparationTarget(target preparationTarget) error {
	if !targetNamePattern.MatchString(target.Space) || !targetNamePattern.MatchString(target.WorkerName) || !targetNamePattern.MatchString(target.BundleName) || !opaqueIDPattern.MatchString(target.WorkerResourceUID) || !opaqueIDPattern.MatchString(target.OriginReservationID) {
		return errors.New("invalid runtime input preparation target")
	}
	return nil
}

func validBindingNames(names []string) bool {
	if len(names) == 0 || len(names) > 64 || !sort.StringsAreSorted(names) || hasDuplicateStrings(names) {
		return false
	}
	for _, name := range names {
		if !bindingNamePattern.MatchString(name) {
			return false
		}
	}
	return true
}

var errDuplicateResponseJSONKey = errors.New("duplicate response object member")

func rejectDuplicateResponseJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var walk func(int) error
	walk = func(depth int) error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		switch delimiter := token.(type) {
		case json.Delim:
			switch delimiter {
			case '{':
				if depth >= maxResponseJSONDepth {
					return errors.New("response JSON nesting is too deep")
				}
				seen := make(map[string]struct{})
				for decoder.More() {
					key, err := decoder.Token()
					if err != nil {
						return err
					}
					name, ok := key.(string)
					if !ok {
						return errors.New("response object member name is not a string")
					}
					if _, exists := seen[name]; exists {
						return errDuplicateResponseJSONKey
					}
					seen[name] = struct{}{}
					if err := walk(depth + 1); err != nil {
						return err
					}
				}
				_, err = decoder.Token()
				return err
			case '[':
				if depth >= maxResponseJSONDepth {
					return errors.New("response JSON nesting is too deep")
				}
				for decoder.More() {
					if err := walk(depth + 1); err != nil {
						return err
					}
				}
				_, err = decoder.Token()
				return err
			default:
				return errors.New("response contains an invalid JSON delimiter")
			}
		default:
			return nil
		}
	}
	if err := walk(0); err != nil {
		if errors.Is(err, errDuplicateResponseJSONKey) {
			return errors.New("Takoserver response contains duplicate JSON fields")
		}
		return errors.New("Takoserver response returned an invalid JSON shape")
	}
	return nil
}

func runtimeInputPreparationFromWire(wire runtimeInputPreparationResponse) RuntimeInputPreparation {
	return RuntimeInputPreparation{
		OperationID:           wire.OperationID,
		PreparationID:         wire.PreparationID,
		RuntimeInputReference: wire.RuntimeInputReference,
		Status:                wire.Status,
		ExpiresAt:             wire.ExpiresAt,
		Space:                 wire.Target.Space,
		WorkerName:            wire.Target.WorkerName,
		WorkerResourceUID:     wire.Target.WorkerResourceUID,
		BundleName:            wire.Target.BundleName,
		OriginReservationID:   wire.Target.OriginReservationID,
		CanonicalPublicOrigin: wire.CanonicalPublicOrigin,
		BindingNames:          append([]string(nil), wire.BindingNames...),
	}
}

func originReservationFromWire(wire originReservationResponse) WorkerEndpointOriginReservation {
	return WorkerEndpointOriginReservation{
		ReservationID:         wire.ReservationID,
		CanonicalPublicOrigin: wire.CanonicalPublicOrigin,
		Revision:              wire.Revision,
		ExpiresAt:             wire.ExpiresAt,
		Status:                wire.Status,
		Space:                 wire.Target.Space,
		WorkerName:            wire.Target.WorkerName,
		EndpointName:          wire.Target.EndpointName,
		WorkerResourceUID:     optionalString(wire.WorkerResourceUID),
		EndpointResourceUID:   optionalString(wire.EndpointResourceUID),
	}
}

func originActivationFromWire(wire originReservationResponse) WorkerEndpointOriginActivation {
	return WorkerEndpointOriginActivation{
		ReservationID:         wire.ReservationID,
		CanonicalPublicOrigin: wire.CanonicalPublicOrigin,
		Revision:              wire.Revision,
		ExpiresAt:             wire.ExpiresAt,
		Status:                wire.Status,
		Space:                 wire.Target.Space,
		WorkerName:            wire.Target.WorkerName,
		EndpointName:          wire.Target.EndpointName,
		WorkerResourceUID:     optionalString(wire.WorkerResourceUID),
		EndpointResourceUID:   optionalString(wire.EndpointResourceUID),
	}
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func validPreparationStatus(status string) bool {
	switch status {
	case "prepared", "claimed", "dispatched", "consumed", "revoked", "expired", "indeterminate":
		return true
	default:
		return false
	}
}

func validOriginReservationStatus(status string) bool {
	switch status {
	case "prepared", "bound", "activated":
		return true
	default:
		return false
	}
}

func validRuntimeInputReference(value, preparationID string) bool {
	parsedPreparationID, _, ok := parseRuntimeInputReference(value)
	return ok && parsedPreparationID == preparationID
}

func parseRuntimeInputReference(value string) (preparationID, digest string, ok bool) {
	match := runtimeInputReferencePattern.FindStringSubmatch(value)
	if match == nil || match[1] != "prep-"+match[2][:32] {
		return "", "", false
	}
	return match[1], match[2], true
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

func validateCanonicalOrigin(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" || parsed.Path != "" || parsed.RawPath != "" || strings.HasSuffix(parsed.Host, ":") || nonCanonicalEndpointPort(parsed) || parsed.Host != strings.ToLower(parsed.Host) || parsed.String() != value {
		return errors.New("Takoserver canonical public origin must be one canonical HTTPS origin")
	}
	return nil
}

func validateActivationIdentity(reservationID, endpointResourceUID string) error {
	if !opaqueIDPattern.MatchString(reservationID) {
		return errors.New("worker endpoint origin reservation identity is invalid")
	}
	if !opaqueIDPattern.MatchString(endpointResourceUID) {
		return errors.New("worker endpoint resource identity is invalid")
	}
	return nil
}

func nonCanonicalEndpointPort(parsed *url.URL) bool {
	port := parsed.Port()
	if port == "" {
		return false
	}
	numeric, err := strconv.Atoi(port)
	return err != nil || numeric <= 0 || numeric > 65535 || strconv.Itoa(numeric) != port || (parsed.Scheme == "https" && numeric == 443) || (parsed.Scheme == "http" && numeric == 80)
}
