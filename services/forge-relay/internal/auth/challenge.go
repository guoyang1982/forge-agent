package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"
)

type Challenge struct {
	Version           int    `json:"v"`
	Origin            string `json:"origin"`
	HostID            string `json:"hostId"`
	CredentialVersion int    `json:"credentialVersion"`
	ExpiresAt         int64  `json:"expiresAt"`
	Nonce             string `json:"nonce"`
}

func NewChallenge(origin, hostID string, credentialVersion int, expiresAt time.Time) (string, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	payload, err := json.Marshal(Challenge{
		Version: 1, Origin: origin, HostID: hostID, CredentialVersion: credentialVersion,
		ExpiresAt: expiresAt.UnixMilli(), Nonce: base64.RawURLEncoding.EncodeToString(nonce),
	})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func VerifyChallengeProof(publicKey ed25519.PublicKey, encodedChallenge, encodedSignature string, expected Challenge, now time.Time) error {
	payload, err := base64.RawURLEncoding.DecodeString(encodedChallenge)
	if err != nil {
		return ErrTokenInvalid
	}
	var actual Challenge
	if err := json.Unmarshal(payload, &actual); err != nil {
		return ErrTokenInvalid
	}
	if actual != expected || actual.Version != 1 || actual.ExpiresAt <= now.UnixMilli() {
		return ErrTokenInvalid
	}
	signature, err := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err != nil || !ed25519.Verify(publicKey, []byte(encodedChallenge), signature) {
		return errors.New("challenge signature is invalid")
	}
	return nil
}
