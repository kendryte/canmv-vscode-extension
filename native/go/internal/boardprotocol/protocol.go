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
	ScriptRunning(board *usbdbg.Board, fallback bool) (bool, error)
	DrainTxBuf(board *usbdbg.Board) ([]byte, error)
	TerminalInput(board *usbdbg.Board, text string) error
	FileExec(board *usbdbg.Board, path string) error
	VirtualTouchStatus(board *usbdbg.Board) (usbdbg.VirtualTouchStatus, error)
	VirtualTouchEvent(board *usbdbg.Board, event usbdbg.VirtualTouchEvent) error
	ListDir(board *usbdbg.Board, path string) ([]usbdbg.FileEntry, error)
	QueryFileStat(board *usbdbg.Board, path string) (usbdbg.FileStat, error)
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

	// Legacy firmware only enters USBDBG mode for a small token set. Probe with
	// FW_VERSION first so newer commands are not routed into normal REPL input.
	if fw, err := board.FWVersion(); err == nil {
		profile.fwVersion = fw
		profile.fwVersionFull = fw
	}

	version, flags, err := board.Capabilities()
	if err != nil {
		firstErr := err
		_, _ = board.DrainInput(120*time.Millisecond, 8)
		version, flags, err = board.Capabilities()
		if err != nil {
			_, _ = board.DrainInput(30*time.Millisecond, 4)
			_, _ = fmt.Fprintf(os.Stderr, "[canmv-backend] capabilities negotiation failed first=%v retry=%v\n", firstErr, err)
			profile.flags = CapTxBuf
			return newLegacy(profile)
		}
	}

	profile.kind = KindV2
	profile.version = version
	profile.flags = flags | CapTxBuf
	if fwFull, err := board.FWVersionFull(); err == nil && fwFull != "" {
		profile.fwVersionFull = fwFull
	} else if profile.fwVersionFull == "" {
		profile.fwVersionFull = profile.fwVersion
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
