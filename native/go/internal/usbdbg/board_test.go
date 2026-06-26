package usbdbg

import (
	"encoding/binary"
	"testing"

	"go.bug.st/serial"
)

// mockPort implements serial.Port for tests. It feeds a fixed script of byte
// chunks to Read (one chunk per call, empty chunk = timeout) and records writes.
type mockPort struct {
	serial.Port // embedded: unused methods panic if called
	reads       [][]byte
	readIdx     int
	written     []byte
}

func (m *mockPort) Read(p []byte) (int, error) {
	if m.readIdx >= len(m.reads) {
		return 0, nil // simulate a read timeout (no data)
	}
	chunk := m.reads[m.readIdx]
	m.readIdx++
	n := copy(p, chunk)
	return n, nil
}

func (m *mockPort) Write(p []byte) (int, error) {
	m.written = append(m.written, p...)
	return len(p), nil
}

func markerBytes() []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, queryStatusMagic)
	return b
}

func TestSyncLocksOntoMarker(t *testing.T) {
	cases := map[string][][]byte{
		"marker only":         {markerBytes()},
		"garbage then marker": {[]byte{0x01, 0x02, 0x03}, markerBytes()},
		"marker straddles read": {
			{0xAA, 0xBB}, // first two marker bytes (0xFFEEBBAA little-endian = AA BB EE FF)
			{0xEE, 0xFF}, // remaining two
		},
		"partial-marker garbage before real marker": {
			append([]byte{0xAA, 0xBB, 0xEE, 0x00}, markerBytes()...),
		},
	}
	for name, reads := range cases {
		t.Run(name, func(t *testing.T) {
			b := &Board{port: &mockPort{reads: reads}}
			if err := b.Sync(); err != nil {
				t.Fatalf("Sync() returned error: %v", err)
			}
		})
	}
}

func TestSyncSendsQueryStatus(t *testing.T) {
	mp := &mockPort{reads: [][]byte{markerBytes()}}
	b := &Board{port: mp}
	if err := b.Sync(); err != nil {
		t.Fatalf("Sync() error: %v", err)
	}
	if len(mp.written) < 2 || mp.written[0] != CmdPrefix || mp.written[1] != CmdQueryStatus {
		t.Fatalf("Sync did not send QUERY_STATUS header, got % x", mp.written)
	}
}

func TestSyncTimesOutWithoutMarker(t *testing.T) {
	// No marker, then a timeout (empty read) -> error, no hang.
	b := &Board{port: &mockPort{reads: [][]byte{{0x10, 0x20, 0x30}}}}
	if err := b.Sync(); err == nil {
		t.Fatal("expected error when marker never arrives, got nil")
	}
}
