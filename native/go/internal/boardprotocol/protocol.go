package boardprotocol

import (
	"fmt"
	"os"
	"time"

	"canmv-backend/internal/usbdbg"
)

type Handler interface {
	Profile() Profile
	HasCapabilitiesProtocol() bool
	HasCapability(flag uint32) bool
	DisableCapability(flag uint32)
	CheckRunningBeforePreview() bool

	EnableFramebuffer(board *usbdbg.Board) error
	DisableFramebuffer(board *usbdbg.Board)
	SoftReset(board *usbdbg.Board) error
	ScriptStop(board *usbdbg.Board) error
	// ScriptRunning reports the lifecycle of an IDE-launched script. It must
	// become false when that script exits so the host can update its UI.
	ScriptRunning(board *usbdbg.Board, fallback bool) (bool, error)
	// ScriptBusy additionally includes a pending soft reset or a REPL command.
	// Use it for generic device-busy checks; ScriptRunning is lifecycle-only.
	ScriptBusy(board *usbdbg.Board, fallback bool) (bool, error)
	DrainTxBuf(board *usbdbg.Board) ([]byte, error)
	TerminalInput(board *usbdbg.Board, text string) error
	FileExec(board *usbdbg.Board, path string) error
	VirtualTouchStatus(board *usbdbg.Board) (usbdbg.VirtualTouchStatus, error)
	VirtualTouchEvent(board *usbdbg.Board, event usbdbg.VirtualTouchEvent) error
	ListDir(board *usbdbg.Board, path string) ([]usbdbg.FileEntry, error)
	ListDirPage(board *usbdbg.Board, path string, offset uint32) (usbdbg.DirPage, error)
	QueryFileStat(board *usbdbg.Board, path string) (usbdbg.FileStat, error)
	ReadFileChunk(board *usbdbg.Board, path string, offset uint32, size uint32) ([]byte, error)
	ReadFileAll(board *usbdbg.Board, path string, chunkSize uint32) ([]byte, error)
	WriteFile(board *usbdbg.Board, path string, data []byte, chunkSize uint32) uint32
	SimpleFileOp(board *usbdbg.Board, opcode byte, payload []byte) uint32
}

type protocolBase struct {
	profile Profile
}

func Negotiate(board *usbdbg.Board) Handler {
	profile := Profile{kind: KindLegacy}
	if board == nil {
		return newLegacy(profile)
	}
	started := time.Now()

	// Resynchronize the stream first. On a reconnect while a script is still
	// streaming, leftover/in-flight bytes (a frame-dump tail, queued REPL output)
	// can sit on the line; without a resync the fixed-length reads below would
	// consume those bytes as the FW_VERSION/Capabilities reply and falsely
	// negotiate down to legacy (reporting file/REPL features as unsupported).
	if err := board.Sync(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "[canmv-backend] handshake sync failed: %v\n", err)
	} else {
		_, _ = fmt.Fprintln(os.Stderr, "[canmv-backend] handshake sync succeeded")
	}

	// Legacy firmware only enters USBDBG mode for a small token set. Probe with
	// FW_VERSION first so newer commands are not routed into normal REPL input.
	if fw, err := board.FWVersion(); err == nil {
		profile.fwVersion = fw
		profile.fwVersionFull = fw
		_, _ = fmt.Fprintf(os.Stderr, "[canmv-backend] handshake firmware probe succeeded: %s\n", fw)
	} else {
		_, _ = fmt.Fprintf(os.Stderr, "[canmv-backend] handshake firmware probe failed: %v\n", err)
	}

	version, flags, err := board.Capabilities()
	if err != nil {
		firstErr := err
		// Re-align the stream and retry once. A clean resync means a genuine
		// failure here reflects real (legacy) firmware, not a transient desync.
		if syncErr := board.Sync(); syncErr != nil {
			drained, drainErr := board.DrainInput(120*time.Millisecond, 8)
			_, _ = fmt.Fprintf(os.Stderr, "[canmv-backend] capabilities retry sync failed: %v; drained=%d bytes drain_error=%v\n", syncErr, len(drained), drainErr)
		} else {
			_, _ = fmt.Fprintln(os.Stderr, "[canmv-backend] capabilities retry sync succeeded")
		}
		version, flags, err = board.Capabilities()
		if err != nil {
			drained, drainErr := board.DrainInput(30*time.Millisecond, 4)
			_, _ = fmt.Fprintf(os.Stderr, "[canmv-backend] capabilities negotiation failed first=%v retry=%v drained=%d bytes drain_error=%v elapsed=%s; using legacy protocol\n", firstErr, err, len(drained), drainErr, time.Since(started).Round(time.Millisecond))
			profile.flags = CapTxBuf
			return newLegacy(profile)
		}
	}

	profile.kind = KindV2
	profile.version = version
	profile.flags = flags | CapTxBuf
	if fwFull, fullErr := board.FWVersionFull(); fullErr == nil && fwFull != "" {
		profile.fwVersionFull = fwFull
		_, _ = fmt.Fprintf(os.Stderr, "[canmv-backend] capabilities negotiation succeeded: version=%d flags=0x%08X firmware=%s elapsed=%s\n", version, flags, fwFull, time.Since(started).Round(time.Millisecond))
	} else if profile.fwVersionFull == "" {
		profile.fwVersionFull = profile.fwVersion
		_, _ = fmt.Fprintf(os.Stderr, "[canmv-backend] capabilities negotiation succeeded: version=%d flags=0x%08X full firmware probe unavailable=%v elapsed=%s\n", version, flags, fullErr, time.Since(started).Round(time.Millisecond))
	} else {
		_, _ = fmt.Fprintf(os.Stderr, "[canmv-backend] capabilities negotiation succeeded: version=%d flags=0x%08X full firmware probe unavailable=%v elapsed=%s\n", version, flags, fullErr, time.Since(started).Round(time.Millisecond))
	}
	return newV2(profile)
}

func Default() Handler {
	return newLegacy(Profile{kind: KindLegacy})
}

func (p *protocolBase) Profile() Profile {
	if p == nil {
		return Profile{}
	}
	return p.profile
}

func (p *protocolBase) HasCapabilitiesProtocol() bool {
	return p != nil && p.profile.kind != KindLegacy && p.profile.version > 0
}

func (p *protocolBase) HasCapability(flag uint32) bool {
	if p == nil || flag == 0 {
		return false
	}
	return p.profile.flags&flag != 0
}

func (p *protocolBase) DisableCapability(flag uint32) {
	if p != nil {
		p.profile.flags &^= flag
	}
}

func unsupportedError(feature string) error {
	return fmt.Errorf("%s is not supported by this firmware", feature)
}
