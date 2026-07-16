package audit

import (
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
)

type Logger struct{ log *slog.Logger }

func New(log *slog.Logger) *Logger { return &Logger{log: log} }

func (l *Logger) Event(eventType, resultCode, hostID, deviceID string, attrs ...any) {
	fields := []any{
		"event_type", eventType,
		"result_code", resultCode,
		"host_ref", opaqueRef(hostID),
		"device_ref", opaqueRef(deviceID),
	}
	fields = append(fields, attrs...)
	l.log.Info("relay audit event", fields...)
}

func opaqueRef(value string) string {
	if value == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:6])
}
