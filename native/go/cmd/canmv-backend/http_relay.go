//go:build linux

package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"canmv-backend/internal/protocol"
)

const (
	relayMaxBodyBytes = 32 * 1024 * 1024
	relayRequestTTL   = 2 * time.Minute
	relaySelfTestTTL  = 5 * time.Second
)

type relayEventWriter interface {
	Event(name string, params interface{}) error
}

type httpRelay struct {
	writer  relayEventWriter
	nextID  atomic.Uint64
	mu      sync.Mutex
	pending map[uint64]chan httpRelayResponse
}

type httpRelayRequest struct {
	RequestID  uint64              `json:"requestId"`
	Method     string              `json:"method"`
	Path       string              `json:"path"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"bodyBase64"`
}

type httpRelayResponse struct {
	StatusCode int                 `json:"statusCode"`
	Headers    map[string][]string `json:"headers"`
	Body       []byte              `json:"-"`
}

type httpRelaySelfTestResult struct {
	OK         bool   `json:"ok"`
	StatusCode int    `json:"statusCode,omitempty"`
	Error      string `json:"error,omitempty"`
}

func runHTTPRelay(input io.Reader, output io.Writer, port int) error {
	conn := protocol.NewConn(input, output)
	relay := &httpRelay{writer: conn, pending: make(map[uint64]chan httpRelayResponse)}
	listener, err := listenHTTPRelay(port)
	if err != nil {
		return err
	}
	httpServer := &http.Server{
		Handler:           relay,
		ReadHeaderTimeout: 10 * time.Second,
	}
	defer func() {
		_ = httpServer.Close()
		relay.failPending()
	}()

	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- httpServer.Serve(listener)
	}()
	requests := make(chan protocol.Request)
	readErrors := make(chan error, 1)
	go func() {
		for {
			request, readErr := conn.ReadRequest()
			if readErr != nil {
				readErrors <- readErr
				return
			}
			requests <- request
		}
	}()

	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || address.Port <= 0 {
		return errors.New("unable to resolve HTTP relay address")
	}
	if err := conn.Event("httpRelayReady", map[string]interface{}{
		"host": "127.0.0.1",
		"port": address.Port,
	}); err != nil {
		return err
	}

	for {
		select {
		case request := <-requests:
			switch request.Method {
			case "httpRelayResponse":
				relay.deliver(request.Params)
			case "httpRelaySelfTest":
				token := stringParam(request.Params, "token", "")
				go relay.runSelfTest(address.Port, token)
			}
		case readErr := <-readErrors:
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		case serveErr := <-serveErrors:
			if errors.Is(serveErr, http.ErrServerClosed) {
				return nil
			}
			return serveErr
		}
	}
}

func listenHTTPRelay(port int) (net.Listener, error) {
	if port < 0 || port > 65535 {
		return nil, fmt.Errorf("invalid HTTP relay port %d", port)
	}
	return net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
}

func (relay *httpRelay) runSelfTest(port int, token string) {
	result := httpRelaySelfTestResult{}
	if token == "" {
		result.Error = "missing relay authentication token"
	} else {
		result.StatusCode, result.Error = requestRelayHealth(port, token)
		result.OK = result.Error == ""
	}
	_ = relay.writer.Event("httpRelaySelfTestResult", result)
}

func requestRelayHealth(port int, token string) (int, string) {
	request, err := http.NewRequest(
		http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d/health", port),
		nil,
	)
	if err != nil {
		return 0, err.Error()
	}
	request.Header.Set("Authorization", "Bearer "+token)
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: relaySelfTestTTL}
	response, err := client.Do(request)
	if err != nil {
		return 0, err.Error()
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return response.StatusCode, err.Error()
	}
	if response.StatusCode != http.StatusOK {
		return response.StatusCode, fmt.Sprintf("health request returned HTTP %d", response.StatusCode)
	}
	var health struct {
		Service   string `json:"service"`
		Transport string `json:"transport"`
	}
	if err := json.Unmarshal(body, &health); err != nil {
		return response.StatusCode, "health response is not valid JSON"
	}
	if health.Service != "canmv-k230" || health.Transport != "streamable-http" {
		return response.StatusCode, "health response does not identify the CanMV Streamable HTTP service"
	}
	return response.StatusCode, ""
}

