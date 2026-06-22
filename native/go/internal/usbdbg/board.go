package usbdbg

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

const (
	CmdPrefix = 0x30
	CtrlD     = 0x04

	CmdScriptExec    = 0x05
	CmdScriptStop    = 0x06
	CmdTxInput       = 0x11
	CmdFBEnable      = 0x0D
	CmdFWVersion     = 0x80
	CmdFWVersionFull = 0x91
	CmdFrameSize     = 0x81
	CmdFrameDump     = 0x82
	CmdArchStr       = 0x83
	CmdQueryFileStat = 0xA0
	CmdVerifyFile    = 0xA1
	CmdListDir       = 0xA2
	CmdReadFile      = 0xA3
	CmdDeleteFile    = 0xA4
	CmdRenameFile    = 0xA5
	CmdMkdir         = 0xA6
	CmdRmdir         = 0xA7
	CmdScriptRunning = 0x87
	CmdTxBufLen      = 0x8E
	CmdTxBuf         = 0x8F
	CmdCapabilities  = 0xAF
	CmdFileExec      = 0xA8
	CmdVTouchEvent   = 0x31
	CmdVTouchStatus  = 0xB0

	CapListDir      = 1 << 0
	CapReadFile     = 1 << 1
	CapWriteFile    = 1 << 2
	CapDeleteFile   = 1 << 3
	CapRenameFile   = 1 << 4
	CapMkdir        = 1 << 5
	CapRmdir        = 1 << 6
	CapFileExec     = 1 << 7
	CapVirtualTouch = 1 << 8

	maxDirPayload   = 8 * 1024 * 1024
	maxFileChunk    = 128 * 1024
	maxFramePayload = 50 * 1024 * 1024
	maxTxBufPayload = 128 * 1024
)

var responseLen = map[byte]uint32{
	CmdFWVersion:     12,
	CmdFWVersionFull: 128,
	CmdFrameSize:     12,
	CmdArchStr:       64,
	CmdScriptRunning: 4,
	CmdTxBufLen:      4,
	CmdCapabilities:  8,
	CmdVTouchStatus:  20,
}

type FileEntry struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Size  uint32 `json:"size"`
	MTime uint32 `json:"mtime,omitempty"`
}

type FileStat struct {
	Exists bool   `json:"exists"`
	Type   string `json:"type,omitempty"`
	Size   uint32 `json:"size"`
	MTime  uint32 `json:"mtime,omitempty"`
	Error  uint32 `json:"error,omitempty"`
}

