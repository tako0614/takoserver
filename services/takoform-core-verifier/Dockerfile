FROM golang:1.25.8-alpine3.22@sha256:6b7607461f105ccaa0615b6f7932dfd5b36c5d827a0770b5578e565107cc3adb AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY server ./server
COPY verifier ./verifier
ARG TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST
RUN test -n "$TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST" && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/takoform-core-verifier ./cmd/server
RUN mkdir -p /out/tmp && chmod 1777 /out/tmp

FROM scratch
COPY --from=build /out/takoform-core-verifier /takoform-core-verifier
COPY --from=build --chmod=1777 /out/tmp /tmp
ARG TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST
ENV TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST=$TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST
ENV TMPDIR=/tmp
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/takoform-core-verifier"]