func (relay *httpRelay) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !relayRequestAllowed(request) {
		http.Error(response, "Not found", http.StatusNotFound)
		return
	}
	body, err := readRelayBody(request.Body, request.ContentLength)
	if err != nil {
		http.Error(response, err.Error(), http.StatusRequestEntityTooLarge)
		return
	}

	requestID := relay.nextID.Add(1)
	responseChannel := make(chan httpRelayResponse, 1)
	relay.mu.Lock()
	relay.pending[requestID] = responseChannel
	relay.mu.Unlock()
	defer relay.removePending(requestID)

	event := httpRelayRequest{
		RequestID:  requestID,
		Method:     request.Method,
		Path:       request.URL.RequestURI(),
		Headers:    copyRelayHeaders(request.Header),
		BodyBase64: base64.StdEncoding.EncodeToString(body),
	}
	if err := relay.writer.Event("httpRelayRequest", event); err != nil {
		http.Error(response, "CanMV relay upstream is unavailable", http.StatusBadGateway)
		return
	}

	timer := time.NewTimer(relayRequestTTL)
	defer timer.Stop()
	select {
	case upstream := <-responseChannel:
		for key, values := range upstream.Headers {
			if relayHeaderAllowed(key) {
				for _, value := range values {
					response.Header().Add(key, value)
				}
			}
		}
		statusCode := upstream.StatusCode
		if statusCode < 100 || statusCode > 599 {
			statusCode = http.StatusBadGateway
		}
		response.WriteHeader(statusCode)
		_, _ = response.Write(upstream.Body)
	case <-request.Context().Done():
	case <-timer.C:
		http.Error(response, "CanMV relay upstream timed out", http.StatusGatewayTimeout)
	}
}

func relayRequestAllowed(request *http.Request) bool {
	switch request.URL.Path {
	case "/health":
		return request.Method == http.MethodGet
	case "/mcp":
		return request.Method == http.MethodPost
	default:
		return false
	}
}

func readRelayBody(body io.ReadCloser, contentLength int64) ([]byte, error) {
	defer body.Close()
	if contentLength > relayMaxBodyBytes {
		return nil, fmt.Errorf("request exceeds %d bytes", relayMaxBodyBytes)
	}
	data, err := io.ReadAll(io.LimitReader(body, relayMaxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > relayMaxBodyBytes {
		return nil, fmt.Errorf("request exceeds %d bytes", relayMaxBodyBytes)
	}
	return data, nil
}

func copyRelayHeaders(headers http.Header) map[string][]string {
	result := make(map[string][]string)
	for key, values := range headers {
		if relayHeaderAllowed(key) {
			result[key] = append([]string(nil), values...)
		}
	}
	return result
}

func relayHeaderAllowed(key string) bool {
	switch http.CanonicalHeaderKey(key) {
	case "Connection", "Content-Length", "Host", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade":
		return false
	default:
		return true
	}
}

func (relay *httpRelay) deliver(params map[string]interface{}) {
	requestID := uint64(intParam(params, "requestId", 0))
	if requestID == 0 {
		return
	}
	bodyBase64 := stringParam(params, "bodyBase64", "")
	body, err := base64.StdEncoding.DecodeString(bodyBase64)
	if err != nil || len(body) > relayMaxBodyBytes {
		body = []byte("Invalid response from CanMV relay upstream")
		params["statusCode"] = float64(http.StatusBadGateway)
	}
	upstream := httpRelayResponse{
		StatusCode: intParam(params, "statusCode", http.StatusBadGateway),
		Headers:    relayResponseHeaders(params["headers"]),
		Body:       body,
	}
	relay.mu.Lock()
	responseChannel := relay.pending[requestID]
	relay.mu.Unlock()
	if responseChannel != nil {
		select {
		case responseChannel <- upstream:
		default:
		}
	}
}

func relayResponseHeaders(value interface{}) map[string][]string {
	result := make(map[string][]string)
	values, ok := value.(map[string]interface{})
	if !ok {
		return result
	}
	for key, raw := range values {
		items, ok := raw.([]interface{})
		if !ok || !relayHeaderAllowed(key) {
			continue
		}
		for _, item := range items {
			if text, ok := item.(string); ok {
				result[key] = append(result[key], text)
			}
		}
	}
	return result
}

func (relay *httpRelay) removePending(requestID uint64) {
	relay.mu.Lock()
	delete(relay.pending, requestID)
	relay.mu.Unlock()
}

func (relay *httpRelay) failPending() {
	relay.mu.Lock()
	defer relay.mu.Unlock()
	for requestID, responseChannel := range relay.pending {
		response := httpRelayResponse{
			StatusCode: http.StatusBadGateway,
			Headers:    map[string][]string{"Content-Type": {"text/plain; charset=utf-8"}},
			Body:       []byte("CanMV relay upstream closed"),
		}
		select {
		case responseChannel <- response:
		default:
		}
		delete(relay.pending, requestID)
	}
}