type DetectedBoard struct {
	Port         string `json:"port"`
	Name         string `json:"name"`
	VID          string `json:"vid"`
	PID          string `json:"pid"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Description  string `json:"description,omitempty"`
}

type VirtualTouchStatus struct {
	Supported  bool   `json:"supported"`
	Enabled    bool   `json:"enabled"`
	RangeX     uint32 `json:"-"`
	RangeY     uint32 `json:"-"`
	QueueDepth uint32 `json:"queueDepth,omitempty"`
}

type VirtualTouchEvent struct {
	X           uint16
	Y           uint16
	Event       uint8
	TrackID     uint8
	Width       uint16
	TimestampMS uint32
}

type Board struct {
	port serial.Port
	mu   sync.Mutex
}

func Open(portName string, baudRate int) (*Board, error) {
	mode := &serial.Mode{BaudRate: baudRate}
	port, err := serial.Open(portName, mode)
	if err != nil {
		return nil, err
	}
	_ = port.SetDTR(true)
	board := &Board{port: port}
	_, _ = board.DrainInput(200*time.Millisecond, 20)
	_ = port.SetReadTimeout(1 * time.Second)
	return board, nil
}

func (b *Board) Close() error {
	if b == nil || b.port == nil {
		return nil
	}
	return b.port.Close()
}

func (b *Board) DrainInput(timeout time.Duration, maxReads int) ([]byte, error) {
	if b == nil || b.port == nil {
		return nil, nil
	}
	if maxReads <= 0 {
		maxReads = 1
	}
	b.mu.Lock()
	defer b.mu.Unlock()

	_ = b.port.SetReadTimeout(timeout)
	defer b.port.SetReadTimeout(1 * time.Second)

	var out []byte
	buf := make([]byte, 65536)
	for i := 0; i < maxReads; i++ {
		n, err := b.port.Read(buf)
		if err != nil {
			return out, err
		}
		if n == 0 {
			break
		}
		out = append(out, buf[:n]...)
	}
	return out, nil
}

func (b *Board) FWVersionFull() (string, error) {
	data, err := b.SendCommand(CmdFWVersionFull, nil)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.TrimRight(string(data), "\x00")), nil
}

func (b *Board) ArchStr() (string, error) {
	data, err := b.SendCommand(CmdArchStr, nil)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.TrimRight(string(data), "\x00")), nil
}

func (b *Board) ScriptRunning() (bool, error) {
	data, err := b.SendCommand(CmdScriptRunning, nil)
	if err != nil {
		return false, err
	}
	if len(data) < 4 {
		return false, nil
	}
	return binary.LittleEndian.Uint32(data[:4]) != 0, nil
}

func (b *Board) ScriptExec(script []byte) error {
	data := append(append([]byte{}, script...), '\n')
	if len(data)%64 == 0 {
		data = append(data, '\n')
	}

	header := make([]byte, 6)
	header[0] = CmdPrefix
	header[1] = CmdScriptExec
	binary.LittleEndian.PutUint32(header[2:], uint32(len(data)))

	b.mu.Lock()
	defer b.mu.Unlock()
	if _, err := b.port.Write(header); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	if _, err := b.port.Write(data); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	return nil
}

func (b *Board) ScriptStop() error {
	if err := b.FireCommand(CmdScriptStop, 0, nil); err != nil {
		return err
	}
	time.Sleep(100 * time.Millisecond)
	return nil
}

func (b *Board) TxInput(data []byte) error {
	return b.FireCommand(CmdTxInput, uint32(len(data)), data)
}

func (b *Board) SoftReset() error {
	return b.TxInput([]byte{CtrlD})
}

func (b *Board) FileExec(path string) error {
	payload := append([]byte(path), 0)
	return b.FireCommand(CmdFileExec, 0, payload)
}

func (b *Board) FBEnable2() error {
	return b.FireCommand(CmdFBEnable, 2, []byte{0x01, 0x00})
}

func (b *Board) FBEnableLegacy() error {
	return b.FireCommand(CmdFBEnable, 0, []byte{0x01, 0x00})
}

func (b *Board) FBDisable2() error {
	return b.FireCommand(CmdFBEnable, 2, []byte{0x00, 0x00})
}

func (b *Board) FBDisableLegacy() error {
	return b.FireCommand(CmdFBEnable, 0, []byte{0x00, 0x00})
}

func (b *Board) FrameSize() (uint32, uint32, uint32, error) {
	data, err := b.SendCommand(CmdFrameSize, nil)
	if err != nil {
		return 0, 0, 0, err
	}
	if len(data) < 12 {
		return 0, 0, 0, nil
	}
	return binary.LittleEndian.Uint32(data[0:4]), binary.LittleEndian.Uint32(data[4:8]), binary.LittleEndian.Uint32(data[8:12]), nil
}

func (b *Board) FrameDump(jpegSize uint32) ([]byte, error) {
	if jpegSize <= 100 {
		_, _, size, err := b.FrameSize()
		if err != nil || size <= 100 {
			return nil, err
		}
		jpegSize = size
	}
	if jpegSize > maxFramePayload {
		return nil, fmt.Errorf("frame payload too large: %d", jpegSize)
	}
	return b.CommandRead(CmdFrameDump, jpegSize, nil, jpegSize)
}

func (b *Board) Capabilities() (uint32, uint32, error) {
	data, err := b.CommandReadWithIdle(CmdCapabilities, responseLen[CmdCapabilities], nil, 256)
	if err != nil {
		return 0, 0, err
	}
	if len(data) < 8 {
		return 0, 0, fmt.Errorf("short capabilities response: got %d bytes", len(data))
	}
	for offset := len(data) - 8; offset >= 0; offset-- {
		version := binary.LittleEndian.Uint32(data[offset : offset+4])
		flags := binary.LittleEndian.Uint32(data[offset+4 : offset+8])
		if version > 0 && version <= 16 && flags <= 0x00ffffff {
			return version, flags, nil
		}
	}
	return 0, 0, fmt.Errorf("invalid capabilities response")
}

func (b *Board) VirtualTouchStatus() (VirtualTouchStatus, error) {
	data, err := b.SendCommand(CmdVTouchStatus, nil)
	if err != nil {
		return VirtualTouchStatus{}, err
	}
	if len(data) < 20 {
		return VirtualTouchStatus{}, fmt.Errorf("short virtual touch status: got %d bytes", len(data))
	}
	return VirtualTouchStatus{
		Supported:  binary.LittleEndian.Uint32(data[0:4]) != 0,
		Enabled:    binary.LittleEndian.Uint32(data[4:8]) != 0,
		RangeX:     binary.LittleEndian.Uint32(data[8:12]),
		RangeY:     binary.LittleEndian.Uint32(data[12:16]),
		QueueDepth: binary.LittleEndian.Uint32(data[16:20]),
	}, nil
}

func (b *Board) VirtualTouchEvent(event VirtualTouchEvent) error {
	payload := make([]byte, 12)
	binary.LittleEndian.PutUint16(payload[0:2], event.X)
	binary.LittleEndian.PutUint16(payload[2:4], event.Y)
	payload[4] = event.Event
	payload[5] = event.TrackID
	binary.LittleEndian.PutUint16(payload[6:8], event.Width)
	binary.LittleEndian.PutUint32(payload[8:12], event.TimestampMS)
	return b.FireCommand(CmdVTouchEvent, uint32(len(payload)), payload)
}

func (b *Board) QueryFileStat(path string) (FileStat, error) {
	data, err := b.CommandRead(CmdQueryFileStat, 0, nulString(path), 16)
	if err != nil {
		return FileStat{}, err
	}
	if len(data) < 16 {
		return FileStat{Exists: false, Type: "file", Size: 0, Error: 0xffffffff}, nil
	}
	errCode := binary.LittleEndian.Uint32(data[0:4])
	kind := binary.LittleEndian.Uint32(data[4:8])
	size := binary.LittleEndian.Uint32(data[8:12])
	mtime := binary.LittleEndian.Uint32(data[12:16])
	fileType := "file"
	if kind == 1 {
		fileType = "directory"
	}
	return FileStat{
		Exists: errCode == 0 || errCode == 1024,
		Type:   fileType,
		Size:   size,
		MTime:  mtime,
		Error:  errCode,
	}, nil
}

func (b *Board) ListDir(path string) ([]FileEntry, error) {
	data, err := b.listDirResponse(path)
	if err != nil {
		return nil, err
	}
	if len(data) < 12 {
		return []FileEntry{}, nil
	}
	errCode := binary.LittleEndian.Uint32(data[0:4])
	payloadLen := int(binary.LittleEndian.Uint32(data[4:8]))
	count := int(binary.LittleEndian.Uint32(data[8:12]))
	if errCode != 0 && errCode != 1024 || payloadLen <= 0 || len(data) < 12+payloadLen {
		return []FileEntry{}, nil
	}
	payload := data[12 : 12+payloadLen]
	entries := make([]FileEntry, 0, count)
	offset := 0
	for i := 0; i < count; i++ {
		if offset+10 > len(payload) {
			break
		}
		etype := payload[offset]
		offset++
		nameLen := int(payload[offset])
		offset++
		size := binary.LittleEndian.Uint32(payload[offset : offset+4])
		mtime := binary.LittleEndian.Uint32(payload[offset+4 : offset+8])
		offset += 8
		if offset+nameLen > len(payload) {
			break
		}
		fileType := "file"
		if etype == 1 {
			fileType = "directory"
		}
		entries = append(entries, FileEntry{
			Name:  string(payload[offset : offset+nameLen]),
			Type:  fileType,
			Size:  size,
			MTime: mtime,
		})
		offset += nameLen
	}
	return entries, nil
}

func (b *Board) ReadFileAll(path string, chunkSize uint32) ([]byte, error) {
	stat, err := b.QueryFileStat(path)
	if err != nil {
		return nil, err
	}
	if !stat.Exists {
		return nil, fmt.Errorf("file not found: %s", path)
	}
	if stat.Type == "directory" {
		return nil, fmt.Errorf("path is a directory: %s", path)
	}
	if stat.Size == 0 {
		return []byte{}, nil
	}
	if chunkSize == 0 || chunkSize > maxFileChunk {
		chunkSize = maxFileChunk
	}
	out := make([]byte, 0, stat.Size)
	for offset := uint32(0); offset < stat.Size; {
		size := chunkSize
		if remaining := stat.Size - offset; remaining < size {
			size = remaining
		}
		chunk, err := b.ReadFile(path, offset, size)
		if err != nil {
			return nil, err
		}
		if len(chunk) == 0 {
			return nil, fmt.Errorf("short read at offset %d of %d", offset, stat.Size)
		}
		out = append(out, chunk...)
		offset += uint32(len(chunk))
	}
	if uint32(len(out)) != stat.Size {
		return nil, fmt.Errorf("short read: got %d of %d bytes", len(out), stat.Size)
	}
	return out, nil
}

func (b *Board) ReadFile(path string, offset uint32, size uint32) ([]byte, error) {
	if size > maxFileChunk {
		size = maxFileChunk
	}
	payload := make([]byte, 8, 8+len(path)+1)
	binary.LittleEndian.PutUint32(payload[0:4], offset)
	binary.LittleEndian.PutUint32(payload[4:8], size)
	payload = append(payload, nulString(path)...)
	data, err := b.readFileResponse(payload)
	if err != nil {
		return nil, err
	}
	if len(data) < 12 {
		return nil, fmt.Errorf("short read file header: got %d bytes", len(data))
	}
	errCode := binary.LittleEndian.Uint32(data[0:4])
	dataLen := int(binary.LittleEndian.Uint32(data[4:8]))
	if errCode != 0 && errCode != 1024 {
		return nil, fmt.Errorf("read file failed with code %d", errCode)
	}
	if dataLen < 0 || len(data) < 12+dataLen {
		return nil, fmt.Errorf("short read file payload: expected %d bytes, got %d", dataLen, len(data)-12)
	}
	return data[12 : 12+dataLen], nil
}

func (b *Board) WriteFile(path string, data []byte, chunkSize uint32) uint32 {
	if chunkSize == 0 || chunkSize > maxFileChunk {
		chunkSize = maxFileChunk
	}
	pathBytes := []byte(path)
	if len(pathBytes) >= 68 {
		return 1024 + 11
	}
	sum := sha256.Sum256(data)
	info := make([]byte, 4+68+32)
	binary.LittleEndian.PutUint32(info[0:4], chunkSize)
	copy(info[4:72], pathBytes)
	copy(info[72:], sum[:])
	ack, err := b.CommandRead(0x20, 0, info, 4)
	if err != nil {
		return 0xffffffff
	}
	errCode := uint32(0xffffffff)
	if len(ack) >= 4 {
		errCode = binary.LittleEndian.Uint32(ack[:4])
	}
	if errCode != 0 && errCode != 1024 {
		return errCode
	}
	for offset := 0; offset < len(data); offset += int(chunkSize) {
		end := offset + int(chunkSize)
		if end > len(data) {
			end = len(data)
		}
		chunk := data[offset:end]
		payload := make([]byte, 4, 4+len(chunk))
		binary.LittleEndian.PutUint32(payload[0:4], uint32(len(chunk)))
		payload = append(payload, chunk...)
		ack, err = b.CommandRead(0x21, 0, payload, 4)
		if err != nil || len(ack) < 4 {
			return 0xffffffff
		}
		errCode = binary.LittleEndian.Uint32(ack[:4])
		if errCode != 0 {
			return errCode
		}
	}
	ack, err = b.SendCommandWithResponseLen(CmdVerifyFile, 4, nil)
	if err != nil || len(ack) < 4 {
		return 0xffffffff
	}
	errCode = binary.LittleEndian.Uint32(ack[:4])
	if errCode == 0 || errCode == 1024+7 {
		return 0
	}
	return errCode
}

func (b *Board) SimpleFileOp(opcode byte, payload []byte) uint32 {
	data, err := b.SendCommandWithResponseLen(opcode, 4, payload)
	if err != nil || len(data) < 4 {
		return 0xffffffff
	}
	return binary.LittleEndian.Uint32(data[:4])
}

func (b *Board) TxBufLen() (int, error) {
	data, err := b.SendCommand(CmdTxBufLen, nil)
	if err != nil {
		return 0, err
	}
	if len(data) < 4 {
		return 0, nil
	}
	return int(binary.LittleEndian.Uint32(data[:4])), nil
}

func nulString(value string) []byte {
	return append([]byte(value), 0)
}

func (b *Board) ReadTxBuf(length int) ([]byte, error) {
	if length <= 0 {
		return nil, nil
	}
	if length > maxTxBufPayload {
		return nil, fmt.Errorf("tx buffer payload too large: %d", length)
	}
	return b.SendCommandWithResponseLen(CmdTxBuf, uint32(length), nil)
}

func (b *Board) DrainTxBuf() ([]byte, error) {
	length, err := b.TxBufLen()
	if err != nil || length <= 0 {
		return nil, err
	}
	return b.ReadTxBuf(length)
}

func (b *Board) SendCommand(opcode byte, payload []byte) ([]byte, error) {
	return b.SendCommandWithResponseLen(opcode, responseLen[opcode], payload)
}

func (b *Board) SendCommandWithResponseLen(opcode byte, respLen uint32, payload []byte) ([]byte, error) {
	return b.CommandRead(opcode, respLen, payload, respLen)
}

func (b *Board) FireCommand(opcode byte, responseField uint32, payload []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.writeCommandLocked(opcode, responseField, payload)
}

func (b *Board) CommandRead(opcode byte, responseField uint32, payload []byte, readLen uint32) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if err := b.writeCommandLocked(opcode, responseField, payload); err != nil {
		return nil, err
	}
	if readLen == 0 {
		return nil, nil
	}

	data := make([]byte, readLen)
	if err := readExact(b.port, data); err != nil {
		return nil, err
	}
	return data, nil
}

func (b *Board) CommandReadWithIdle(opcode byte, responseField uint32, payload []byte, maxLen uint32) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if err := b.writeCommandLocked(opcode, responseField, payload); err != nil {
		return nil, err
	}
	if maxLen == 0 {
		return nil, nil
	}

	return readWithIdle(b.port, int(maxLen))
}

func (b *Board) listDirResponse(path string) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.writeCommandLocked(CmdListDir, 0, nulString(path)); err != nil {
		return nil, err
	}
	header := make([]byte, 12)
	if err := readExact(b.port, header); err != nil {
		return nil, err
	}
	payloadLen := binary.LittleEndian.Uint32(header[4:8])
	if payloadLen == 0 {
		return header, nil
	}
	if payloadLen > maxDirPayload {
		return nil, fmt.Errorf("list dir payload too large: %d", payloadLen)
	}
	payload := make([]byte, payloadLen)
	if err := readExact(b.port, payload); err != nil {
		return nil, err
	}
	return append(header, payload...), nil
}

func (b *Board) readFileResponse(payload []byte) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.writeCommandLocked(CmdReadFile, 0, payload); err != nil {
		return nil, err
	}
	header := make([]byte, 12)
	if err := readExact(b.port, header); err != nil {
		return nil, err
	}
	dataLen := binary.LittleEndian.Uint32(header[4:8])
	if dataLen == 0 {
		return header, nil
	}
	if dataLen > maxFileChunk {
		return nil, fmt.Errorf("read file payload too large: %d", dataLen)
	}
	data := make([]byte, dataLen)
	if err := readExact(b.port, data); err != nil {
		return nil, err
	}
	return append(header, data...), nil
}

func (b *Board) writeCommandLocked(opcode byte, responseField uint32, payload []byte) error {
	cmd := make([]byte, 6+len(payload))
	cmd[0] = CmdPrefix
	cmd[1] = opcode
	binary.LittleEndian.PutUint32(cmd[2:], responseField)
	copy(cmd[6:], payload)
	_, err := b.port.Write(cmd)
	return err
}

func readExact(port serial.Port, data []byte) error {
	offset := 0
	for offset < len(data) {
		n, err := port.Read(data[offset:])
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("short read: got %d of %d bytes", offset, len(data))
		}
		offset += n
	}
	return nil
}

func readWithIdle(port serial.Port, maxLen int) ([]byte, error) {
	if maxLen <= 0 {
		return nil, nil
	}
	_ = port.SetReadTimeout(1 * time.Second)
	data := make([]byte, 0, maxLen)
	buf := make([]byte, minInt(maxFileChunk, maxLen))
	remaining := maxLen
	for remaining > 0 {
		if len(buf) > remaining {
			buf = buf[:remaining]
		}
		n, err := port.Read(buf)
		if err != nil {
			if len(data) > 0 {
				_ = port.SetReadTimeout(1 * time.Second)
				return data, nil
			}
			_ = port.SetReadTimeout(1 * time.Second)
			return nil, err
		}
		if n == 0 {
			break
		}
		data = append(data, buf[:n]...)
		remaining -= n
		_ = port.SetReadTimeout(30 * time.Millisecond)
	}
	_ = port.SetReadTimeout(1 * time.Second)
	return data, nil
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}
