// Core-parity harness: proves the TS SDK's wire output is accepted by the REAL
// Core contract, from two angles:
//
//  1. Structural: the SpanData struct below is copied VERBATIM from
//     openbox-core internal/content/governance.go (SpanData + SpanStatus +
//     SpanEvent). Decoding with DisallowUnknownFields keeps the SDK honest —
//     any unknown top-level span field the SDK emits fails the parse. Internal
//     Core packages can't be imported from an external module, so the contract
//     is pinned by copy, cited to its source.
//  2. Signing: crypto/ed25519 (the same primitive Core's verifier uses) checks
//     a TS-produced signature over the TS-produced canonical string. This proves
//     TS ≡ Core signing, not merely TS ≡ Python (the golden fixture proves the
//     latter).
//
// Usage: go run main.go   (reads a JSON envelope from stdin, writes a report)
//   in:  {"spans": [ ...SpanData... ], "signature": {"canonical","signature_b64","public_key_b64"}}  (both optional)
//   out: {"spans": [ ...report... ], "signature_valid": bool}
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
)

// SpanData represents a single OTel span (governance.go:266, verbatim).
type SpanData struct {
	SpanID          string                 `json:"span_id"`
	TraceID         string                 `json:"trace_id"`
	ParentSpanID    *string                `json:"parent_span_id,omitempty"`
	Name            string                 `json:"name"`
	Kind            *string                `json:"kind,omitempty"`
	StartTime       int64                  `json:"start_time"`
	EndTime         int64                  `json:"end_time"`
	DurationNs      *int64                 `json:"duration_ns,omitempty"`
	Attributes      map[string]interface{} `json:"attributes,omitempty"`
	Status          *SpanStatus            `json:"status,omitempty"`
	Events          []SpanEvent            `json:"events,omitempty"`
	RequestHeaders  map[string]string      `json:"request_headers,omitempty"`
	ResponseHeaders map[string]string      `json:"response_headers,omitempty"`
	RequestBody     *string                `json:"request_body,omitempty"`
	ResponseBody    *string                `json:"response_body,omitempty"`
	SemanticType    string                 `json:"semantic_type,omitempty"`
	Stage           string                 `json:"stage,omitempty"`
	Data            interface{}            `json:"data,omitempty"`

	HookType                string   `json:"hook_type,omitempty"`
	AttributeKeyIdentifiers []string `json:"attribute_key_identifiers,omitempty"`
	SpanError               *string  `json:"error,omitempty"`

	HTTPMethod     *string `json:"http_method,omitempty"`
	HTTPURL        *string `json:"http_url,omitempty"`
	HTTPStatusCode *int    `json:"http_status_code,omitempty"`

	DBSystem    *string `json:"db_system,omitempty"`
	DBName      *string `json:"db_name,omitempty"`
	DBOperation *string `json:"db_operation,omitempty"`
	DBStatement *string `json:"db_statement,omitempty"`
	ServerAddr  *string `json:"server_address,omitempty"`
	ServerPort  *int    `json:"server_port,omitempty"`
	Rowcount    *int    `json:"rowcount,omitempty"`

	FilePath      *string `json:"file_path,omitempty"`
	FileMode      *string `json:"file_mode,omitempty"`
	FileOperation *string `json:"file_operation,omitempty"`
	BytesRead     *int64  `json:"bytes_read,omitempty"`
	BytesWritten  *int64  `json:"bytes_written,omitempty"`
	LinesCount    *int    `json:"lines_count,omitempty"`

	FuncName   *string     `json:"function,omitempty"`
	Module     *string     `json:"module,omitempty"`
	Args       interface{} `json:"args,omitempty"`
	FuncResult interface{} `json:"result,omitempty"`
}

type SpanStatus struct {
	Code        string  `json:"code"`
	Description *string `json:"description,omitempty"`
}

type SpanEvent struct {
	Name       string                 `json:"name"`
	Timestamp  int64                  `json:"timestamp"`
	Attributes map[string]interface{} `json:"attributes"`
}

type sigCheck struct {
	Canonical    string `json:"canonical"`
	SignatureB64 string `json:"signature_b64"`
	PublicKeyB64 string `json:"public_key_b64"`
}

type envelope struct {
	Spans     []SpanData `json:"spans"`
	Signature *sigCheck  `json:"signature"`
}

type spanReport struct {
	SpanID         string  `json:"span_id"`
	TraceID        string  `json:"trace_id"`
	Stage          string  `json:"stage"`
	HookType       string  `json:"hook_type"`
	Name           string  `json:"name"`
	StartTime      int64   `json:"start_time"`
	EndTime        int64   `json:"end_time"`
	HasDurationNs  bool    `json:"has_duration_ns"`
	SemanticType   string  `json:"semantic_type"`
	HTTPURL        *string `json:"http_url"`
	HTTPMethod     *string `json:"http_method"`
	HTTPStatusCode *int    `json:"http_status_code"`
	DBStatement    *string `json:"db_statement"`
	FilePath       *string `json:"file_path"`
	FuncName       *string `json:"function"`
	HasData        bool    `json:"has_data"`
	ParentSpanID   *string `json:"parent_span_id"`
}

type output struct {
	Spans          []spanReport `json:"spans"`
	SignatureValid *bool        `json:"signature_valid,omitempty"`
	SignatureError string       `json:"signature_error,omitempty"`
}

func main() {
	dec := json.NewDecoder(os.Stdin)
	dec.DisallowUnknownFields() // strict: SDK must not emit unknown top-level span fields
	var env envelope
	if err := dec.Decode(&env); err != nil {
		fmt.Fprintf(os.Stderr, "SpanData unmarshal rejected payload: %v\n", err)
		os.Exit(1)
	}

	out := output{Spans: make([]spanReport, 0, len(env.Spans))}
	for _, s := range env.Spans {
		out.Spans = append(out.Spans, spanReport{
			SpanID: s.SpanID, TraceID: s.TraceID, Stage: s.Stage, HookType: s.HookType,
			Name: s.Name, StartTime: s.StartTime, EndTime: s.EndTime,
			HasDurationNs: s.DurationNs != nil, SemanticType: s.SemanticType,
			HTTPURL: s.HTTPURL, HTTPMethod: s.HTTPMethod, HTTPStatusCode: s.HTTPStatusCode,
			DBStatement: s.DBStatement, FilePath: s.FilePath, FuncName: s.FuncName,
			HasData: s.Data != nil, ParentSpanID: s.ParentSpanID,
		})
	}

	if env.Signature != nil {
		valid := verifySignature(env.Signature)
		out.SignatureValid = &valid.ok
		out.SignatureError = valid.err
	}

	b, err := json.Marshal(out)
	if err != nil {
		fmt.Fprintf(os.Stderr, "report marshal failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(b))
}

type sigResult struct {
	ok  bool
	err string
}

func verifySignature(s *sigCheck) sigResult {
	pub, err := base64.StdEncoding.DecodeString(s.PublicKeyB64)
	if err != nil {
		return sigResult{false, "public_key_b64 not valid base64"}
	}
	sig, err := base64.StdEncoding.DecodeString(s.SignatureB64)
	if err != nil {
		return sigResult{false, "signature_b64 not valid base64"}
	}
	if len(pub) != ed25519.PublicKeySize {
		return sigResult{false, fmt.Sprintf("public key size %d != %d", len(pub), ed25519.PublicKeySize)}
	}
	ok := ed25519.Verify(ed25519.PublicKey(pub), []byte(s.Canonical), sig)
	return sigResult{ok, ""}
}
