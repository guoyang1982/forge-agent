package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

type Envelope struct {
	Version   int    `json:"v"`
	Type      string `json:"type"`
	RequestID string `json:"requestId,omitempty"`
}

type HostHello struct {
	Envelope
	HostID            string `json:"hostId"`
	CredentialVersion int    `json:"credentialVersion"`
}

type LeaseRenew struct {
	Envelope
	LeaseID string `json:"leaseId"`
}

type HostProof struct {
	Envelope
	Signature string `json:"signature"`
}

type AuthRefresh struct {
	Envelope
	JWT string `json:"jwt"`
}

type InviteCreate struct {
	Envelope
	DeviceID         string `json:"deviceId"`
	ExpiresInSeconds int    `json:"expiresInSeconds"`
}

type InviteRevoke struct {
	Envelope
	InviteID string `json:"inviteId"`
}

type DeviceInstall struct {
	Envelope
	DeviceID          string `json:"deviceId"`
	ResumeTokenHash   string `json:"resumeTokenHash"`
	CredentialVersion int    `json:"credentialVersion"`
}

type DeviceRevoke struct {
	Envelope
	DeviceID string `json:"deviceId"`
}

type Pong struct {
	Envelope
	Timestamp int64 `json:"timestamp"`
}

type ControlMessage interface {
	HostHello | HostProof | AuthRefresh | InviteCreate | InviteRevoke | DeviceInstall | DeviceRevoke | LeaseRenew | Pong
}

func DecodeClientControl(data []byte) (any, error) {
	var envelope Envelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, errors.New("invalid JSON")
	}
	if envelope.Version != 1 {
		return nil, errors.New("unsupported protocol version")
	}
	switch envelope.Type {
	case "host.hello":
		message, err := decodeStrict[HostHello](data)
		if err != nil {
			return nil, err
		}
		if !validID(message.RequestID) || !validID(message.HostID) || message.CredentialVersion < 1 {
			return nil, errors.New("invalid host.hello fields")
		}
		return message, nil
	case "lease.renew":
		message, err := decodeStrict[LeaseRenew](data)
		if err != nil {
			return nil, err
		}
		if !validID(message.RequestID) || !validID(message.LeaseID) {
			return nil, errors.New("invalid lease.renew fields")
		}
		return message, nil
	case "host.proof":
		message, err := decodeStrict[HostProof](data)
		if err != nil {
			return nil, err
		}
		if !validID(message.RequestID) || len(message.Signature) < 32 || len(message.Signature) > 4096 {
			return nil, errors.New("invalid host.proof fields")
		}
		return message, nil
	case "auth.refresh":
		message, err := decodeStrict[AuthRefresh](data)
		if err != nil {
			return nil, err
		}
		if !validID(message.RequestID) || len(message.JWT) < 32 || len(message.JWT) > 4096 {
			return nil, errors.New("invalid auth.refresh fields")
		}
		return message, nil
	case "invite.create":
		message, err := decodeStrict[InviteCreate](data)
		if err != nil {
			return nil, err
		}
		if !validID(message.RequestID) || !validID(message.DeviceID) || message.ExpiresInSeconds < 30 || message.ExpiresInSeconds > 600 {
			return nil, errors.New("invalid invite.create fields")
		}
		return message, nil
	case "invite.revoke":
		message, err := decodeStrict[InviteRevoke](data)
		if err != nil {
			return nil, err
		}
		if !validID(message.RequestID) || !validID(message.InviteID) {
			return nil, errors.New("invalid invite.revoke fields")
		}
		return message, nil
	case "device.install":
		message, err := decodeStrict[DeviceInstall](data)
		if err != nil {
			return nil, err
		}
		if !validID(message.RequestID) || !validID(message.DeviceID) || len(message.ResumeTokenHash) != 43 || message.CredentialVersion < 1 {
			return nil, errors.New("invalid device.install fields")
		}
		return message, nil
	case "device.revoke":
		message, err := decodeStrict[DeviceRevoke](data)
		if err != nil {
			return nil, err
		}
		if !validID(message.RequestID) || !validID(message.DeviceID) {
			return nil, errors.New("invalid device.revoke fields")
		}
		return message, nil
	case "pong":
		message, err := decodeStrict[Pong](data)
		if err != nil {
			return nil, err
		}
		if message.Timestamp < 1 {
			return nil, errors.New("invalid pong timestamp")
		}
		return message, nil
	default:
		return nil, fmt.Errorf("unsupported client control message %q", envelope.Type)
	}
}

func decodeStrict[T ControlMessage](data []byte) (T, error) {
	var message T
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&message); err != nil {
		return message, errors.New("invalid control message")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return message, errors.New("multiple JSON values are not allowed")
	}
	return message, nil
}

func validID(value string) bool { return idPattern.MatchString(value) }
