package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"canmv-backend/internal/usbdbg"
)

func TestParseHTTPRelayPort(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		want    int
		wantErr bool
	}{
		{name: "dynamic default", want: 0},
		{name: "dynamic explicit", args: []string{"0"}, want: 0},
		{name: "saved port", args: []string{"38319"}, want: 38319},
		{name: "negative", args: []string{"-1"}, wantErr: true},
		{name: "too large", args: []string{"65536"}, wantErr: true},
		{name: "not a number", args: []string{"auto"}, wantErr: true},
		{name: "too many", args: []string{"38319", "38320"}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseHTTPRelayPort(tt.args)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseHTTPRelayPort(%q) error = %v, wantErr %t", tt.args, err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("parseHTTPRelayPort(%q) = %d, want %d", tt.args, got, tt.want)
			}
		})
	}
}

func TestFirmwareVersionForUser(t *testing.T) {
	fullHash := "b31788cb14e5f67a53ff14c3d3433424de568116"
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "release tag with count and full hash",
			in:   "k230_canmv_01studio-v1.7-12-g" + fullHash,
			want: "v1.7-12",
		},
		{
			name: "release candidate tag with count and full hash",
			in:   "k230_canmv_01studio-v1.7-rc1-12-g" + fullHash,
			want: "v1.7-rc1-12",
		},
		{
			name: "release candidate tag with dotted prerelease",
			in:   "k230_canmv_01studio-v1.7.0-rc.1-12-g" + fullHash,
			want: "v1.7.0-rc.1-12",
		},
		{
			name: "release candidate tag without count",
			in:   "k230_canmv_01studio-v1.7-rc1-g" + fullHash,
			want: "v1.7-rc1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := firmwareVersionForUser(tt.in); got != tt.want {
				t.Fatalf("firmwareVersionForUser(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestFirmwareCommitFromFullRequiresFullHash(t *testing.T) {
	fullHash := "b31788cb14e5f67a53ff14c3d3433424de568116"
	if got := firmwareCommitFromFull("k230_canmv_01studio-v1.7-rc1-12-g" + fullHash); got != fullHash {
		t.Fatalf("firmwareCommitFromFull full hash = %q, want %q", got, fullHash)
	}
	if got := firmwareCommitFromFull("k230_canmv_01studio-v1.7-rc1-12-gb31788c"); got != "" {
		t.Fatalf("firmwareCommitFromFull short hash = %q, want empty", got)
	}
}

func TestScriptOutputChunkEndPreservesUTF8Boundary(t *testing.T) {
	text := "abc你好def"
	if got := scriptOutputChunkEnd(text, len("abc你")+1); got != len("abc你") {
		t.Fatalf("scriptOutputChunkEnd split multibyte rune at %d, want %d", got, len("abc你"))
	}
	if got := scriptOutputChunkEnd(text, len("abc你")); got != len("abc你") {
		t.Fatalf("scriptOutputChunkEnd exact boundary = %d, want %d", got, len("abc你"))
	}
}

func TestFileTransferChunkSizes(t *testing.T) {
	const legacyCDCRXFIFOSize = 16 * 1024
	if fileWriteChunkSize != 8*1024 {
		t.Fatalf("fileWriteChunkSize = %d, want 8 KiB", fileWriteChunkSize)
	}
	if fileReadChunkSize != 32*1024 {
		t.Fatalf("fileReadChunkSize = %d, want 32 KiB", fileReadChunkSize)
	}
	if fileWriteChunkSize >= legacyCDCRXFIFOSize {
		t.Fatalf("upload chunk %d must remain below legacy CDC RX FIFO %d", fileWriteChunkSize, legacyCDCRXFIFOSize)
	}
}

func TestFilesystemRequestsRejectDuringStreamedWrite(t *testing.T) {
	s := &server{fileWrite: &fileWriteSession{}}
	operations := []struct {
		name string
		call func() (interface{}, int, string)
	}{
		{"list", func() (interface{}, int, string) { return s.listDir(nil) }},
		{"stat", func() (interface{}, int, string) { return s.queryFileStat(nil) }},
		{"read", func() (interface{}, int, string) { return s.readFile(nil) }},
		{"legacy write", func() (interface{}, int, string) { return s.writeFile(nil) }},
		{"delete", func() (interface{}, int, string) { return s.simpleFileOp(nil, usbdbg.CmdDeleteFile, "path") }},
		{"rmdir", func() (interface{}, int, string) { return s.rmdir(nil) }},
		{"rename", func() (interface{}, int, string) { return s.renameFile(nil) }},
	}

	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			_, code, message := operation.call()
			if code != 4003 || message != "file transfer in progress" {
				t.Fatalf("filesystem conflict = (%d, %q), want (4003, %q)", code, message, "file transfer in progress")
			}
		})
	}
}

