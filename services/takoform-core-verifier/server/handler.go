package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/tako0614/takoserver/services/takoform-core-verifier/verifier"
)

const MaxRequestBytes = 48 << 20

type Handler struct {
	service *verifier.Service
}

func NewHandler(service *verifier.Service) http.Handler {
	return &Handler{service: service}
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/v1/identity":
		writeJSON(response, http.StatusOK, handler.service.Identity())
	case request.Method == http.MethodPost && request.URL.Path == "/v1/verify-set":
		handler.verifySet(response, request)
	default:
		http.NotFound(response, request)
	}
}

func (handler *Handler) verifySet(response http.ResponseWriter, request *http.Request) {
	if request.Header.Get("Content-Type") != "application/json" {
		writeJSON(response, http.StatusUnsupportedMediaType, map[string]string{"code": "json_required"})
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, MaxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input verifier.Request
	if err := decoder.Decode(&input); err != nil {
		status := http.StatusBadRequest
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSON(response, status, map[string]string{"code": "invalid_request"})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "invalid_request"})
		return
	}
	result, err := handler.service.VerifySet(request.Context(), input)
	if err != nil {
		status := http.StatusUnprocessableEntity
		code := "verification_refused"
		if errors.Is(err, verifier.ErrInvalidRequest) {
			status = http.StatusBadRequest
			code = "invalid_request"
		}
		writeJSON(response, status, map[string]string{"code": code})
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
