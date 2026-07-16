package metrics

import (
	"fmt"
	"io"
	"sync/atomic"
)

type Metrics struct {
	hostsOnline            atomic.Int64
	phoneConnectionsActive atomic.Int64
	splicesActive          atomic.Int64
	framesPhoneToHost      atomic.Uint64
	framesHostToPhone      atomic.Uint64
	bytesPhoneToHost       atomic.Uint64
	bytesHostToPhone       atomic.Uint64
	backpressureDisconnect atomic.Uint64
}

func (m *Metrics) SetHostsOnline(value int) { m.hostsOnline.Store(int64(value)) }
func (m *Metrics) AddPhoneConnections(delta int64) {
	m.phoneConnectionsActive.Add(delta)
}
func (m *Metrics) AddSplices(delta int64) { m.splicesActive.Add(delta) }
func (m *Metrics) RecordFrame(phoneToHost bool, bytes int) {
	if phoneToHost {
		m.framesPhoneToHost.Add(1)
		m.bytesPhoneToHost.Add(uint64(bytes))
		return
	}
	m.framesHostToPhone.Add(1)
	m.bytesHostToPhone.Add(uint64(bytes))
}
func (m *Metrics) RecordBackpressureDisconnect() { m.backpressureDisconnect.Add(1) }

func (m *Metrics) WritePrometheus(w io.Writer) {
	metric(w, "relay_hosts_online", m.hostsOnline.Load())
	metric(w, "relay_phone_connections_active", m.phoneConnectionsActive.Load())
	metric(w, "relay_splices_active", m.splicesActive.Load())
	metricLabel(w, "relay_frames_total", "direction", "phone_to_host", m.framesPhoneToHost.Load())
	metricLabel(w, "relay_frames_total", "direction", "host_to_phone", m.framesHostToPhone.Load())
	metricLabel(w, "relay_bytes_total", "direction", "phone_to_host", m.bytesPhoneToHost.Load())
	metricLabel(w, "relay_bytes_total", "direction", "host_to_phone", m.bytesHostToPhone.Load())
	metric(w, "relay_backpressure_disconnect_total", m.backpressureDisconnect.Load())
}

func metric(w io.Writer, name string, value any) {
	_, _ = fmt.Fprintf(w, "%s %v\n", name, value)
}

func metricLabel(w io.Writer, name, label, labelValue string, value any) {
	_, _ = fmt.Fprintf(w, "%s{%s=%q} %v\n", name, label, labelValue, value)
}
