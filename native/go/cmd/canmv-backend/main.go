package main

import (
	"encoding/base64"
	"io"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"canmv-backend/internal/boardprotocol"
	"canmv-backend/internal/protocol"
	"canmv-backend/internal/usbdbg"
)

type server struct {
	conn              *protocol.Conn
	board             *usbdbg.Board
	pollerStop        chan struct{}
	pollerDone        chan struct{}
	previewStop       chan struct{}
	previewDone       chan struct{}
	pollerMutex       sync.Mutex
	previewMu         sync.Mutex
	boardMu           sync.Mutex
	opMu              sync.Mutex
	closing           bool
	operationSeq      uint64
	protocolHandler   boardprotocol.Handler
	virtualTouchCache usbdbg.VirtualTouchStatus
	virtualTouchAt    time.Time
}

const (
	previewNoFrameRetryDelay = 2 * time.Millisecond
	previewNoFrameRetryLimit = 8
	previewWindowsTimerGuard = 6 * time.Millisecond
)

func main() {
	if code, handled := runCommandLine(os.Args[1:]); handled {
		os.Exit(code)
	}

	s := &server{conn: protocol.NewConn(os.Stdin, os.Stdout)}
	done := make(chan struct{})
	defer close(done)
	defer s.cleanupBoard()
	s.installShutdownHandlers(done, os.Getppid())
	for {
		req, err := s.conn.ReadRequest()
		if err != nil {
			if err != io.EOF {
				_, _ = os.Stderr.WriteString("[canmv-backend] " + err.Error() + "\n")
			}
			return
		}
		result, code, message := s.handle(req.Method, req.Params)
		if req.ID == 0 {
			continue
		}
		if code != 0 {
			_ = s.conn.RespondError(req.ID, code, message)
		} else {
			_ = s.conn.Respond(req.ID, result)
		}
	}
}

func runCommandLine(args []string) (int, bool) {
	if len(args) == 0 {
		return 0, false
	}
	switch args[0] {
	case "--extract-archive":
		if len(args) != 3 {
			_, _ = os.Stderr.WriteString("usage: canmv-backend --extract-archive <archive> <target-dir>\n")
			return 2, true
		}
		if err := extractArchive(args[1], args[2]); err != nil {
			_, _ = os.Stderr.WriteString(err.Error() + "\n")
			return 1, true
		}
		return 0, true
	case "--help", "-h":
		_, _ = os.Stdout.WriteString("usage: canmv-backend [--extract-archive <archive> <target-dir>]\n")
		return 0, true
	default:
		_, _ = os.Stderr.WriteString("unknown argument: " + args[0] + "\n")
		return 2, true
	}
}

func (s *server) installShutdownHandlers(done <-chan struct{}, parentPID int) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		select {
		case <-signals:
			finished := make(chan struct{})
			go func() {
				s.cleanupBoard()
				close(finished)
			}()
			select {
			case <-finished:
			case <-time.After(2500 * time.Millisecond):
				_, _ = os.Stderr.WriteString("[canmv-backend] forced shutdown after cleanup timeout\n")
			}
			os.Exit(0)
		case <-done:
			signal.Stop(signals)
		}
	}()

	if parentPID <= 1 {
		return
	}
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if os.Getppid() != parentPID {
					_, _ = os.Stderr.WriteString("[canmv-backend] parent process changed; shutting down\n")
					s.cleanupBoard()
					os.Exit(0)
				}
			}
		}
	}()
}

func (s *server) handle(method string, params map[string]interface{}) (interface{}, int, string) {
	switch method {
	case "detectBoards":
		boards, err := usbdbg.DetectBoards()
		if err != nil {
			return map[string]interface{}{"boards": []usbdbg.DetectedBoard{}}, 0, ""
		}
		return map[string]interface{}{"boards": boards}, 0, ""
	case "connectBoard":
		return s.connectBoard(params)
	case "getFirmwareCommit":
		return s.getFirmwareCommit()
	case "disconnectBoard":
		s.cleanupBoard()
		return map[string]string{}, 0, ""
	case "scriptRunning":
		return s.scriptRunningStatus()
	case "runScript":
		return s.runScript(params)
	case "stopScript":
		return s.stopScript()
	case "terminalInput":
		return s.terminalInput(params)
	case "virtualTouch.status":
		return s.virtualTouchStatus()
	case "virtualTouch.event":
		return s.virtualTouchEvent(params)
	case "io.fileExec":
		return s.fileExec(params)
	case "startPreview":
		return s.startPreview(params)
	case "stopPreview":
		s.stopPreview()
		if s.board != nil {
			s.startPoller(false)
		}
		return map[string]string{}, 0, ""
	case "io.listDir":
		return s.listDir(params)
	case "io.queryFileStat":
		return s.queryFileStat(params)
	case "io.readFile":
		return s.readFile(params)
	case "io.writeFile":
		return s.writeFile(params)
	case "io.deleteFile":
		return s.simpleFileOp(params, usbdbg.CmdDeleteFile, "path")
	case "io.renameFile":
		return s.renameFile(params)
	case "io.mkdir":
		return s.simpleFileOp(params, usbdbg.CmdMkdir, "path")
	case "io.rmdir":
		return s.simpleFileOp(params, usbdbg.CmdRmdir, "path")
	default:
		return nil, 9002, "method not implemented in Go backend fork: " + method
	}
}

