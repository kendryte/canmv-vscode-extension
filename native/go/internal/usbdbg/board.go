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

	// Shared by both legacy Qt IDE protocol and capability protocol.
	CmdScriptExec  = 0x05
	CmdScriptStop  = 0x06
	CmdTxInput     = 0x11
	CmdFBEnable    = 0x0D
	CmdFWVersion   = 0x80
	CmdFrameSize   = 0x81
	CmdFrameDump   = 0x82
	CmdArchStr     = 0x83
	CmdQueryStatus = 0x8D
	CmdTxBufLen    = 0x8E
	CmdTxBuf       = 0x8F
	CmdVerifyFile  = 0xA1

	// Legacy-only commands. Keep their wire semantics compatible with old IDEs.
	CmdSysReset      = 0x0C
	CmdCreateFile    = 0x20
	CmdWriteFile     = 0x21
	CmdScriptRunning = 0x87
	CmdQueryFileStat = 0xA0

	// Capability protocol v2 extensions. Keep this range contiguous; append
	// new extension-only commands after CmdVTouchEvent.
	CmdCapabilities   = 0xA2
	CmdFWVersionFull  = 0xA3
	CmdScriptStatus   = 0xA4
	CmdQueryFileStat2 = 0xA5
	CmdListDir        = 0xA6
	CmdReadFile       = 0xA7
	CmdCreateFile2    = 0xA8
	CmdWriteFile2     = 0xA9
	CmdDeleteFile     = 0xAA
	CmdRenameFile     = 0xAB
	CmdMkdir          = 0xAC
	CmdRmdir          = 0xAD
	CmdFileExec       = 0xAE
	CmdVTouchStatus   = 0xAF
	CmdVTouchEvent    = 0xB0

	CapListDir      = 1 << 0
	CapReadFile     = 1 << 1
	CapWriteFile    = 1 << 2
	CapDeleteFile   = 1 << 3
	CapRenameFile   = 1 << 4
	CapMkdir        = 1 << 5
	CapRmdir        = 1 << 6
	CapFileExec     = 1 << 7
	CapVirtualTouch = 1 << 8
	CapReplInput    = 1 << 9
	CapKnownMask    = CapListDir | CapReadFile | CapWriteFile | CapDeleteFile | CapRenameFile | CapMkdir | CapRmdir | CapFileExec | CapVirtualTouch | CapReplInput

	capProtocolVersion = 2

	// queryStatusMagic is the little-endian uint32 the firmware replies with to
	// USBDBG_QUERY_STATUS. It is used as a stream resync sentinel: scanning for
	// it lets the host discard stale/in-flight bytes left on the line (e.g. the
	// tail of a frame dump or queued REPL output) before reading framed replies.
	queryStatusMagic = 0xFFEEBBAA
	// syncMaxDiscard bounds how many stale bytes Sync will skip before giving up.
	syncMaxDiscard = 512 * 1024

	maxDirPayload   = 8 * 1024 * 1024
	maxFileChunk    = 128 * 1024
	maxFramePayload = 50 * 1024 * 1024
	maxTxBufPayload = 128 * 1024
	maxLegacyTxBuf  = 128 * 1024
)

