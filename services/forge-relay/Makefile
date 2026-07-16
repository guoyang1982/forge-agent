VERSION ?= dev

.PHONY: build test race vet fmt-check migrate-up

build:
	CGO_ENABLED=0 go build -trimpath -ldflags="-X github.com/guoyang1982/forge-agent/services/forge-relay/internal/buildinfo.Version=$(VERSION)" -o bin/forge-relay ./cmd/relay

test:
	go test ./...

race:
	go test -race ./...

vet:
	go vet ./...

fmt-check:
	test -z "$$(gofmt -l .)"

migrate-up:
	go run ./cmd/relay migrate up
