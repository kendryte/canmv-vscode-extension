//go:build darwin

package usbdbg

import (
	"path/filepath"
	"strings"

	"go.bug.st/serial"
)

func DetectBoards() ([]DetectedBoard, error) {
	ports, err := serial.GetPortsList()
	if err != nil {
		return nil, err
	}

	boards := []DetectedBoard{}
	for _, port := range ports {
		name := filepath.Base(port)
		if !strings.HasPrefix(name, "cu.usbmodem") && !strings.HasPrefix(name, "tty.usbmodem") {
			continue
		}
		boards = append(boards, DetectedBoard{
			Port:        port,
			Name:        "CanMV K230",
			Description: "USB modem serial port",
		})
	}
	return boards, nil
}
