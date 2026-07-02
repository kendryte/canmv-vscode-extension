package main

import "testing"

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
