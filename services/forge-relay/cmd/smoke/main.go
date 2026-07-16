package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type state struct {
	HostID             string `json:"hostId"`
	HostCredential     string `json:"hostCredential"`
	IdentityPrivateKey string `json:"identityPrivateKey"`
	DeviceID           string `json:"deviceId"`
	ResumeToken        string `json:"resumeToken"`
}

type client struct {
	origin      string
	enrollToken string
	http        *http.Client
}

func main() {
	mode := flag.String("mode", "resume", "bootstrap or resume")
	origin := flag.String("origin", "http://127.0.0.1:58080", "Relay HTTP origin")
	stateFile := flag.String("state", "", "owner-only smoke state file")
	enrollToken := flag.String("enroll-token", "", "Relay enrollment token (bootstrap only)")
	flag.Parse()
	if *stateFile == "" {
		fatal(errors.New("-state is required"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := &client{origin: strings.TrimRight(*origin, "/"), enrollToken: *enrollToken, http: &http.Client{Timeout: 10 * time.Second}}

	var current state
	var err error
	switch *mode {
	case "bootstrap":
		current, err = c.bootstrap(ctx)
		if err == nil {
			err = writeState(*stateFile, current)
		}
	case "resume":
		current, err = readState(*stateFile)
		if err == nil {
			err = c.resume(ctx, current)
		}
	default:
		err = errors.New("-mode must be bootstrap or resume")
	}
	if err != nil {
		fatal(err)
	}
	fmt.Printf("Relay %s smoke passed for %s\n", *mode, current.HostID)
}

func (c *client) bootstrap(ctx context.Context) (state, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return state{}, err
	}
	e2eeKey := make([]byte, 32)
	if _, err := rand.Read(e2eeKey); err != nil {
		return state{}, err
	}
	var enrolled struct {
		HostID         string `json:"hostId"`
		HostCredential string `json:"hostCredential"`
	}
	if err := c.post(ctx, "/v1/hosts/enroll", c.enrollToken, map[string]string{
		"identityPublicKey": rawURL(publicKey), "e2eePublicKey": rawURL(e2eeKey),
	}, &enrolled); err != nil {
		return state{}, err
	}
	current := state{
		HostID: enrolled.HostID, HostCredential: enrolled.HostCredential,
		IdentityPrivateKey: rawURL(privateKey), DeviceID: "device_upgrade01",
	}
	control, err := c.connectHost(ctx, current)
	if err != nil {
		return state{}, err
	}
	defer control.Close(websocket.StatusNormalClosure, "bootstrap complete")

	requestID := "request_invite01"
	if err := writeJSON(ctx, control, map[string]any{
		"v": 1, "type": "invite.create", "requestId": requestID,
		"deviceId": current.DeviceID, "expiresInSeconds": 600,
	}); err != nil {
		return state{}, err
	}
	created, err := readJSON(ctx, control)
	if err != nil || created["type"] != "invite.created" {
		return state{}, fmt.Errorf("invite creation failed: %v %#v", err, created)
	}
	inviteToken, _ := created["inviteToken"].(string)
	if err := c.openAndSplice(ctx, control, current.HostID, current.DeviceID, "invite", inviteToken); err != nil {
		return state{}, err
	}
	resumeBytes := make([]byte, 32)
	if _, err := rand.Read(resumeBytes); err != nil {
		return state{}, err
	}
	current.ResumeToken = "resume_" + rawURL(resumeBytes)
	hash := sha256.Sum256([]byte(current.ResumeToken))
	if err := writeJSON(ctx, control, map[string]any{
		"v": 1, "type": "device.install", "requestId": "request_install01",
		"deviceId": current.DeviceID, "resumeTokenHash": rawURL(hash[:]), "credentialVersion": 1,
	}); err != nil {
		return state{}, err
	}
	installed, err := readJSON(ctx, control)
	if err != nil || installed["type"] != "device.installed" {
		return state{}, fmt.Errorf("device installation failed: %v %#v", err, installed)
	}
	return current, nil
}

func (c *client) resume(ctx context.Context, current state) error {
	control, err := c.connectHost(ctx, current)
	if err != nil {
		return err
	}
	defer control.Close(websocket.StatusNormalClosure, "resume complete")
	return c.openAndSplice(ctx, control, current.HostID, current.DeviceID, "resume", current.ResumeToken)
}

func (c *client) connectHost(ctx context.Context, current state) (*websocket.Conn, error) {
	var tokenResponse struct {
		JWT string `json:"jwt"`
	}
	if err := c.post(ctx, "/v1/hosts/token", "", map[string]string{
		"hostId": current.HostID, "credential": current.HostCredential,
	}, &tokenResponse); err != nil {
		return nil, err
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+tokenResponse.JWT)
	conn, _, err := websocket.Dial(ctx, c.wsURL("/v1/host/control"), &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		return nil, err
	}
	requestID := "request_hello01"
	if err := writeJSON(ctx, conn, map[string]any{
		"v": 1, "type": "host.hello", "requestId": requestID,
		"hostId": current.HostID, "credentialVersion": 1,
	}); err != nil {
		return nil, err
	}
	challengeMessage, err := readJSON(ctx, conn)
	if err != nil || challengeMessage["type"] != "host.challenge" {
		return nil, fmt.Errorf("host challenge failed: %v %#v", err, challengeMessage)
	}
	challenge, _ := challengeMessage["challenge"].(string)
	privateKey, err := base64.RawURLEncoding.DecodeString(current.IdentityPrivateKey)
	if err != nil || len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid smoke identity private key")
	}
	signature := ed25519.Sign(ed25519.PrivateKey(privateKey), []byte(challenge))
	if err := writeJSON(ctx, conn, map[string]any{
		"v": 1, "type": "host.proof", "requestId": requestID, "signature": rawURL(signature),
	}); err != nil {
		return nil, err
	}
	ready, err := readJSON(ctx, conn)
	if err != nil || ready["type"] != "host.ready" {
		return nil, fmt.Errorf("host ready failed: %v %#v", err, ready)
	}
	return conn, nil
}

func (c *client) openAndSplice(ctx context.Context, control *websocket.Conn, hostID, deviceID, kind, credential string) error {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+credential)
	headers.Set("X-Forge-Credential-Kind", kind)
	if kind == "resume" {
		headers.Set("X-Forge-Device-ID", deviceID)
	}
	phone, _, err := websocket.Dial(ctx, c.wsURL("/v1/connect/"+url.PathEscape(hostID)), &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		return err
	}
	defer phone.Close(websocket.StatusNormalClosure, "phone complete")
	opened, err := readJSON(ctx, control)
	if err != nil || opened["type"] != "connection.open" {
		return fmt.Errorf("connection.open failed: %v %#v", err, opened)
	}
	connID, _ := opened["connId"].(string)
	ticket, _ := opened["connTicket"].(string)
	hostHeaders := http.Header{}
	hostHeaders.Set("Authorization", "Bearer "+ticket)
	hostData, _, err := websocket.Dial(ctx, c.wsURL("/v1/host/data/"+url.PathEscape(connID)), &websocket.DialOptions{HTTPHeader: hostHeaders})
	if err != nil {
		return err
	}
	defer hostData.Close(websocket.StatusNormalClosure, "host data complete")
	payload := []byte("opaque-upgrade-smoke-ciphertext")
	if err := phone.Write(ctx, websocket.MessageBinary, payload); err != nil {
		return err
	}
	messageType, forwarded, err := hostData.Read(ctx)
	if err != nil || messageType != websocket.MessageBinary || !bytes.Equal(forwarded, payload) {
		return fmt.Errorf("opaque splice failed: %v", err)
	}
	return nil
}

func (c *client) post(ctx context.Context, path, bearer string, requestBody, responseBody any) error {
	body, _ := json.Marshal(requestBody)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.origin+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("POST %s returned %s", path, response.Status)
	}
	return json.NewDecoder(response.Body).Decode(responseBody)
}

func (c *client) wsURL(path string) string {
	return "ws" + strings.TrimPrefix(c.origin, "http") + path
}

func writeJSON(ctx context.Context, conn *websocket.Conn, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

func readJSON(ctx context.Context, conn *websocket.Conn) (map[string]any, error) {
	messageType, data, err := conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, errors.New("expected text control message")
	}
	var value map[string]any
	err = json.Unmarshal(data, &value)
	return value, err
}

func writeState(path string, value state) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func readState(path string) (state, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return state{}, err
	}
	var value state
	err = json.Unmarshal(data, &value)
	return value, err
}

func rawURL(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
