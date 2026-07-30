# syntax=docker/dockerfile:1.7
FROM golang:1.25.12-bookworm AS build
WORKDIR /src
# Default includes goproxy.cn for China ECS; override with --build-arg GOPROXY=...
ARG GOPROXY=https://goproxy.cn,https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY} \
    GOSUMDB=sum.golang.google.cn
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w -X github.com/guoyang1982/forge-agent/services/forge-relay/internal/buildinfo.Version=${VERSION}" -o /out/forge-relay ./cmd/relay

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/forge-relay /forge-relay
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/forge-relay"]