func (s *server) connectBoard(params map[string]interface{}) (interface{}, int, string) {
	portName := stringParam(params, "port", "")
	if portName == "" {
		return nil, 1001, "missing serial port"
	}
	baudRate := intParam(params, "baudRate", 12000000)

	if s.board != nil {
		s.cleanupBoard()
	}
	board, err := usbdbg.Open(portName, baudRate)
	if err != nil {
		return nil, 1001, err.Error()
	}
	s.boardMu.Lock()
	s.board = board
	s.closing = false
	s.protocolHandler = nil
	s.virtualTouchCache = usbdbg.VirtualTouchStatus{}
	s.virtualTouchAt = time.Time{}
	s.boardMu.Unlock()

	protocolHandler := s.negotiateProtocol(board)
	profile := protocolHandler.Profile()
	fwFull := profile.FirmwareFull()
	arch, _ := board.ArchStr()
	fw := firmwareVersionForUser(fwFull)
	boardName, memorySize := boardInfoFromArch(arch)
	_ = s.enableFramebuffer(board)
	if protocolHandler.HasCapabilitiesProtocol() {
		s.scheduleConnectSoftReset(board, s.currentOperationSeq())
	} else {
		s.startPoller(false)
		_ = s.conn.Event("boardReady", map[string]string{"state": "ready"})
	}

	return map[string]interface{}{
		"boardType":       firmwareChipFromFull(fwFull),
		"fwVersion":       fw,
		"fwVersionFull":   fwFull,
		"archStr":         arch,
		"boardName":       boardName,
		"memorySize":      memorySize,
		"protocolVersion": profile.ProtocolVersion(),
		"capabilities":    profile.CapabilityMap(),
		"port":            portName,
		"repl":            "",
	}, 0, ""
}

func (s *server) getFirmwareCommit() (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]string{"commitId": "", "fwVersion": "0.0.0", "archStr": ""}, 0, ""
	}
	fwFull := s.currentProtocolProfile().FirmwareFull()
	if fwFull == "" {
		fwFull, _ = board.FWVersion()
	}
	arch, _ := board.ArchStr()
	return map[string]string{
		"commitId":  firmwareCommitFromFull(fwFull),
		"fwVersion": fwFull,
		"archStr":   arch,
	}, 0, ""
}

func (s *server) scriptRunningStatus() (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]bool{"running": false}, 0, ""
	}
	running, err := s.scriptRunning(board, false)
	if err != nil {
		return nil, 2003, err.Error()
	}
	return map[string]bool{"running": running}, 0, ""
}

func (s *server) runScript(params map[string]interface{}) (interface{}, int, string) {
	s.beginUserOperation()
	s.stopPreview()
	s.stopPoller()
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]string{"status": "error", "message": "Board not connected", "output": "Board not connected"}, 0, ""
	}
	script := stringParam(params, "script", "")
	if script == "" {
		return map[string]string{"status": "error", "message": "Empty script", "output": "Empty script"}, 0, ""
	}
	if !s.isCurrentBoard(board) {
		return map[string]string{"status": "error", "message": "Board disconnected", "output": "Board disconnected"}, 0, ""
	}
	// Pre-flight health check: verify the board is responsive before
	// attempting a soft reset. Avoids pushing an already-degraded board
	// further into a bad state during rapid start/stop cycles.
	if _, err := s.scriptRunning(board, false); err != nil {
		s.startPoller(false)
		return map[string]string{"status": "error", "message": "Board communication error; try again shortly", "output": err.Error()}, 0, ""
	}
	_ = s.softResetBoard(board)
	if data := s.drainBoardFor(board, 800*time.Millisecond, 25*time.Millisecond, 120*time.Millisecond); len(data) > 0 {
		_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
	}
	if !s.isCurrentBoard(board) {
		return map[string]string{"status": "error", "message": "Board disconnected", "output": "Board disconnected"}, 0, ""
	}
	running, err := s.scriptRunning(board, false)
	if err != nil {
		running = false
	}
	if running {
		message := "A script is already running. Stop it before running another script."
		s.startPoller(false)
		return map[string]string{"status": "error", "message": message, "output": message}, 0, ""
	}
	if err := board.ScriptExec([]byte(script)); err != nil {
		s.startPoller(false)
		return map[string]string{"status": "error", "message": err.Error(), "output": err.Error()}, 0, ""
	}
	_ = s.conn.Event("scriptState", map[string]string{"state": "started"})
	s.startPoller(true)
	return map[string]string{"status": "ok"}, 0, ""
}

func (s *server) stopScript() (interface{}, int, string) {
	s.beginUserOperation()
	s.stopPreview()
	s.stopPoller()
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]string{}, 0, ""
	}
	data := s.stopScriptAndDrain(board, 2*time.Second, true)
	s.startPoller(false)
	if len(data) > 0 {
		return map[string]string{"output": string(data)}, 0, ""
	}
	return map[string]string{}, 0, ""
}

func (s *server) terminalInput(params map[string]interface{}) (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]string{"status": "error", "message": "Board not connected"}, 0, ""
	}
	if !s.hasCapability(usbdbg.CapReplInput) {
		return nil, 2005, "REPL input is not supported by this firmware"
	}
	text := stringParam(params, "text", "")
	if text == "" {
		return map[string]string{"status": "ok"}, 0, ""
	}
	if err := s.currentProtocol().TerminalInput(board, text); err != nil {
		return map[string]string{"status": "error", "message": err.Error()}, 0, ""
	}
	return map[string]string{"status": "ok"}, 0, ""
}

func (s *server) virtualTouchStatus() (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return virtualTouchStatusResult(usbdbg.VirtualTouchStatus{}), 0, ""
	}
	if !s.hasCapability(usbdbg.CapVirtualTouch) {
		return virtualTouchStatusResult(usbdbg.VirtualTouchStatus{}), 0, ""
	}
	status, err := s.currentProtocol().VirtualTouchStatus(board)
	if err != nil {
		s.setVirtualTouchStatus(usbdbg.VirtualTouchStatus{})
		return virtualTouchStatusResult(usbdbg.VirtualTouchStatus{}), 0, ""
	}
	s.setVirtualTouchStatus(status)
	return virtualTouchStatusResult(status), 0, ""
}

