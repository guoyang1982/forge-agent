package protocol

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

func TestAllGoldenFixturesAgainstCanonicalSchema(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "protocol", "relay", "v1")
	schemaBytes, err := os.ReadFile(filepath.Join(root, "schemas", "host-control.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schemaDocument any
	if err := json.Unmarshal(schemaBytes, &schemaDocument); err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("host-control.schema.json", schemaDocument); err != nil {
		t.Fatal(err)
	}
	compiled, err := compiler.Compile("host-control.schema.json")
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name      string
		file      string
		wantValid bool
	}{
		{name: "valid", file: "host-control.valid.jsonl", wantValid: true},
		{name: "invalid", file: "host-control.invalid.jsonl", wantValid: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			file, err := os.Open(filepath.Join(root, "testdata", test.file))
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			scanner := bufio.NewScanner(file)
			line := 0
			for scanner.Scan() {
				line++
				text := strings.TrimSpace(scanner.Text())
				if text == "" {
					continue
				}
				var message any
				if err := json.Unmarshal([]byte(text), &message); err != nil {
					t.Fatalf("line %d is not JSON: %v", line, err)
				}
				err := compiled.Validate(message)
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
		})
	}
}
