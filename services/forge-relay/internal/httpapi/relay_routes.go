package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/auth"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/control"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/lease"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/protocol"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/splice"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/store"
)

type RelayDependencies struct {
	Store  *store.Postgres
	Signer *auth.Signer
	Broker *control.Broker
}

func (s *Server) EnableRelayRoutes(deps RelayDependencies) {
	s.readyCheck = deps.Store.Ping
	s.mux.HandleFunc("POST /v1/hosts/enroll", s.enrollHost(deps))
	s.mux.HandleFunc("POST /v1/hosts/token", s.hostToken(deps))
	s.mux.HandleFunc("POST /v1/resolve", s.resolveHost(deps))
	s.mux.HandleFunc("GET /v1/host/control", s.hostControl(deps))
	s.mux.HandleFunc("GET /v1/host/data/{connId}", s.hostData(deps))
	s.mux.HandleFunc("GET /v1/connect/{hostId}", s.phoneConnect(deps))
}

func (s *Server) enrollHost(deps RelayDependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !constantTokenEqual(bearer(r), s.cfg.EnrollToken) {
			writePublicError(w, http.StatusUnauthorized, "unauthorized", "enrollment credential rejected", false)
			return
		}
		var request struct {
			IdentityPublicKey string `json:"identityPublicKey"`
			E2EEPublicKey     string `json:"e2eePublicKey"`
		}
		if err := decodeBody(r, &request); err != nil {
			writePublicError(w, http.StatusBadRequest, "bad_request", "invalid enrollment request", false)
			return
		}
		identityKey, err1 := decodeKey(request.IdentityPublicKey)
		e2eeKey, err2 := decodeKey(request.E2EEPublicKey)
		if err1 != nil || err2 != nil {
			writePublicError(w, http.StatusBadRequest, "bad_request", "public keys must be canonical base64url 32-byte keys", false)
			return
		}
		host, credential, err := deps.Store.EnrollHost(r.Context(), identityKey, e2eeKey)
		if err != nil {
			s.log.Error("host enrollment failed", "error", err)
			writePublicError(w, http.StatusInternalServerError, "internal", "host enrollment failed", true)
			return
		}
		s.auditEvent(r.Context(), deps.Store, "host.enroll", "ok", host.HostID, "", nil)
		writeJSON(w, http.StatusCreated, map[string]any{
			"v": 1, "hostId": host.HostID, "hostCredential": credential, "credentialVersion": host.CredentialVersion,
		})
	}
}

func (s *Server) hostToken(deps RelayDependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			HostID     string `json:"hostId"`
			Credential string `json:"credential"`
		}
		if err := decodeBody(r, &request); err != nil {
			writePublicError(w, http.StatusBadRequest, "bad_request", "invalid token request", false)
			return
		}
		host, err := deps.Store.AuthenticateHost(r.Context(), request.HostID, request.Credential)
		if err != nil {
			s.auditEvent(r.Context(), deps.Store, "host.token", "unauthorized", request.HostID, "", nil)
			writePublicError(w, http.StatusUnauthorized, "unauthorized", "host credential rejected", false)
			return
		}
		s.auditEvent(r.Context(), deps.Store, "host.token", "ok", host.HostID, "", nil)
		token, claims, err := deps.Signer.SignHost(host.HostID, host.CredentialVersion, 5*time.Minute)
		if err != nil {
			writePublicError(w, http.StatusInternalServerError, "internal", "token signing failed", true)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"v": 1, "jwt": token, "expiresAt": claims.ExpiresAt * 1000})
	}
}

func (s *Server) resolveHost(deps RelayDependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			HostID string `json:"hostId"`
		}
		if err := decodeBody(r, &request); err != nil {
			writePublicError(w, http.StatusBadRequest, "bad_request", "invalid resolve request", false)
			return
		}
		if _, err := deps.Store.Host(r.Context(), request.HostID); err != nil {
			writePublicError(w, http.StatusNotFound, "not_found", "host not found", false)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"v": 1, "hostId": request.HostID, "relayOrigin": s.cfg.PublicOrigin})
	}
}

