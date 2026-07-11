package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

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
