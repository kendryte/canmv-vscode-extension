package boardprotocol

import "canmv-backend/internal/usbdbg"

type protocolV2 struct {
	protocolBase
}

func newV2(profile Profile) *protocolV2 {
	return &protocolV2{protocolBase{profile: profile}}
}

func (p *protocolV2) CheckRunningBeforePreview() bool {
	return true
}

func (p *protocolV2) EnableFramebuffer(board *usbdbg.Board) error {
	return board.FBEnable2()
}

func (p *protocolV2) DisableFramebuffer(board *usbdbg.Board) {
	_ = board.FBDisable2()
}

func (p *protocolV2) SoftReset(board *usbdbg.Board) error {
	return board.SoftReset()
}

func (p *protocolV2) ScriptStop(board *usbdbg.Board) error {
	return board.ScriptStop()
}

func (p *protocolV2) ScriptRunning(board *usbdbg.Board, fallback bool) (bool, error) {
	return board.ScriptStatus()
}

func (p *protocolV2) DrainTxBuf(board *usbdbg.Board) ([]byte, error) {
	return board.DrainTxBuf()
}

func (p *protocolV2) TerminalInput(board *usbdbg.Board, text string) error {
	return board.TxInput([]byte(text))
}

func (p *protocolV2) FileExec(board *usbdbg.Board, path string) error {
	return board.FileExec(path)
}

func (p *protocolV2) VirtualTouchStatus(board *usbdbg.Board) (usbdbg.VirtualTouchStatus, error) {
	return board.VirtualTouchStatus()
}

func (p *protocolV2) VirtualTouchEvent(board *usbdbg.Board, event usbdbg.VirtualTouchEvent) error {
	return board.VirtualTouchEvent(event)
}

func (p *protocolV2) ListDir(board *usbdbg.Board, path string) ([]usbdbg.FileEntry, error) {
	return board.ListDir(path)
}

func (p *protocolV2) QueryFileStat(board *usbdbg.Board, path string) (usbdbg.FileStat, error) {
	return board.QueryFileStat(path)
}

func (p *protocolV2) ReadFileAll(board *usbdbg.Board, path string, chunkSize uint32) ([]byte, error) {
	return board.ReadFileAll(path, chunkSize)
}

func (p *protocolV2) WriteFile(board *usbdbg.Board, path string, data []byte, chunkSize uint32) uint32 {
	return board.WriteFile(path, data, chunkSize)
}

func (p *protocolV2) SimpleFileOp(board *usbdbg.Board, opcode byte, payload []byte) uint32 {
	return board.SimpleFileOp(opcode, payload)
}
