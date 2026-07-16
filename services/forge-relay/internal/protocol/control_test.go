package protocol

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClientControlFixtures(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "protocol", "relay", "v1", "testdata")
	for _, test := range []struct {
		name      string
		file      string
		wantValid bool
	}{
		{name: "valid", file: "host-control.valid.jsonl", wantValid: true},
		{name: "invalid", file: "host-control.invalid.jsonl", wantValid: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			file, err := os.Open(filepath.Join(root, test.file))
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			scanner := bufio.NewScanner(file)
			line := 0
			matched := 0
			for scanner.Scan() {
				line++
				data := strings.TrimSpace(scanner.Text())
				if data == "" {
					continue
				}
				_, err := DecodeClientControl([]byte(data))
				// Fixtures contain both client- and server-originated messages. Only
				// client message types supported by this state machine are asserted.
				isClient := strings.Contains(data, `"type":"host.hello"`) || strings.Contains(data, `"type":"lease.renew"`) || strings.Contains(data, `"type":"pong"`)
				if !isClient {
					continue
				}
				matched++
				if test.wantValid && err != nil {
					t.Fatalf("line %d should be valid: %v", line, err)
				}
				if !test.wantValid && err == nil {
					t.Fatalf("line %d should be invalid", line)
				}
			}
			if err := scanner.Err(); err != nil {
				t.Fatal(err)
			}
			if matched == 0 {
				t.Fatal("fixture did not contain a supported client message")
			}
		})
	}
}
