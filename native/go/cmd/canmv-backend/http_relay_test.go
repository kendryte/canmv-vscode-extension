//go:build linux

package main

import (
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type relayTestEvent struct {
	name   string
	params interface{}
}

type relayTestWriter struct {
	events chan relayTestEvent
}

func (writer *relayTestWriter) Event(name string, params interface{}) error {
	writer.events <- relayTestEvent{name: name, params: params}
	return nil
}

func TestListenHTTPRelayUsesRequestedPort(t *testing.T) {
	dynamic, err := listenHTTPRelay(0)
	if err != nil {
		t.Fatal(err)
	}
	port := dynamic.Addr().(*net.TCPAddr).Port
	if err := dynamic.Close(); err != nil {
		t.Fatal(err)
	}

	requested, err := listenHTTPRelay(port)
	if err != nil {
		t.Fatalf("listenHTTPRelay(%d): %v", port, err)
	}
	defer requested.Close()
	if got := requested.Addr().(*net.TCPAddr).Port; got != port {
		t.Fatalf("listenHTTPRelay(%d) selected %d", port, got)
	}
	if duplicate, err := listenHTTPRelay(port); err == nil {
		duplicate.Close()
		t.Fatalf("listenHTTPRelay(%d) unexpectedly accepted an occupied port", port)
	}
}

func TestHTTPRelayForwardsAllowedRequest(t *testing.T) {
	writer := &relayTestWriter{events: make(chan relayTestEvent, 1)}
	relay := &httpRelay{writer: writer, pending: make(map[uint64]chan httpRelayResponse)}
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/health", nil)
	request.Header.Set("Authorization", "Bearer test-token")
	request.Header.Set("Connection", "keep-alive")
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		relay.ServeHTTP(recorder, request)
		close(done)
	}()

	var event relayTestEvent
	select {
	case event = <-writer.events:
	case <-time.After(time.Second):
		t.Fatal("relay did not publish request")
	}
	requestEvent, ok := event.params.(httpRelayRequest)
	if !ok {
		t.Fatalf("relay request params = %T", event.params)
	}
	if event.name != "httpRelayRequest" || requestEvent.Path != "/health" {
		t.Fatalf("unexpected relay event: %#v", event)
	}
	if values := requestEvent.Headers["Authorization"]; len(values) != 1 || values[0] != "Bearer test-token" {
		got := ""
		if len(values) > 0 {
			got = values[0]
		}
		t.Fatalf("Authorization header = %q", got)
	}
	if _, found := requestEvent.Headers["Connection"]; found {
		t.Fatal("relay forwarded a hop-by-hop header")
	}

	relay.deliver(map[string]interface{}{
		"requestId":  float64(requestEvent.RequestID),
		"statusCode": float64(http.StatusOK),
		"headers": map[string]interface{}{
			"Content-Type": []interface{}{"application/json"},
		},
		"bodyBase64": base64.StdEncoding.EncodeToString([]byte(`{"ok":true}`)),
	})
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("relay did not return upstream response")
	}
	if recorder.Code != http.StatusOK || recorder.Body.String() != `{"ok":true}` {
		t.Fatalf("relay response = (%d, %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
}

func TestHTTPRelaySelfTestTraversesRelay(t *testing.T) {
	writer := &relayTestWriter{events: make(chan relayTestEvent, 2)}
	relay := &httpRelay{writer: writer, pending: make(map[uint64]chan httpRelayResponse)}
	server := httptest.NewServer(relay)
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port

	go relay.runSelfTest(port, "test-token")
	var requestEvent relayTestEvent
	select {
	case requestEvent = <-writer.events:
	case <-time.After(time.Second):
		t.Fatal("self-test did not publish a relay request")
	}
	request, ok := requestEvent.params.(httpRelayRequest)
	if !ok || requestEvent.name != "httpRelayRequest" {
		t.Fatalf("unexpected self-test request event: %#v", requestEvent)
	}
	if values := request.Headers["Authorization"]; len(values) != 1 || values[0] != "Bearer test-token" {
		t.Fatalf("self-test Authorization header = %#v", values)
	}
	relay.deliver(map[string]interface{}{
		"requestId":  float64(request.RequestID),
		"statusCode": float64(http.StatusOK),
		"headers": map[string]interface{}{
			"Content-Type": []interface{}{"application/json"},
		},
		"bodyBase64": base64.StdEncoding.EncodeToString([]byte(`{"service":"canmv-k230","transport":"streamable-http"}`)),
	})

	var resultEvent relayTestEvent
	select {
	case resultEvent = <-writer.events:
	case <-time.After(time.Second):
		t.Fatal("self-test did not publish its result")
	}
	result, ok := resultEvent.params.(httpRelaySelfTestResult)
	if !ok || resultEvent.name != "httpRelaySelfTestResult" || !result.OK || result.StatusCode != http.StatusOK {
		t.Fatalf("unexpected self-test result event: %#v", resultEvent)
	}
}

func TestHTTPRelaySelfTestReportsUpstreamStatus(t *testing.T) {
	writer := &relayTestWriter{events: make(chan relayTestEvent, 2)}
	relay := &httpRelay{writer: writer, pending: make(map[uint64]chan httpRelayResponse)}
	server := httptest.NewServer(relay)
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port

	go relay.runSelfTest(port, "wrong-token")
	var requestEvent relayTestEvent
	select {
	case requestEvent = <-writer.events:
	case <-time.After(time.Second):
		t.Fatal("failed self-test did not publish a relay request")
	}
	request, ok := requestEvent.params.(httpRelayRequest)
	if !ok || requestEvent.name != "httpRelayRequest" {
		t.Fatalf("unexpected self-test request event: %#v", requestEvent)
	}
	relay.deliver(map[string]interface{}{
		"requestId":  float64(request.RequestID),
		"statusCode": float64(http.StatusUnauthorized),
		"headers":    map[string]interface{}{},
		"bodyBase64": base64.StdEncoding.EncodeToString([]byte(`{"error":"Unauthorized"}`)),
	})

	var resultEvent relayTestEvent
	select {
	case resultEvent = <-writer.events:
	case <-time.After(time.Second):
		t.Fatal("failed self-test did not publish its result")
	}
	result, ok := resultEvent.params.(httpRelaySelfTestResult)
	if !ok || resultEvent.name != "httpRelaySelfTestResult" {
		t.Fatalf("unexpected self-test result event: %#v", resultEvent)
	}
	if result.OK || result.StatusCode != http.StatusUnauthorized || result.Error == "" {
		t.Fatalf("unexpected failed self-test result: %#v", result)
	}
}

func TestHTTPRelayRejectsUnsupportedRouteAndMethod(t *testing.T) {
	writer := &relayTestWriter{events: make(chan relayTestEvent, 1)}
	relay := &httpRelay{writer: writer, pending: make(map[uint64]chan httpRelayResponse)}
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "http://127.0.0.1/mcp", nil),
		httptest.NewRequest(http.MethodPost, "http://127.0.0.1/other", nil),
	} {
		recorder := httptest.NewRecorder()
		relay.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("unsupported request returned %d", recorder.Code)
		}
	}
	select {
	case event := <-writer.events:
		t.Fatalf("unsupported request emitted event: %#v", event)
	default:
	}
}
