package usbdbg

import (
	"encoding/binary"
	"testing"
	"time"

	"go.bug.st/serial"
)

// mockPort implements serial.Port for tests. It feeds a fixed script of byte
// chunks to Read (one chunk per call, empty chunk = timeout) and records writes.
type mockPort struct {
	serial.Port // embedded: unused methods panic if called
	reads       [][]byte
	readIdx     int
	written     []byte
	timeouts    []time.Duration
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

func (m *mockPort) SetReadTimeout(timeout time.Duration) error {
	m.timeouts = append(m.timeouts, timeout)
	return nil
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

func TestScriptRunningUsesLifecycleCommand(t *testing.T) {
	response := make([]byte, 4)
	binary.LittleEndian.PutUint32(response, 1)
	port := &mockPort{reads: [][]byte{response}}
	board := &Board{port: port}

	running, err := board.ScriptRunning()
	if err != nil {
		t.Fatalf("ScriptRunning() error: %v", err)
	}
	if !running {
		t.Fatal("ScriptRunning() = false, want true")
	}

	if len(port.written) != 6 {
		t.Fatalf("ScriptRunning() command length = %d, want 6", len(port.written))
	}
	if port.written[0] != CmdPrefix {
		t.Fatalf("ScriptRunning() prefix = %x, want %x", port.written[0], CmdPrefix)
	}
	if got := port.written[1]; got != CmdScriptRunning {
		t.Fatalf("ScriptRunning() opcode = %x, want lifecycle command %x", got, CmdScriptRunning)
	}
}

func TestScriptStatusUsesBusyCommand(t *testing.T) {
	response := make([]byte, 4)
	binary.LittleEndian.PutUint32(response, 1)
	port := &mockPort{reads: [][]byte{response}}
	board := &Board{port: port}

	busy, err := board.ScriptStatus()
	if err != nil {
		t.Fatalf("ScriptStatus() error: %v", err)
	}
	if !busy {
		t.Fatal("ScriptStatus() = false, want true")
	}

	if len(port.written) != 6 {
		t.Fatalf("ScriptStatus() command length = %d, want 6", len(port.written))
	}
	if port.written[0] != CmdPrefix {
		t.Fatalf("ScriptStatus() prefix = %x, want %x", port.written[0], CmdPrefix)
	}
	if got := port.written[1]; got != CmdScriptStatus {
		t.Fatalf("ScriptStatus() opcode = %x, want busy command %x", got, CmdScriptStatus)
	}
}

func listDirEntryBytes(name string, directory bool, size, mtime uint32) []byte {
	entry := make([]byte, 10+len(name))
	if directory {
		entry[0] = 1
	}
	entry[1] = byte(len(name))
	binary.LittleEndian.PutUint32(entry[2:6], size)
	binary.LittleEndian.PutUint32(entry[6:10], mtime)
	copy(entry[10:], name)
	return entry
}

func listDirPageReads(nextOffset uint32, entries []byte, count uint32) [][]byte {
	payload := make([]byte, 4+len(entries))
	binary.LittleEndian.PutUint32(payload[:4], nextOffset)
	copy(payload[4:], entries)
	header := make([]byte, 12)
	binary.LittleEndian.PutUint32(header[4:8], uint32(len(payload)))
	binary.LittleEndian.PutUint32(header[8:12], count)
	return [][]byte{header, payload}
}

func listDirLegacyReads(entries []byte, count uint32) [][]byte {
	header := make([]byte, 12)
	binary.LittleEndian.PutUint32(header[4:8], uint32(len(entries)))
	binary.LittleEndian.PutUint32(header[8:12], count)
	return [][]byte{header, entries}
}

func writtenCommands(t *testing.T, data []byte) [][]byte {
	t.Helper()
	var commands [][]byte
	for len(data) > 0 {
		if len(data) < 6 {
			t.Fatalf("short command header: % x", data)
		}
		if data[0] != CmdPrefix {
			t.Fatalf("unexpected command prefix: %x", data[0])
		}
		length := int(binary.LittleEndian.Uint32(data[2:6]))
		if len(data) < 6+length {
			t.Fatalf("short command payload: have %d, need %d", len(data), 6+length)
		}
		commands = append(commands, data[:6+length])
		data = data[6+length:]
	}
	return commands
}

func TestListDirPageUsesBoundedRequests(t *testing.T) {
	firstEntries := append(
		listDirEntryBytes("alpha.py", false, 12, 1),
		listDirEntryBytes("models", true, 0, 2)...,
	)
	secondEntries := listDirEntryBytes("boot.py", false, 7, 3)
	reads := append(listDirPageReads(2, firstEntries, 2), listDirPageReads(listDirPageDone, secondEntries, 1)...)
	port := &mockPort{reads: reads}
	board := &Board{port: port}

	first, err := board.ListDirPage("/sdcard", 0)
	if err != nil {
		t.Fatalf("ListDirPage() error: %v", err)
	}
	if first.Done || first.NextOffset != 2 {
		t.Fatalf("first page continuation = %#v, want offset 2 and not done", first)
	}
	if len(first.Entries) != 2 || first.Entries[0].Name != "alpha.py" || first.Entries[0].Type != "file" || first.Entries[0].Size != 12 {
		t.Fatalf("first page entries = %#v", first.Entries)
	}
	if first.Entries[1].Name != "models" || first.Entries[1].Type != "directory" {
		t.Fatalf("second entry = %#v", first.Entries[1])
	}
	second, err := board.ListDirPage("/sdcard", first.NextOffset)
	if err != nil {
		t.Fatalf("ListDirPage() second page error: %v", err)
	}
	if !second.Done || len(second.Entries) != 1 || second.Entries[0].Name != "boot.py" || second.Entries[0].MTime != 3 {
		t.Fatalf("second page = %#v", second)
	}

	commands := writtenCommands(t, port.written)
	if len(commands) != 2 {
		t.Fatalf("ListDirPage() sent %d commands, want 2", len(commands))
	}
	for i, command := range commands {
		if command[1] != CmdListDir {
			t.Fatalf("command %d opcode = %x, want %x", i, command[1], CmdListDir)
		}
	}
	if got := string(commands[0][6:]); got != listDirPageRequestPrefix+"0/8192//sdcard\x00" {
		t.Fatalf("first page request = %q", got)
	}
	if got := string(commands[1][6:]); got != listDirPageRequestPrefix+"2/8192//sdcard\x00" {
		t.Fatalf("second page request = %q", got)
	}
	if len(port.timeouts) != 4 || port.timeouts[0] != listDirReadTimeout || port.timeouts[1] != time.Second || port.timeouts[2] != listDirReadTimeout || port.timeouts[3] != time.Second {
		t.Fatalf("ListDirPage() timeouts = %#v", port.timeouts)
	}
}

func TestListDirUsesLegacyProtocol(t *testing.T) {
	legacyEntries := listDirEntryBytes("main.py", false, 42, 5)
	reads := listDirLegacyReads(legacyEntries, 1)
	port := &mockPort{reads: reads}
	board := &Board{port: port}

	entries, err := board.ListDir("/sdcard")
	if err != nil {
		t.Fatalf("ListDir() error: %v", err)
	}
	if len(entries) != 1 || entries[0].Name != "main.py" {
		t.Fatalf("ListDir() = %#v", entries)
	}

	commands := writtenCommands(t, port.written)
	if len(commands) != 1 {
		t.Fatalf("ListDir() sent %d commands, want 1", len(commands))
	}
	if got := string(commands[0][6:]); got != "/sdcard\x00" {
		t.Fatalf("legacy request = %q", got)
	}
}

func TestListDirPageRejectsLegacyFirmware(t *testing.T) {
	legacyReply := make([]byte, 12)
	binary.LittleEndian.PutUint32(legacyReply[:4], 1024+9)
	port := &mockPort{reads: [][]byte{legacyReply}}
	board := &Board{port: port}

	if _, err := board.ListDirPage("/sdcard", 0); err == nil {
		t.Fatal("ListDirPage() succeeded against a legacy response")
	}

	commands := writtenCommands(t, port.written)
	if len(commands) != 1 {
		t.Fatalf("ListDirPage() sent %d commands, want 1", len(commands))
	}
	if got := string(commands[0][6:]); got != listDirPageRequestPrefix+"0/8192//sdcard\x00" {
		t.Fatalf("page request = %q", got)
	}
}

func TestListDirLegacyOversizeIsDrained(t *testing.T) {
	payloadLen := uint32(maxLegacyDirPayload + 1)
	header := make([]byte, 12)
	binary.LittleEndian.PutUint32(header[4:8], payloadLen)
	payload := make([]byte, payloadLen)
	reads := [][]byte{header}
	for len(payload) > 0 {
		chunkLen := 32 * 1024
		if len(payload) < chunkLen {
			chunkLen = len(payload)
		}
		reads = append(reads, payload[:chunkLen])
		payload = payload[chunkLen:]
	}
	port := &mockPort{reads: reads}
	board := &Board{port: port}

	if _, err := board.ListDir("/sdcard"); err == nil {
		t.Fatal("ListDir() accepted an oversized legacy payload")
	}
	if port.readIdx != len(reads) {
		t.Fatalf("ListDir() left %d response chunks unread", len(reads)-port.readIdx)
	}
}

func TestCapabilitiesAcceptsPagedListCapability(t *testing.T) {
	response := make([]byte, 8)
	binary.LittleEndian.PutUint32(response[0:4], capProtocolVersion)
	binary.LittleEndian.PutUint32(response[4:8], CapListDir|CapListDirPaged|(1<<31))
	board := &Board{port: &mockPort{reads: [][]byte{response}}}

	version, flags, err := board.Capabilities()
	if err != nil {
		t.Fatalf("Capabilities() error: %v", err)
	}
	if version != capProtocolVersion || flags&CapListDirPaged == 0 {
		t.Fatalf("Capabilities() = version %d flags %#x, want paged list capability", version, flags)
	}
	if flags&(1<<31) != 0 {
		t.Fatalf("Capabilities() retained an unknown flag: %#x", flags)
	}
}