func (s *server) virtualTouchEvent(params map[string]interface{}) (interface{}, int, string) {
	status := s.cachedVirtualTouchStatus()
	if !status.Supported || !status.Enabled || status.RangeX == 0 || status.RangeY == 0 {
		return map[string]bool{"accepted": false}, 0, ""
	}

	sourceWidth := intParam(params, "sourceWidth", int(status.RangeX))
	sourceHeight := intParam(params, "sourceHeight", int(status.RangeY))
	if sourceWidth <= 0 || sourceHeight <= 0 {
		return map[string]bool{"accepted": false}, 0, ""
	}

	eventCode := virtualTouchEventCode(stringParam(params, "event", ""))
	if eventCode == 0 {
		return map[string]bool{"accepted": false}, 0, ""
	}

	x := scaleCoordinate(intParam(params, "x", 0), sourceWidth, int(status.RangeX))
	y := scaleCoordinate(intParam(params, "y", 0), sourceHeight, int(status.RangeY))
	trackID := clampInt(intParam(params, "trackId", 1), 0, 255)
	width := clampInt(intParam(params, "width", 1), 1, 65535)
	timestampMS := uint32(time.Now().UnixMilli() & 0xffffffff)

	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]bool{"accepted": false}, 0, ""
	}
	if !s.hasCapability(usbdbg.CapVirtualTouch) {
		return map[string]bool{"accepted": false}, 0, ""
	}

	err := s.currentProtocol().VirtualTouchEvent(board, usbdbg.VirtualTouchEvent{
		X:           uint16(x),
		Y:           uint16(y),
		Event:       eventCode,
		TrackID:     uint8(trackID),
		Width:       uint16(width),
		TimestampMS: timestampMS,
	})
	if err != nil {
		return map[string]bool{"accepted": false}, 0, ""
	}
	return map[string]bool{"accepted": true}, 0, ""
}

func (s *server) fileExec(params map[string]interface{}) (interface{}, int, string) {
	s.beginUserOperation()
	s.stopPreview()
	s.stopPoller()
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]string{"status": "error", "message": "Not connected"}, 0, ""
	}
	if !s.hasCapability(usbdbg.CapFileExec) {
		return map[string]string{"status": "error", "message": "File execution is not supported by this firmware"}, 0, ""
	}
	path := stringParam(params, "path", "")
	if !s.isCurrentBoard(board) {
		return map[string]string{"status": "error", "message": "Board disconnected"}, 0, ""
	}
	// Pre-flight health check before soft reset.
	if _, err := s.scriptRunning(board, false); err != nil {
		s.startPoller(false)
		return map[string]string{"status": "error", "message": "Board communication error; try again shortly", "output": err.Error()}, 0, ""
	}
	_ = s.softResetBoard(board)
	if data := s.drainBoardFor(board, 800*time.Millisecond, 25*time.Millisecond, 120*time.Millisecond); len(data) > 0 {
		_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
	}
	if !s.isCurrentBoard(board) {
		return map[string]string{"status": "error", "message": "Board disconnected"}, 0, ""
	}
	running, err := s.scriptRunning(board, false)
	if err != nil {
		running = false
	}
	if running {
		s.startPoller(false)
		return map[string]string{"status": "error", "message": "A script is already running. Stop it before running another script."}, 0, ""
	}
	if err := s.currentProtocol().FileExec(board, path); err != nil {
		s.startPoller(false)
		return map[string]string{"status": "error", "message": err.Error()}, 0, ""
	}
	_ = s.conn.Event("scriptState", map[string]string{"state": "started"})
	s.startPoller(true)
	return map[string]string{"status": "started"}, 0, ""
}

func (s *server) startPreview(params map[string]interface{}) (interface{}, int, string) {
	s.opMu.Lock()

	board := s.currentBoard()
	if board == nil {
		s.opMu.Unlock()
		return map[string]string{"status": "error", "message": "Board not connected"}, 0, ""
	}
	if s.currentProtocol().CheckRunningBeforePreview() {
		running, err := s.scriptRunning(board, true)
		if err == nil && !running {
			s.opMu.Unlock()
			s.stopPreview()
			return map[string]string{"status": "error", "message": "No script is running"}, 0, ""
		}
	}
	s.previewMu.Lock()
	alreadyRunning := s.previewStop != nil
	s.previewMu.Unlock()
	if alreadyRunning {
		s.opMu.Unlock()
		return map[string]string{"status": "started"}, 0, ""
	}
	fps := intParam(params, "fps", 30)
	if fps < 1 {
		fps = 30
	}
	if fps > 60 {
		fps = 60
	}
	s.refreshFramebufferFor(board)
	operationSeq := s.currentOperationSeq()
	s.opMu.Unlock()
	s.startPreviewLoop(fps, operationSeq)
	return map[string]string{"status": "started"}, 0, ""
}

func (s *server) listDir(params map[string]interface{}) (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]interface{}{"entries": []usbdbg.FileEntry{}}, 0, ""
	}
	if !s.hasCapability(usbdbg.CapListDir) {
		return nil, 4008, "File explorer is not supported by this firmware"
	}
	entries, err := s.currentProtocol().ListDir(board, stringParam(params, "path", "/"))
	if err != nil {
		return nil, 4003, err.Error()
	}
	return map[string]interface{}{"entries": entries}, 0, ""
}

func (s *server) queryFileStat(params map[string]interface{}) (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]interface{}{"exists": false, "size": 0}, 0, ""
	}
	if !s.hasCapability(usbdbg.CapReadFile) {
		return map[string]interface{}{"exists": false, "size": 0}, 0, ""
	}
	stat, err := s.currentProtocol().QueryFileStat(board, stringParam(params, "path", ""))
	if err != nil {
		return map[string]interface{}{"exists": false, "size": 0}, 0, ""
	}
	return stat, 0, ""
}