var responseLen = map[byte]uint32{
	CmdFWVersion:     12,
	CmdFWVersionFull: 128,
	CmdFrameSize:     12,
	CmdArchStr:       64,
	CmdScriptRunning: 4,
	CmdScriptStatus:  4,
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
	portName = NormalizePortName(portName)
	mode := &serial.Mode{
		BaudRate: baudRate,
		InitialStatusBits: &serial.ModemOutputBits{
			RTS: true,
			DTR: false,
		},
	}
	port, err := serial.Open(portName, mode)
	if err != nil {
		return nil, err
	}
	// Force a DTR transition (deassert -> assert) so the device receives a CDC
	// SET_CONTROL_LINE_STATE with DTR asserted. macOS exposes USB CDC devices as
	// both tty.* and cu.* paths and may not deliver an asserted DTR request
	// unless the bit changes. The firmware gates USBDBG replies on DTR, so a
	// missing attach edge makes all negotiation reads time out as zero bytes.
	_ = port.SetRTS(true)
	_ = port.SetDTR(false)
	time.Sleep(50 * time.Millisecond)
	_ = port.SetDTR(true)
	time.Sleep(250 * time.Millisecond)
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

// Sync resynchronizes the command/response stream with the device. It sends
// USBDBG_QUERY_STATUS and reads bytes until it locks onto the 4-byte
// queryStatusMagic reply, discarding any stale/in-flight bytes that precede it
// (e.g. the tail of a frame dump or queued REPL output after a reconnect while a
// script is still running). After Sync returns nil the next framed reply read by
// the caller is byte-aligned. It is bounded by syncMaxDiscard and the port read
// timeout, so a non-responsive/legacy board fails fast rather than hanging.
func (b *Board) Sync() error {
	if b == nil || b.port == nil {
		return fmt.Errorf("sync: board not open")
	}
	b.mu.Lock()
	defer b.mu.Unlock()

	if err := b.writeCommandLocked(CmdQueryStatus, 0, nil); err != nil {
		return err
	}

	// window holds the most recent up-to-4 bytes seen so the marker can be
	// detected even when it straddles two reads.
	var window []byte
	buf := make([]byte, 4096)
	discarded := 0
	for {
		n, err := b.port.Read(buf)
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("sync: timed out waiting for status marker (discarded %d bytes)", discarded)
		}
		for i := 0; i < n; i++ {
			window = append(window, buf[i])
			if len(window) > 4 {
				window = window[1:]
			}
			if len(window) == 4 && binary.LittleEndian.Uint32(window) == queryStatusMagic {
				return nil
			}
		}
		discarded += n
		if discarded > syncMaxDiscard {
			return fmt.Errorf("sync: status marker not found within %d bytes", syncMaxDiscard)
		}
	}
}

func (b *Board) FWVersionFull() (string, error) {
	data, err := b.SendCommand(CmdFWVersionFull, nil)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.TrimRight(string(data), "\x00")), nil
}

func (b *Board) FWVersion() (string, error) {
	data, err := b.SendCommand(CmdFWVersion, nil)
	if err != nil {
		return "", err
	}
	if len(data) < 12 {
		return "", fmt.Errorf("short firmware version response: got %d bytes", len(data))
	}
	major := binary.LittleEndian.Uint32(data[0:4])
	minor := binary.LittleEndian.Uint32(data[4:8])
	micro := binary.LittleEndian.Uint32(data[8:12])
	return fmt.Sprintf("v%d.%d.%d", major, minor, micro), nil
}