func TestHandshakeResponded(t *testing.T) {
	tests := []struct {
		name     string
		protocol uint32
		firmware string
		arch     string
		want     bool
	}{
		{name: "silent endpoint", want: false},
		{name: "capability protocol", protocol: 2, want: true},
		{name: "legacy firmware", firmware: "4.0.0", want: true},
		{name: "architecture response", arch: "K230", want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := handshakeResponded(test.protocol, test.firmware, test.arch); got != test.want {
				t.Fatalf("handshakeResponded(%d, %q, %q) = %t, want %t", test.protocol, test.firmware, test.arch, got, test.want)
			}
		})
	}
}

func TestWorkerWaitsForStreamedWrite(t *testing.T) {
	board := &usbdbg.Board{}
	s := &server{
		board:         board,
		fileWrite:     &fileWriteSession{board: board},
		fileWriteDone: make(chan struct{}),
	}
	ran := make(chan struct{})
	completed := make(chan bool, 1)
	stop := make(chan struct{})
	go func() {
		completed <- s.withWorkerBoardOperation(stop, board, 0, func() { close(ran) })
	}()

	select {
	case <-ran:
		t.Fatal("worker ran while file write was active")
	case <-time.After(25 * time.Millisecond):
	}

	s.opMu.Lock()
	s.clearFileWriteLocked()
	s.opMu.Unlock()

	select {
	case <-ran:
	case <-time.After(time.Second):
		t.Fatal("worker did not resume after file write finished")
	}
	if !<-completed {
		t.Fatal("worker operation did not complete")
	}
}

func TestExtractZipArchiveWritesNestedFiles(t *testing.T) {
	tempDir := t.TempDir()
	archivePath := filepath.Join(tempDir, "stubs.zip")
	targetDir := filepath.Join(tempDir, "out")

	writerFile, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	zipWriter := zip.NewWriter(writerFile)
	if _, err := zipWriter.Create("empty-package/"); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"media/sensor.pyi":       "class Sensor: ...\n",
		"mpp/vicap.pyi":          "VICAP_DEV_ID_0 = 0\n",
		"asyncio/core.pyi":       "def run() -> None: ...\n",
		"top_level_module.pyi":   "VALUE = 1\n",
		"libs/__init__.py":       "",
		"libs/nested/helper.pyc": "\x00\x01",
	}
	for name, content := range files {
		entry, err := zipWriter.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writerFile.Close(); err != nil {
		t.Fatal(err)
	}

	if err := extractArchive(archivePath, targetDir); err != nil {
		t.Fatal(err)
	}
	for name, want := range files {
		got, err := os.ReadFile(filepath.Join(targetDir, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("missing extracted file %s: %v", name, err)
		}
		if string(got) != want {
			t.Fatalf("extracted %s = %q, want %q", name, string(got), want)
		}
	}
	emptyDir := filepath.Join(targetDir, "empty-package")
	entries, err := os.ReadDir(emptyDir)
	if err != nil {
		t.Fatalf("missing extracted empty directory: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("extracted empty directory contains %d entries", len(entries))
	}
}