func (s *server) readFile(params map[string]interface{}) (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]string{"dataBase64": ""}, 0, ""
	}
	if !s.hasCapability(usbdbg.CapReadFile) {
		return nil, 4008, "File read is not supported by this firmware"
	}
	data, err := s.currentProtocol().ReadFileAll(board, stringParam(params, "path", ""), 128*1024)
	if err != nil {
		return nil, 4003, err.Error()
	}
	return map[string]string{"dataBase64": base64.StdEncoding.EncodeToString(data)}, 0, ""
}

func (s *server) writeFile(params map[string]interface{}) (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]interface{}{"success": false, "error": "Not connected"}, 0, ""
	}
	if !s.hasCapability(usbdbg.CapWriteFile) {
		return unsupportedFileOpResult("File write is not supported by this firmware"), 0, ""
	}
	path := stringParam(params, "path", "")
	if !isWritablePath(path) {
		return rejectProtectedPath(), 0, ""
	}
	var data []byte
	if encoded := stringParam(params, "dataBase64", ""); encoded != "" {
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return map[string]interface{}{"success": false, "error": "Invalid base64 data"}, 0, ""
		}
		data = decoded
	}
	errCode := s.currentProtocol().WriteFile(board, path, data, 128*1024)
	return fileOpResult(errCode), 0, ""
}

func (s *server) simpleFileOp(params map[string]interface{}, opcode byte, key string) (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]interface{}{"success": false, "errorCode": invalidPathErr}, 0, ""
	}
	if !s.hasCapability(capabilityForSimpleFileOp(opcode)) {
		return unsupportedFileOpResult("File operation is not supported by this firmware"), 0, ""
	}
	path := stringParam(params, key, "")
	if !isWritablePath(path) {
		return rejectProtectedPath(), 0, ""
	}
	errCode := s.currentProtocol().SimpleFileOp(board, opcode, append([]byte(path), 0))
	return fileOpResult(errCode), 0, ""
}

func (s *server) renameFile(params map[string]interface{}) (interface{}, int, string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	board := s.currentBoard()
	if board == nil {
		return map[string]interface{}{"success": false, "errorCode": invalidPathErr}, 0, ""
	}
	if !s.hasCapability(usbdbg.CapRenameFile) {
		return unsupportedFileOpResult("Rename is not supported by this firmware"), 0, ""
	}
	oldPath := stringParam(params, "oldPath", "")
	newPath := stringParam(params, "newPath", "")
	if !isWritablePath(oldPath) || !isWritablePath(newPath) {
		return rejectProtectedPath(), 0, ""
	}
	payload := append(append([]byte(oldPath), 0), append([]byte(newPath), 0)...)
	errCode := s.currentProtocol().SimpleFileOp(board, usbdbg.CmdRenameFile, payload)
	return fileOpResult(errCode), 0, ""
}

