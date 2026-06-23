package boardprotocol

import "canmv-backend/internal/usbdbg"

type legacyProtocol struct {
	protocolBase
}

func newLegacy(profile Profile) *legacyProtocol {
	return &legacyProtocol{protocolBase{profile: profile}}
}

func (p *legacyProtocol) CheckRunningBeforePreview() bool {
	return false
}

func (p *legacyProtocol) EnableFramebuffer(board *usbdbg.Board) error {
	return board.FBEnableLegacy()
}

func (p *legacyProtocol) DisableFramebuffer(board *usbdbg.Board) {
	_ = board.FBDisableLegacy()
}

func (p *legacyProtocol) SoftReset(board *usbdbg.Board) error {
	err := board.SysReset()
	if _, attachErr := board.FWVersion(); err == nil {
		return attachErr
	}
	return err
}

func (p *legacyProtocol) ScriptStop(board *usbdbg.Board) error {
	return board.ScriptStop()
}

func (p *legacyProtocol) ScriptRunning(board *usbdbg.Board, fallback bool) (bool, error) {
	running, err := board.ScriptRunning()
	if err != nil {
		return fallback, nil
	}
	return running, nil
}

func (p *legacyProtocol) DrainTxBuf(board *usbdbg.Board) ([]byte, error) {
	return board.DrainTxBufLegacy()
}

func (p *legacyProtocol) TerminalInput(board *usbdbg.Board, text string) error {
	return unsupportedError("REPL input")
}

func (p *legacyProtocol) FileExec(board *usbdbg.Board, path string) error {
	return unsupportedError("file execution")
}

func (p *legacyProtocol) VirtualTouchStatus(board *usbdbg.Board) (usbdbg.VirtualTouchStatus, error) {
	return usbdbg.VirtualTouchStatus{}, unsupportedError("virtual touch")
}

func (p *legacyProtocol) VirtualTouchEvent(board *usbdbg.Board, event usbdbg.VirtualTouchEvent) error {
	return unsupportedError("virtual touch")
}

func (p *legacyProtocol) ListDir(board *usbdbg.Board, path string) ([]usbdbg.FileEntry, error) {
	return nil, unsupportedError("file explorer")
}

func (p *legacyProtocol) QueryFileStat(board *usbdbg.Board, path string) (usbdbg.FileStat, error) {
	return usbdbg.FileStat{}, unsupportedError("file stat")
}

func (p *legacyProtocol) ReadFileAll(board *usbdbg.Board, path string, chunkSize uint32) ([]byte, error) {
	return nil, unsupportedError("file read")
}

func (p *legacyProtocol) WriteFile(board *usbdbg.Board, path string, data []byte, chunkSize uint32) uint32 {
	return UnsupportedFileOpErrCode
}

func (p *legacyProtocol) SimpleFileOp(board *usbdbg.Board, opcode byte, payload []byte) uint32 {
	return UnsupportedFileOpErrCode
}
