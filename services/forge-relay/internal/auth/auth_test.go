package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestHostJWTRejectsTamperingAndExpiry(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, _ := NewSigner("https://relay.example.com", privateKey)
	now := time.Unix(1_800_000_000, 0)
	signer.now = func() time.Time { return now }
	token, claims, err := signer.SignHost("host_00000001", 3, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := signer.VerifyHost(token)
	if err != nil || verified.Subject != claims.Subject || verified.CredentialVersion != 3 {
		t.Fatalf("VerifyHost() = %#v, %v", verified, err)
	}
	if _, err := signer.VerifyHost(token + "x"); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("tampered token error = %v", err)
	}
	signer.now = func() time.Time { return now.Add(2 * time.Minute) }
	if _, err := signer.VerifyHost(token); !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("expired token error = %v", err)
	}
}

func TestChallengeBindsOriginHostVersionAndExpiry(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Unix(1_800_000_000, 0)
	expiresAt := now.Add(30 * time.Second)
	encoded, err := NewChallenge("https://relay.example.com", "host_00000001", 2, expiresAt)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, []byte(encoded)))
	expected := Challenge{Version: 1, Origin: "https://relay.example.com", HostID: "host_00000001", CredentialVersion: 2, ExpiresAt: expiresAt.UnixMilli()}
	// The random nonce is intentionally extracted from the signed challenge for
	// this connection; all other fields come from trusted server state.
	payload, _ := base64.RawURLEncoding.DecodeString(encoded)
	var actual Challenge
	_ = json.Unmarshal(payload, &actual)
	expected.Nonce = actual.Nonce
	if err := VerifyChallengeProof(publicKey, encoded, signature, expected, now); err != nil {
		t.Fatalf("VerifyChallengeProof() error = %v", err)
	}
	expected.Origin = "https://evil.example.com"
	if err := VerifyChallengeProof(publicKey, encoded, signature, expected, now); err == nil {
		t.Fatal("origin mismatch should be rejected")
	}
	expected.Origin = actual.Origin
	if err := VerifyChallengeProof(publicKey, encoded, signature, expected, expiresAt); err == nil {
		t.Fatal("expired challenge should be rejected")
	}
}