func (s *server) startPreviewLoop(fps int, operationSeq uint64) {
	s.stopPreview()
	stop := make(chan struct{})
	done := make(chan struct{})
	s.previewMu.Lock()
	s.previewStop = stop
	s.previewDone = done
	s.previewMu.Unlock()

	go func() {
		defer close(done)
		restoreTimerResolution := beginPreviewTimerResolution()
		defer restoreTimerResolution()
		interval := time.Second / time.Duration(fps)
		var frameID uint32
		probeCount := 0
		validFrameCount := 0
		linkErrors := 0
		noFrameCount := 0
		noFrameFastRetries := 0
		debugPreview := os.Getenv("CANMV_DEBUG_PREVIEW") == "1"
		for {
			select {
			case <-stop:
				return
			default:
			}
			board := s.currentBoard()
			if board == nil {
				return
			}
			if !s.isWorkerCurrent(board, operationSeq) {
				return
			}
			probeCount++
			frameProbeStart := time.Now()
			var jpegSize uint32
			var err error
			if !s.withWorkerBoardOperation(stop, board, operationSeq, func() {
				_, _, jpegSize, err = board.FrameSize()
			}) {
				return
			}
			if err != nil {
				linkErrors++
				if linkErrors >= 6 {
					s.reportWorkerBoardDisconnected(board, operationSeq, "preview frame_size", err)
					return
				}
				if os.Getenv("CANMV_DEBUG_PREVIEW") == "1" && (probeCount == 1 || probeCount%500 == 0) {
					running := false
					_ = s.withWorkerBoardOperation(stop, board, operationSeq, func() {
						running, _ = s.scriptRunning(board, true)
					})
					_, _ = os.Stderr.WriteString("[canmv-backend] preview frame_size unavailable size=" + strconv.Itoa(int(jpegSize)) + " running=" + strconv.FormatBool(running) + " err=" + errorString(err) + "\n")
				}
				if !sleepPreviewUntil(stop, frameProbeStart.Add(interval)) {
					return
				}
				continue
			}
			linkErrors = 0
			if jpegSize <= 100 {
				noFrameCount++
				if (debugPreview || validFrameCount == 0) && (noFrameCount == 1 || noFrameCount%90 == 0) {
					running := false
					_ = s.withWorkerBoardOperation(stop, board, operationSeq, func() {
						running, _ = s.scriptRunning(board, true)
					})
					_, _ = os.Stderr.WriteString("[canmv-backend] preview frame_size unavailable size=" + strconv.Itoa(int(jpegSize)) + " running=" + strconv.FormatBool(running) + " valid_frames=" + strconv.Itoa(validFrameCount) + "\n")
				}
				wakeAt := frameProbeStart.Add(interval)
				fastRetry := validFrameCount > 0 && noFrameFastRetries < previewNoFrameRetryLimit
				if fastRetry {
					noFrameFastRetries++
					wakeAt = time.Now().Add(previewNoFrameRetryDelay)
				}
				if !fastRetry && (noFrameCount == 1 || noFrameCount%10 == 0) {
					if !s.withWorkerBoardOperation(stop, board, operationSeq, func() {
						s.refreshFramebufferFor(board)
					}) {
						return
					}
				}
				if !sleepPreviewUntil(stop, wakeAt) {
					return
				}
				continue
			}
			if noFrameCount > 3 {
				// _, _ = os.Stderr.WriteString("[canmv-backend] preview framebuffer recovered after empty probes=" + strconv.Itoa(noFrameCount) + "\n")
				noFrameCount = 0
				noFrameFastRetries = 0
			}
			validFrameCount++
			if validFrameCount%20 == 0 {
				if s.supportsTxBuf() {
					var data []byte
					var err error
					if !s.withWorkerBoardOperation(stop, board, operationSeq, func() {
						data, err = s.currentProtocol().DrainTxBuf(board)
					}) {
						return
					}
					if err != nil {
						linkErrors++
						if linkErrors >= 6 {
							s.reportWorkerBoardDisconnected(board, operationSeq, "preview tx drain", err)
							return
						}
						if !sleepPreviewUntil(stop, frameProbeStart.Add(interval)) {
							return
						}
						continue
					}
					linkErrors = 0
					if len(data) > 0 {
						_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
					}
				}
			}
			if validFrameCount%10 == 0 {
				if !s.withWorkerBoardOperation(stop, board, operationSeq, func() {
					s.refreshFramebufferFor(board)
				}) {
					return
				}
			}
			var jpeg []byte
			if !s.withWorkerBoardOperation(stop, board, operationSeq, func() {
				jpeg, err = board.FrameDump(jpegSize)
			}) {
				return
			}
			if err != nil || len(jpeg) < 4 || jpeg[0] != 0xff || jpeg[1] != 0xd8 {
				if err != nil {
					linkErrors++
					if linkErrors >= 6 {
						s.reportWorkerBoardDisconnected(board, operationSeq, "preview frame_dump", err)
						return
					}
				}
				if validFrameCount == 1 || validFrameCount%100 == 0 {
					_, _ = os.Stderr.WriteString("[canmv-backend] preview frame_dump invalid expected=" + strconv.Itoa(int(jpegSize)) + " got=" + strconv.Itoa(len(jpeg)) + " err=" + errorString(err) + "\n")
				}
				if !sleepPreviewUntil(stop, frameProbeStart.Add(interval)) {
					return
				}
				continue
			}
			linkErrors = 0
			frameID++
			if frameID == 1 {
				_, _ = os.Stderr.WriteString("[canmv-backend] preview first frame bytes=" + strconv.Itoa(len(jpeg)) + "\n")
			}
			_ = s.conn.Frame(frameID, jpeg)
			if !sleepPreviewUntil(stop, frameProbeStart.Add(interval)) {
				return
			}
		}
	}()
}

func sleepPreviewUntil(stop <-chan struct{}, wakeAt time.Time) bool {
	for {
		remaining := time.Until(wakeAt)
		if remaining <= 0 {
			select {
			case <-stop:
				return false
			default:
				return true
			}
		}

		if runtime.GOOS == "windows" && remaining <= previewWindowsTimerGuard {
			select {
			case <-stop:
				return false
			default:
				runtime.Gosched()
				continue
			}
		}

		sleepFor := remaining
		if runtime.GOOS == "windows" && remaining > previewWindowsTimerGuard {
			sleepFor = remaining - previewWindowsTimerGuard
		}
		timer := time.NewTimer(sleepFor)
		select {
		case <-stop:
			timer.Stop()
			return false
		case <-timer.C:
		}
	}
}

func (s *server) refreshFramebuffer() {
	if board := s.currentBoard(); board != nil {
		s.refreshFramebufferFor(board)
	}
}

func (s *server) refreshFramebufferFor(board *usbdbg.Board) {
	_ = s.enableFramebuffer(board)
}

func (s *server) enableFramebuffer(board *usbdbg.Board) error {
	return s.currentProtocol().EnableFramebuffer(board)
}

func (s *server) disableFramebuffer(board *usbdbg.Board) {
	s.currentProtocol().DisableFramebuffer(board)
}

func (s *server) stopPreview() {
	s.previewMu.Lock()
	stop := s.previewStop
	done := s.previewDone
	s.previewStop = nil
	s.previewDone = nil
	s.previewMu.Unlock()
	if stop != nil {
		close(stop)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
		}
	}
}