func (s *Server) hostControl(deps RelayDependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := deps.Signer.VerifyHost(bearer(r))
		if err != nil {
			writePublicError(w, http.StatusUnauthorized, "unauthorized", "host token rejected", false)
			return
		}
		hostRecord, err := deps.Store.Host(r.Context(), claims.Subject)
		if err != nil || hostRecord.CredentialVersion != claims.CredentialVersion || len(hostRecord.IdentityPublicKey) != ed25519.PublicKeySize {
			writePublicError(w, http.StatusUnauthorized, "unauthorized", "host token is stale", false)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(64 * 1024)
		defer conn.Close(websocket.StatusNormalClosure, "control closed")
		ctx := r.Context()
		var writeMu sync.Mutex
		write := func(body any) error {
			data, err := json.Marshal(body)
			if err != nil {
				return err
			}
			writeMu.Lock()
			defer writeMu.Unlock()
			writeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return conn.Write(writeCtx, websocket.MessageText, data)
		}

		handshakeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		helloRaw, err := readText(handshakeCtx, conn)
		if err != nil {
			return
		}
		helloAny, err := protocol.DecodeClientControl(helloRaw)
		hello, ok := helloAny.(protocol.HostHello)
		if err != nil || !ok || hello.HostID != claims.Subject || hello.CredentialVersion != claims.CredentialVersion {
			_ = write(publicError("unauthorized", "host hello rejected", false))
			return
		}
		expiresAt := time.Now().Add(10 * time.Second)
		challenge, err := auth.NewChallenge(s.cfg.PublicOrigin, hello.HostID, hello.CredentialVersion, expiresAt)
		if err != nil {
			return
		}
		if err := write(map[string]any{"v": 1, "type": "host.challenge", "requestId": hello.RequestID, "challenge": challenge, "expiresAt": expiresAt.UnixMilli()}); err != nil {
			return
		}
		proofRaw, err := readText(handshakeCtx, conn)
		if err != nil {
			return
		}
		proofAny, err := protocol.DecodeClientControl(proofRaw)
		proof, ok := proofAny.(protocol.HostProof)
		if err != nil || !ok || proof.RequestID != hello.RequestID {
			_ = write(publicError("unauthorized", "host proof rejected", false))
			return
		}
		expected, err := parseChallenge(challenge)
		if err != nil || auth.VerifyChallengeProof(ed25519.PublicKey(hostRecord.IdentityPublicKey), challenge, proof.Signature, expected, time.Now()) != nil {
			_ = write(publicError("unauthorized", "host proof rejected", false))
			return
		}
		leaseID, err := secureID("lease_", 18)
		if err != nil {
			return
		}
		leaseExpiresAt := time.Now().Add(s.cfg.HostLeaseDuration)
		_, err = s.hosts.Register(lease.Host{
			HostID: hello.HostID, LeaseID: leaseID, ExpiresAt: leaseExpiresAt,
			Send: func(data []byte) error {
				var body any
				if err := json.Unmarshal(data, &body); err != nil {
					return err
				}
				return write(body)
			},
			Close: func(error) { _ = conn.Close(websocket.StatusPolicyViolation, "control replaced") },
		})
		if err != nil {
			_ = write(publicError("rate_limited", "host capacity reached", true))
			return
		}
		defer s.hosts.Unregister(hello.HostID, leaseID)
		if err := write(map[string]any{"v": 1, "type": "host.ready", "requestId": hello.RequestID, "leaseId": leaseID, "leaseExpiresAt": leaseExpiresAt.UnixMilli()}); err != nil {
			return
		}
		s.auditEvent(ctx, deps.Store, "host.control.ready", "ok", hello.HostID, "", nil)
		authExpiry := time.AfterFunc(time.Until(time.Unix(claims.ExpiresAt, 0)), func() {
			_ = conn.Close(websocket.StatusPolicyViolation, "host token expired")
		})
		defer authExpiry.Stop()
		leaseExpiry := time.AfterFunc(time.Until(leaseExpiresAt), func() {
			_ = conn.Close(websocket.StatusPolicyViolation, "host lease expired")
		})
		defer leaseExpiry.Stop()
		s.controlLoop(ctx, conn, write, hello.HostID, hello.CredentialVersion, leaseID, authExpiry, leaseExpiry, deps)
	}
}

