package boardprotocol

import "canmv-backend/internal/usbdbg"

type Kind string

const (
	KindUnknown Kind = ""
	KindLegacy  Kind = "legacy"
	KindV2      Kind = "v2"
)

const (
	// CapTxBuf is a backend pseudo-capability. Legacy firmware has no
	// capabilities command, so the backend learns this one opportunistically.
	CapTxBuf uint32 = 1 << 31

	UnsupportedFileOpErrCode uint32 = 1024 + 15
)

type Profile struct {
	kind          Kind
	version       uint32
	flags         uint32
	fwVersion     string
	fwVersionFull string
}

func (p Profile) ProtocolVersion() uint32 {
	if p.kind == KindLegacy || p.version == 0 {
		return 0
	}
	return p.version
}

func (p Profile) FirmwareFull() string {
	if p.fwVersionFull != "" {
		return p.fwVersionFull
	}
	return p.fwVersion
}

func (p Profile) CapabilityMap() map[string]interface{} {
	flags := p.flags
	return map[string]interface{}{
		"listDir":      flags&usbdbg.CapListDir != 0,
		"readFile":     flags&usbdbg.CapReadFile != 0,
		"writeFile":    flags&usbdbg.CapWriteFile != 0,
		"deleteFile":   flags&usbdbg.CapDeleteFile != 0,
		"renameFile":   flags&usbdbg.CapRenameFile != 0,
		"mkdir":        flags&usbdbg.CapMkdir != 0,
		"rmdir":        flags&usbdbg.CapRmdir != 0,
		"fileExec":     flags&usbdbg.CapFileExec != 0,
		"virtualTouch": flags&usbdbg.CapVirtualTouch != 0,
		"replInput":    flags&usbdbg.CapReplInput != 0,
	}
}
