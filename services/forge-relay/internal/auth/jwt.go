package auth

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

var (
	ErrTokenInvalid = errors.New("token is invalid")
	ErrTokenExpired = errors.New("token is expired")
)

const hostAudience = "forge-relay-host"

type HostClaims struct {
	Issuer            string `json:"iss"`
	Audience          string `json:"aud"`
	Subject           string `json:"sub"`
	CredentialVersion int    `json:"credentialVersion"`
	IssuedAt          int64  `json:"iat"`
	ExpiresAt         int64  `json:"exp"`
	JWTID             string `json:"jti"`
}

type Signer struct {
	issuer     string
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
	now        func() time.Time
}

func NewSigner(issuer string, privateKey ed25519.PrivateKey) (*Signer, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid Ed25519 private key")
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)
	return &Signer{issuer: issuer, privateKey: privateKey, publicKey: publicKey, now: time.Now}, nil
}

func LoadSigner(issuer, path string) (*Signer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read JWT private key: %w", err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("JWT private key is not PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse JWT private key: %w", err)
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("JWT private key must be Ed25519")
	}
	return NewSigner(issuer, privateKey)
}

func (s *Signer) SignHost(hostID string, credentialVersion int, lifetime time.Duration) (string, HostClaims, error) {
	now := s.now()
	jti, err := randomToken(16)
	if err != nil {
		return "", HostClaims{}, err
	}
	claims := HostClaims{
		Issuer: s.issuer, Audience: hostAudience, Subject: hostID,
		CredentialVersion: credentialVersion, IssuedAt: now.Unix(), ExpiresAt: now.Add(lifetime).Unix(), JWTID: jti,
	}
	header, _ := json.Marshal(map[string]string{"alg": "EdDSA", "typ": "JWT"})
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", HostClaims{}, err
	}
	signingInput := rawURL(header) + "." + rawURL(payload)
	signature := ed25519.Sign(s.privateKey, []byte(signingInput))
	return signingInput + "." + rawURL(signature), claims, nil
}

func (s *Signer) VerifyHost(token string) (HostClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return HostClaims{}, ErrTokenInvalid
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || !bytes.Equal(headerBytes, []byte(`{"alg":"EdDSA","typ":"JWT"}`)) {
		return HostClaims{}, ErrTokenInvalid
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(s.publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return HostClaims{}, ErrTokenInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return HostClaims{}, ErrTokenInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var claims HostClaims
	if err := decoder.Decode(&claims); err != nil {
		return HostClaims{}, ErrTokenInvalid
	}
	if claims.Issuer != s.issuer || claims.Audience != hostAudience || claims.Subject == "" || claims.CredentialVersion < 1 || claims.JWTID == "" {
		return HostClaims{}, ErrTokenInvalid
	}
	now := s.now().Unix()
	if claims.ExpiresAt <= now || claims.IssuedAt > now+30 {
		return HostClaims{}, ErrTokenExpired
	}
	return claims, nil
}

func rawURL(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

func randomToken(bytesCount int) (string, error) {
	data := make([]byte, bytesCount)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return rawURL(data), nil
}