func (s *server) startPoller(assumeRunning bool) {
	if s.currentBoard() == nil {
		return
	}
	s.stopPoller()
	operationSeq := s.currentOperationSeq()
	stop := make(chan struct{})
	done := make(chan struct{})
	s.pollerMutex.Lock()
	s.pollerStop = stop
	s.pollerDone = done
	s.pollerMutex.Unlock()

	go func() {
		defer close(done)
		wasRunning := assumeRunning
		notRunningCount := 0
		idleStatePoll := 0
		linkErrors := 0
		for {
			select {
			case <-stop:
				return
			default:
			}
			board := s.currentBoard()
			if board == nil {
				return
			}
			if !s.isWorkerCurrent(board, operationSeq) {
				return
			}
			if s.supportsTxBuf() {
				var data []byte
				var err error
				if !s.withWorkerBoardOperation(stop, board, operationSeq, func() {
					data, err = s.currentProtocol().DrainTxBuf(board)
				}) {
					return
				}
				if err != nil {
					if s.handleLegacyTxDrainError(board, err) {
						linkErrors = 0
						time.Sleep(50 * time.Millisecond)
						continue
					}
					linkErrors++
					if linkErrors >= 6 {
						s.reportWorkerBoardDisconnected(board, operationSeq, "poller tx drain", err)
						return
					}
					time.Sleep(50 * time.Millisecond)
					continue
				}
				linkErrors = 0
				if len(data) > 0 {
					_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
				}
			}

			shouldCheckRunning := wasRunning || assumeRunning || idleStatePoll <= 0
			if shouldCheckRunning {
				var running bool
				var err error
				if !s.withWorkerBoardOperation(stop, board, operationSeq, func() {
					running, err = s.scriptRunning(board, wasRunning || assumeRunning)
				}) {
					return
				}
				if err == nil {
					linkErrors = 0
					if running {
						notRunningCount = 0
						if !wasRunning {
							_ = s.conn.Event("scriptState", map[string]string{"state": "started"})
						}
						wasRunning = true
					} else if wasRunning {
						notRunningCount++
						if notRunningCount >= 8 {
							s.stableDrain(stop, board, operationSeq)
							_ = s.conn.Event("scriptState", map[string]string{"state": "finished"})
							wasRunning = false
							notRunningCount = 0
							assumeRunning = false
							idleStatePoll = 8
						}
					} else {
						notRunningCount = 0
						assumeRunning = false
						idleStatePoll = 8
					}
				} else {
					linkErrors++
					if linkErrors >= 6 {
						s.reportWorkerBoardDisconnected(board, operationSeq, "poller script_running", err)
						return
					}
				}
			} else {
				idleStatePoll--
			}
			if wasRunning {
				time.Sleep(100 * time.Millisecond)
			} else {
				time.Sleep(25 * time.Millisecond)
			}
		}
	}()
}

func (s *server) stopPoller() {
	s.pollerMutex.Lock()
	stop := s.pollerStop
	done := s.pollerDone
	s.pollerStop = nil
	s.pollerDone = nil
	s.pollerMutex.Unlock()
	if stop != nil {
		close(stop)
		select {
		case <-done:
		case <-time.After(300 * time.Millisecond):
		}
	}
}