func (s *Server) controlLoop(ctx context.Context, conn *websocket.Conn, write func(any) error, hostID string, credentialVersion int, leaseID string, authExpiry, leaseExpiry *time.Timer, deps RelayDependencies) {
	for {
		data, err := readText(ctx, conn)
		if err != nil {
			return
		}
		message, err := protocol.DecodeClientControl(data)
		if err != nil {
			_ = write(publicError("bad_request", "invalid control message", false))
			continue
		}
		switch value := message.(type) {
		case protocol.AuthRefresh:
			claims, err := deps.Signer.VerifyHost(value.JWT)
			if err != nil || claims.Subject != hostID || claims.CredentialVersion != credentialVersion {
				_ = write(publicErrorWithRequest(value.RequestID, "unauthorized", "refreshed token rejected", false))
				return
			}
			authExpiry.Reset(time.Until(time.Unix(claims.ExpiresAt, 0)))
		case protocol.LeaseRenew:
			if value.LeaseID != leaseID {
				_ = write(publicError("conflict", "lease mismatch", false))
				return
			}
			expiresAt := time.Now().Add(s.cfg.HostLeaseDuration)
			if err := s.hosts.Renew(hostID, leaseID, expiresAt); err != nil {
				return
			}
			leaseExpiry.Reset(time.Until(expiresAt))
			_ = write(map[string]any{"v": 1, "type": "lease.renewed", "requestId": value.RequestID, "leaseId": leaseID, "leaseExpiresAt": expiresAt.UnixMilli()})
		case protocol.InviteCreate:
			invite, err := deps.Store.CreateInvite(ctx, hostID, value.DeviceID, time.Duration(value.ExpiresInSeconds)*time.Second)
			if err != nil {
				_ = write(publicErrorWithRequest(value.RequestID, "internal", "invite creation failed", true))
				continue
			}
			s.auditEvent(ctx, deps.Store, "invite.create", "ok", hostID, value.DeviceID, map[string]any{"requestId": value.RequestID})
			_ = write(map[string]any{"v": 1, "type": "invite.created", "requestId": value.RequestID, "inviteId": invite.InviteID, "inviteToken": invite.InviteToken, "expiresAt": invite.ExpiresAt.UnixMilli()})
		case protocol.InviteRevoke:
			if err := deps.Store.RevokeInvite(ctx, hostID, value.InviteID); err != nil {
				_ = write(publicErrorWithRequest(value.RequestID, "not_found", "invite not found", false))
				continue
			}
			_ = write(map[string]any{"v": 1, "type": "invite.revoked", "requestId": value.RequestID, "inviteId": value.InviteID})
		case protocol.DeviceInstall:
			tokenHash, err := base64.RawURLEncoding.DecodeString(value.ResumeTokenHash)
			if err != nil || len(tokenHash) != sha256.Size {
				_ = write(publicErrorWithRequest(value.RequestID, "bad_request", "invalid resume token hash", false))
				continue
			}
			if err := deps.Store.InstallDeviceHash(ctx, hostID, value.DeviceID, tokenHash, value.CredentialVersion, time.Now().Add(90*24*time.Hour)); err != nil {
				_ = write(publicErrorWithRequest(value.RequestID, "internal", "device installation failed", true))
				continue
			}
			_ = write(map[string]any{"v": 1, "type": "device.installed", "requestId": value.RequestID, "deviceId": value.DeviceID})
		case protocol.DeviceRevoke:
			if err := deps.Store.RevokeDevice(ctx, hostID, value.DeviceID); err != nil {
				_ = write(publicErrorWithRequest(value.RequestID, "not_found", "device not found", false))
				continue
			}
			deps.Broker.CloseDevice(hostID, value.DeviceID, errors.New("device revoked"))
			s.auditEvent(ctx, deps.Store, "device.revoke", "ok", hostID, value.DeviceID, map[string]any{"requestId": value.RequestID})
			_ = write(map[string]any{"v": 1, "type": "device.revoked", "requestId": value.RequestID, "deviceId": value.DeviceID})
		case protocol.Pong:
		default:
			_ = write(publicError("bad_request", "control message is not valid in ready state", false))
		}
	}
}

