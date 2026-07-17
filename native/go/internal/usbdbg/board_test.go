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

func TestReadFileSendsRequestedRange(t *testing.T) {
	path := "/sdcard/model.kmodel"
	data := []byte("data")
	response := make([]byte, 12+len(data))
	binary.LittleEndian.PutUint32(response[4:8], uint32(len(data)))
	copy(response[12:], data)
	port := &mockPort{reads: [][]byte{response[:12], response[12:]}}
	b := &Board{port: port}

	got, err := b.ReadFile(path, 7, uint32(len(data)))
	if err != nil {
		t.Fatalf("ReadFile() returned error: %v", err)
	}
	if string(got) != string(data) {
		t.Fatalf("ReadFile() = %q, want %q", got, data)
	}
	if len(port.written) < 14 {
		t.Fatalf("ReadFile() wrote only %d bytes", len(port.written))
	}
	if port.written[0] != CmdPrefix || port.written[1] != CmdReadFile {
		t.Fatalf("ReadFile() command = %x %x, want %x %x", port.written[0], port.written[1], CmdPrefix, CmdReadFile)
	}
	if got := binary.LittleEndian.Uint32(port.written[6:10]); got != 7 {
		t.Fatalf("ReadFile() offset = %d, want 7", got)
	}
	if got := binary.LittleEndian.Uint32(port.written[10:14]); got != uint32(len(data)) {
		t.Fatalf("ReadFile() size = %d, want %d", got, len(data))
	}
}