func (s *server) stableDrain(stop <-chan struct{}, board *usbdbg.Board, operationSeq uint64) {
	if board == nil || !s.supportsTxBuf() {
		return
	}
	for i := 0; i < 5; i++ {
		var data []byte
		if !s.withWorkerBoardOperation(stop, board, operationSeq, func() {
			data, _ = s.currentProtocol().DrainTxBuf(board)
		}) {
			return
		}
		if len(data) == 0 {
			return
		}
		_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *server) cleanupBoard() {
	s.beginUserOperation()
	s.stopPoller()
	s.stopPreview()
	s.opMu.Lock()
	defer s.opMu.Unlock()

	s.boardMu.Lock()
	board := s.board
	s.closing = true
	s.boardMu.Unlock()

	if board == nil {
		return
	}
	s.boardMu.Lock()
	if s.board == board {
		s.board = nil
	}
	s.boardMu.Unlock()
	if data := s.stopScriptAndDrain(board, 1500*time.Millisecond, false); len(data) > 0 {
		_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
	}
	for attempt := 0; attempt < 2; attempt++ {
		_ = s.softResetBoard(board)
		if data := s.drainBoardFor(board, 800*time.Millisecond, 25*time.Millisecond, 120*time.Millisecond); len(data) > 0 {
			_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	s.disableFramebuffer(board)
	_ = board.Close()

	s.boardMu.Lock()
	s.clearBoardMetadataLocked()
	s.boardMu.Unlock()
}

func (s *server) scheduleConnectSoftReset(board *usbdbg.Board, operationSeq uint64) {
	go func() {
		s.opMu.Lock()
		defer s.opMu.Unlock()

		if !s.isConnectSetupCurrent(board, operationSeq) {
			return
		}
		_ = s.currentProtocol().ScriptStop(board)
		if !s.isConnectSetupCurrent(board, operationSeq) {
			return
		}
		_ = s.softResetBoard(board)
		if data := s.drainBoardFor(board, 1500*time.Millisecond, 50*time.Millisecond, 250*time.Millisecond); len(data) > 0 {
			_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
		}
		if !s.isConnectSetupCurrent(board, operationSeq) {
			return
		}
		for attempt := 0; attempt < 2; attempt++ {
			running, err := s.scriptRunning(board, false)
			if err == nil && !running {
				break
			}
			_ = s.softResetBoard(board)
			if data := s.drainBoardFor(board, 600*time.Millisecond, 50*time.Millisecond, 150*time.Millisecond); len(data) > 0 {
				_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
				break
			}
			if !s.isConnectSetupCurrent(board, operationSeq) {
				return
			}
		}
		if !s.isConnectSetupCurrent(board, operationSeq) {
			return
		}
		s.startPoller(false)
		_ = s.conn.Event("boardReady", map[string]string{"state": "ready"})
	}()
}

func (s *server) isCurrentBoard(board *usbdbg.Board) bool {
	s.boardMu.Lock()
	defer s.boardMu.Unlock()
	return !s.closing && s.board == board
}

func (s *server) isWorkerCurrent(board *usbdbg.Board, operationSeq uint64) bool {
	s.boardMu.Lock()
	defer s.boardMu.Unlock()
	return !s.closing && s.board == board && s.operationSeq == operationSeq
}

func (s *server) beginUserOperation() uint64 {
	s.boardMu.Lock()
	defer s.boardMu.Unlock()
	s.operationSeq++
	return s.operationSeq
}

func (s *server) currentOperationSeq() uint64 {
	s.boardMu.Lock()
	defer s.boardMu.Unlock()
	return s.operationSeq
}

func stopRequested(stop <-chan struct{}) bool {
	select {
	case <-stop:
		return true
	default:
		return false
	}
}

func (s *server) withWorkerBoardOperation(stop <-chan struct{}, board *usbdbg.Board, operationSeq uint64, fn func()) bool {
	if stopRequested(stop) || !s.isWorkerCurrent(board, operationSeq) {
		return false
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	if stopRequested(stop) || !s.isWorkerCurrent(board, operationSeq) {
		return false
	}
	fn()
	return true
}

func (s *server) isConnectSetupCurrent(board *usbdbg.Board, operationSeq uint64) bool {
	s.boardMu.Lock()
	defer s.boardMu.Unlock()
	return !s.closing && s.board == board && s.operationSeq == operationSeq
}

func (s *server) negotiateProtocol(board *usbdbg.Board) boardprotocol.Handler {
	protocolHandler := boardprotocol.Negotiate(board)
	s.boardMu.Lock()
	s.protocolHandler = protocolHandler
	s.boardMu.Unlock()
	return protocolHandler
}

func (s *server) currentProtocolProfile() boardprotocol.Profile {
	s.boardMu.Lock()
	defer s.boardMu.Unlock()
	return s.currentProtocolLocked().Profile()
}

func (s *server) currentProtocol() boardprotocol.Handler {
	s.boardMu.Lock()
	defer s.boardMu.Unlock()
	return s.currentProtocolLocked()
}

func (s *server) currentProtocolLocked() boardprotocol.Handler {
	if s.protocolHandler == nil {
		return boardprotocol.Default()
	}
	return s.protocolHandler
}

func (s *server) hasCapability(flag uint32) bool {
	return s.currentProtocol().HasCapability(flag)
}

func (s *server) hasCapabilitiesProtocol() bool {
	return s.currentProtocol().HasCapabilitiesProtocol()
}

func (s *server) supportsTxBuf() bool {
	return s.hasCapability(boardprotocol.CapTxBuf)
}

func (s *server) disableCapability(flag uint32) {
	s.boardMu.Lock()
	s.currentProtocolLocked().DisableCapability(flag)
	s.boardMu.Unlock()
}

func (s *server) handleLegacyTxDrainError(board *usbdbg.Board, err error) bool {
	if s.hasCapabilitiesProtocol() {
		return false
	}
	s.disableCapability(boardprotocol.CapTxBuf)
	_, _ = os.Stderr.WriteString("[canmv-backend] legacy tx buffer disabled err=" + errorString(err) + "\n")
	return true
}

func (s *server) softResetBoard(board *usbdbg.Board) error {
	return s.currentProtocol().SoftReset(board)
}

func (s *server) scriptRunning(board *usbdbg.Board, legacyFallback bool) (bool, error) {
	return s.currentProtocol().ScriptRunning(board, legacyFallback)
}

func (s *server) cachedVirtualTouchStatus() usbdbg.VirtualTouchStatus {
	s.boardMu.Lock()
	defer s.boardMu.Unlock()
	if time.Since(s.virtualTouchAt) > 5*time.Second {
		return usbdbg.VirtualTouchStatus{}
	}
	return s.virtualTouchCache
}

func (s *server) setVirtualTouchStatus(status usbdbg.VirtualTouchStatus) {
	s.boardMu.Lock()
	s.virtualTouchCache = status
	s.virtualTouchAt = time.Now()
	s.boardMu.Unlock()
}

func (s *server) clearBoardMetadataLocked() {
	s.protocolHandler = nil
	s.virtualTouchCache = usbdbg.VirtualTouchStatus{}
	s.virtualTouchAt = time.Time{}
}

func (s *server) currentBoard() *usbdbg.Board {
	s.boardMu.Lock()
	defer s.boardMu.Unlock()
	if s.closing {
		return nil
	}
	return s.board
}

func (s *server) reportBoardDisconnected(board *usbdbg.Board, source string, err error) {
	s.boardMu.Lock()
	if s.board != board || s.closing {
		s.boardMu.Unlock()
		return
	}
	s.board = nil
	s.closing = true
	s.clearBoardMetadataLocked()
	s.boardMu.Unlock()

	_, _ = os.Stderr.WriteString("[canmv-backend] board disconnected source=" + source + " err=" + errorString(err) + "\n")
	_ = board.Close()
	_ = s.conn.Event("boardDisconnected", map[string]string{"source": source, "message": errorString(err)})
}

func (s *server) reportWorkerBoardDisconnected(board *usbdbg.Board, operationSeq uint64, source string, err error) {
	if !s.isWorkerCurrent(board, operationSeq) {
		return
	}
	s.reportBoardDisconnected(board, source, err)
}

func (s *server) stopScriptAndDrain(board *usbdbg.Board, timeout time.Duration, emitDuringWait bool) []byte {
	if board == nil {
		return nil
	}
	var out []byte
	_ = s.currentProtocol().ScriptStop(board)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if data := s.drainBoardFor(board, 150*time.Millisecond, 25*time.Millisecond, 50*time.Millisecond); len(data) > 0 {
			if emitDuringWait {
				_ = s.conn.Event("scriptOutput", map[string]string{"text": string(data)})
			} else {
				out = append(out, data...)
			}
		}
		running, err := s.scriptRunning(board, false)
		if err == nil && !running {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	return out
}

func (s *server) drainBoardFor(board *usbdbg.Board, duration time.Duration, interval time.Duration, idleGrace time.Duration) []byte {
	if board == nil || !s.supportsTxBuf() {
		return nil
	}
	deadline := time.Now().Add(duration)
	var out []byte
	var lastData time.Time
	for time.Now().Before(deadline) {
		data, err := s.currentProtocol().DrainTxBuf(board)
		if err != nil {
			if s.handleLegacyTxDrainError(board, err) {
				return out
			}
			return out
		}
		if len(data) > 0 {
			out = append(out, data...)
			lastData = time.Now()
		} else if len(out) > 0 && !lastData.IsZero() && time.Since(lastData) >= idleGrace {
			break
		}
		time.Sleep(interval)
	}
	return out
}

func (s *server) drainFor(duration time.Duration, interval time.Duration, idleGrace time.Duration) []byte {
	if s.board == nil {
		return nil
	}
	deadline := time.Now().Add(duration)
	var out []byte
	var lastData time.Time
	for time.Now().Before(deadline) {
		if !s.supportsTxBuf() {
			return out
		}
		data, _ := s.currentProtocol().DrainTxBuf(s.board)
		if len(data) > 0 {
			out = append(out, data...)
			lastData = time.Now()
		} else if len(out) > 0 && !lastData.IsZero() && time.Since(lastData) >= idleGrace {
			break
		}
		time.Sleep(interval)
	}
	return out
}

func stringParam(params map[string]interface{}, key string, fallback string) string {
	if value, ok := params[key].(string); ok {
		return value
	}
	return fallback
}

func intParam(params map[string]interface{}, key string, fallback int) int {
	switch value := params[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	default:
		return fallback
	}
}

func virtualTouchStatusResult(status usbdbg.VirtualTouchStatus) map[string]interface{} {
	result := map[string]interface{}{
		"supported":  status.Supported,
		"enabled":    status.Enabled,
		"queueDepth": status.QueueDepth,
	}
	if status.Enabled && status.RangeX > 0 && status.RangeY > 0 {
		result["range"] = map[string]uint32{"w": status.RangeX, "h": status.RangeY}
	}
	return result
}

func virtualTouchEventCode(value string) uint8 {
	switch value {
	case "down":
		return 1
	case "up":
		return 2
	case "move":
		return 3
	default:
		return 0
	}
}

func scaleCoordinate(value int, sourceSize int, targetSize int) int {
	if targetSize <= 1 {
		return 0
	}
	if sourceSize <= 1 {
		return clampInt(value, 0, targetSize-1)
	}
	value = clampInt(value, 0, sourceSize-1)
	return clampInt((value*(targetSize-1)+(sourceSize-1)/2)/(sourceSize-1), 0, targetSize-1)
}

func clampInt(value int, minValue int, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

const invalidPathErr = 1024 + 11

var writableRoots = map[string]bool{
	"sdcard": true,
	"data":   true,
	"udisk":  true,
}

func isWritablePath(path string) bool {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	return len(parts) > 1 && writableRoots[parts[0]]
}

func rejectProtectedPath() map[string]interface{} {
	return map[string]interface{}{"success": false, "errorCode": invalidPathErr, "message": "CanMV root folders are read-only"}
}

func unsupportedFileOpResult(message string) map[string]interface{} {
	return map[string]interface{}{"success": false, "errorCode": boardprotocol.UnsupportedFileOpErrCode, "message": message}
}

func fileOpResult(errCode uint32) map[string]interface{} {
	return map[string]interface{}{"success": errCode == 0 || errCode == 1024, "errorCode": errCode}
}

func capabilityForSimpleFileOp(opcode byte) uint32 {
	switch opcode {
	case usbdbg.CmdDeleteFile:
		return usbdbg.CapDeleteFile
	case usbdbg.CmdMkdir:
		return usbdbg.CapMkdir
	case usbdbg.CmdRmdir:
		return usbdbg.CapRmdir
	default:
		return 0
	}
}

func firmwareVersionForUser(fwFull string) string {
	part := firmwareVersionPartFromFull(fwFull)
	if part == "" {
		return "unknown"
	}
	part = regexp.MustCompile(`-([0-9]+)-g[0-9a-fA-F]{7,40}$`).ReplaceAllString(part, "-$1")
	part = regexp.MustCompile(`-(?:g)?[0-9a-fA-F]{7,40}$`).ReplaceAllString(part, "")
	if part == "" {
		return "unknown"
	}
	return part
}

func firmwareVersionPartFromFull(fwFull string) string {
	re := regexp.MustCompile(`\b(v[0-9]+(?:\.[0-9]+){0,2}(?:-[0-9]+)?(?:-g?[0-9a-fA-F]{7,40})?)\b`)
	match := re.FindStringSubmatch(fwFull)
	if len(match) > 1 {
		return match[1]
	}
	return fwFull
}

func firmwareCommitFromFull(fwFull string) string {
	fw := strings.TrimSpace(fwFull)
	re := regexp.MustCompile(`-g([0-9a-fA-F]{7,40})\b`)
	match := re.FindStringSubmatch(fw)
	if len(match) > 1 {
		return match[1]
	}
	re = regexp.MustCompile(`-([0-9a-fA-F]{7,40})\b`)
	match = re.FindStringSubmatch(fw)
	if len(match) > 1 {
		return match[1]
	}
	return ""
}

func firmwareChipFromFull(fwFull string) string {
	re := regexp.MustCompile(`^([A-Za-z0-9_]+)-v[0-9]`)
	match := re.FindStringSubmatch(fwFull)
	if len(match) > 1 {
		return match[1]
	}
	return "K230"
}

func boardInfoFromArch(arch string) (string, string) {
	re := regexp.MustCompile(`\[([^:\]]+):([0-9a-fA-F]{8})([0-9a-fA-F]{8})`)
	match := re.FindStringSubmatch(arch)
	if len(match) < 4 {
		return "", ""
	}
	value, err := strconv.ParseInt(match[2], 16, 64)
	if err != nil || value == 0 {
		return match[1], ""
	}
	unitCode, err := strconv.ParseInt(match[3], 16, 64)
	if err != nil || unitCode < 32 || unitCode > 126 {
		return match[1], ""
	}
	return match[1], strconv.FormatInt(value, 10) + string(rune(unitCode))
}