func (s *Server) phoneConnect(deps RelayDependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hostID := r.PathValue("hostId")
		if _, err := s.hosts.Get(hostID); err != nil {
			writePublicError(w, http.StatusServiceUnavailable, "not_found", "host is offline", true)
			return
		}
		kind := r.Header.Get("X-Forge-Credential-Kind")
		var credential store.DeviceCredential
		var err error
		switch kind {
		case "invite":
			credential, err = deps.Store.ConsumeInvite(r.Context(), hostID, bearer(r))
		case "resume":
			deviceID := r.Header.Get("X-Forge-Device-ID")
			if deviceID == "" {
				writePublicError(w, http.StatusBadRequest, "bad_request", "device ID is required", false)
				return
			}
			credential, err = deps.Store.AuthenticateResume(r.Context(), hostID, deviceID, bearer(r))
		default:
			writePublicError(w, http.StatusBadRequest, "bad_request", "unsupported credential kind", false)
			return
		}
		if err != nil {
			s.auditEvent(r.Context(), deps.Store, "phone.connect", "unauthorized", hostID, credential.DeviceID, map[string]any{"credentialKind": kind})
			writePublicError(w, http.StatusUnauthorized, "unauthorized", "device credential rejected", false)
			return
		}
		s.auditEvent(r.Context(), deps.Store, "phone.connect", "ok", hostID, credential.DeviceID, map[string]any{"credentialKind": credential.Kind})
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		endpoint := splice.NewWebSocketEndpoint(conn, s.cfg.MaxFrameBytes)
		s.metrics.AddPhoneConnections(1)
		defer s.metrics.AddPhoneConnections(-1)
		if _, err := deps.Broker.Open(hostID, credential.DeviceID, credential.Kind, endpoint); err != nil {
			endpoint.Close(err)
			return
		}
		<-endpoint.Done()
	}
}

func (s *Server) hostData(deps RelayDependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		connID := r.PathValue("connId")
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		endpoint := splice.NewWebSocketEndpoint(conn, s.cfg.MaxFrameBytes)
		if err := deps.Broker.Attach(r.Context(), connID, bearer(r), endpoint); err != nil {
			endpoint.Close(err)
			return
		}
		<-endpoint.Done()
	}
}

func decodeBody(r *http.Request, destination any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("request must contain exactly one JSON value")
	}
	return nil
}

func decodeKey(value string) ([]byte, error) {
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(data) != 32 || base64.RawURLEncoding.EncodeToString(data) != value {
		return nil, errors.New("invalid key")
	}
	return data, nil
}

func bearer(r *http.Request) string {
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func constantTokenEqual(actual, expected string) bool {
	actualHash, expectedHash := sha256.Sum256([]byte(actual)), sha256.Sum256([]byte(expected))
	return expected != "" && subtle.ConstantTimeCompare(actualHash[:], expectedHash[:]) == 1
}

func readText(ctx context.Context, conn *websocket.Conn) ([]byte, error) {
	messageType, data, err := conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, errors.New("control messages must be text")
	}
	return data, nil
}

func parseChallenge(encoded string) (auth.Challenge, error) {
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return auth.Challenge{}, err
	}
	var challenge auth.Challenge
	err = json.Unmarshal(payload, &challenge)
	return challenge, err
}

func secureID(prefix string, size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(data), nil
}

func publicError(code, message string, retryable bool) map[string]any {
	return map[string]any{"v": 1, "type": "error", "code": code, "message": message, "retryable": retryable}
}

func publicErrorWithRequest(requestID, code, message string, retryable bool) map[string]any {
	errorBody := publicError(code, message, retryable)
	errorBody["requestId"] = requestID
	return errorBody
}

func writePublicError(w http.ResponseWriter, status int, code, message string, retryable bool) {
	writeJSON(w, status, publicError(code, message, retryable))
}

func (s *Server) auditEvent(ctx context.Context, database *store.Postgres, eventType, resultCode, hostID, deviceID string, metadata map[string]any) {
	attrs := make([]any, 0, len(metadata)*2)
	for key, value := range metadata {
		attrs = append(attrs, key, value)
	}
	s.auditor.Event(eventType, resultCode, hostID, deviceID, attrs...)
	auditCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if err := database.RecordAudit(auditCtx, eventType, resultCode, hostID, deviceID, metadata); err != nil {
		s.log.Warn("relay audit persistence failed", "event_type", eventType, "error", err)
	}
}