func (b *Board) FWVersionFullOrLegacy() (string, error) {
	fwFull, err := b.FWVersionFull()
	if err == nil && fwFull != "" {
		return fwFull, nil
	}
	return b.FWVersion()
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

func (b *Board) ScriptStatus() (bool, error) {
	data, err := b.SendCommand(CmdScriptStatus, nil)
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
	if err := writeFull(b.port, header); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	if err := writeFull(b.port, data); err != nil {
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

func (b *Board) SysReset() error {
	if err := b.FireCommand(CmdSysReset, 0, nil); err != nil {
		return err
	}
	time.Sleep(100 * time.Millisecond)
	return nil
}

func (b *Board) FileExec(path string) error {
	payload := append([]byte(path), 0)
	return b.FireCommand(CmdFileExec, uint32(len(payload)), payload)
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
	// Send a harmless NUL payload. Current firmware ignores it, while older
	// experimental firmware that used this opcode for LIST_DIR can return an
	// error instead of waiting forever for a path payload.
	data, err := b.CommandRead(CmdCapabilities, 1, []byte{0}, responseLen[CmdCapabilities])
	if err != nil {
		return 0, 0, err
	}
	if len(data) != 8 {
		return 0, 0, fmt.Errorf("short capabilities response: got %d bytes", len(data))
	}
	version := binary.LittleEndian.Uint32(data[0:4])
	flags := binary.LittleEndian.Uint32(data[4:8])
	if version != capProtocolVersion {
		return 0, 0, fmt.Errorf("unsupported capabilities protocol version: %d", version)
	}
	if flags&^CapKnownMask != 0 {
		return 0, 0, fmt.Errorf("unknown capabilities flags: 0x%x", flags&^CapKnownMask)
	}
	return version, flags, nil
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
	data, err := b.CommandReadWithPayloadLen(CmdQueryFileStat2, nulString(path), 16)
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
	ack, err := b.CommandReadWithPayloadLen(CmdCreateFile2, info, 4)
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
		ack, err = b.CommandReadWithPayloadLen(CmdWriteFile2, chunk, 4)
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
	data, err := b.CommandReadWithPayloadLen(opcode, payload, 4)
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

func (b *Board) DrainTxBufLegacy() ([]byte, error) {
	if b == nil || b.port == nil {
		return nil, nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()

	raw, err := readWithShortIdleLocked(b.port, 64*1024, 5*time.Millisecond)
	if err != nil && len(raw) == 0 {
		return nil, err
	}
	if len(raw) > 0 {
		return raw, nil
	}

	if err := b.writeCommandLocked(CmdTxBufLen, responseLen[CmdTxBufLen], nil); err != nil {
		return nil, err
	}
	lenBytes := make([]byte, 4)
	if err := readExact(b.port, lenBytes); err != nil {
		return nil, err
	}
	length := binary.LittleEndian.Uint32(lenBytes)
	if length == 0 {
		return nil, nil
	}
	if length > maxLegacyTxBuf {
		return lenBytes, nil
	}

	if err := b.writeCommandLocked(CmdTxBuf, length, nil); err != nil {
		return nil, err
	}
	data := make([]byte, length)
	if err := readExact(b.port, data); err != nil {
		return nil, err
	}
	return data, nil
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

func (b *Board) CommandReadWithPayloadLen(opcode byte, payload []byte, readLen uint32) ([]byte, error) {
	return b.CommandRead(opcode, uint32(len(payload)), payload, readLen)
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
	request := nulString(path)
	if err := b.writeCommandLocked(CmdListDir, uint32(len(request)), request); err != nil {
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
	if err := b.writeCommandLocked(CmdReadFile, uint32(len(payload)), payload); err != nil {
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
	return writeFull(b.port, cmd)
}

// writeFull writes all of data, looping over short writes. The unix serial
// Write (shared by Linux and macOS) is a single write(2) syscall that may
// return a short count: macOS USB-CDC returns partial writes when the tty
// output buffer fills, whereas Linux blocks until fully queued and Windows
// waits for completion via overlapped I/O. A truncated command header or
// payload desyncs the device's frame parser, so all bytes must be written.
func writeFull(port serial.Port, data []byte) error {
	for len(data) > 0 {
		n, err := port.Write(data)
		if n > 0 {
			data = data[n:]
		}
		if err != nil {
			return err
		}
		if n == 0 && len(data) > 0 {
			return fmt.Errorf("short write: device stopped accepting data with %d bytes left", len(data))
		}
	}
	return nil
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

func readWithShortIdleLocked(port serial.Port, maxLen int, timeout time.Duration) ([]byte, error) {
	if maxLen <= 0 {
		return nil, nil
	}
	_ = port.SetReadTimeout(timeout)
	defer port.SetReadTimeout(1 * time.Second)

	data := make([]byte, 0, minInt(4096, maxLen))
	buf := make([]byte, minInt(4096, maxLen))
	for len(data) < maxLen {
		if remaining := maxLen - len(data); len(buf) > remaining {
			buf = buf[:remaining]
		}
		n, err := port.Read(buf)
		if err != nil {
			if len(data) > 0 {
				return data, nil
			}
			return nil, err
		}
		if n == 0 {
			break
		}
		data = append(data, buf[:n]...)
	}
	return data, nil
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}
