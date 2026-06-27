//go:build darwin

package usbdbg

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"go.bug.st/serial"
)

func DetectBoards() ([]DetectedBoard, error) {
	ports, err := serial.GetPortsList()
	if err != nil {
		return nil, err
	}

	type portCandidate struct {
		port string
		name string
	}

	byDevice := map[string]portCandidate{}
	for _, port := range ports {
		name := filepath.Base(port)
		if !strings.HasPrefix(name, "cu.usbmodem") && !strings.HasPrefix(name, "tty.usbmodem") {
			continue
		}
		normalized := NormalizePortName(port)
		normalizedName := filepath.Base(normalized)
		key := strings.TrimPrefix(strings.TrimPrefix(normalizedName, "cu."), "tty.")
		current, exists := byDevice[key]
		if !exists || strings.HasPrefix(normalizedName, "cu.") || !strings.HasPrefix(current.name, "cu.") {
			byDevice[key] = portCandidate{port: normalized, name: normalizedName}
		}
	}

	keys := make([]string, 0, len(byDevice))
	for key := range byDevice {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	boards := []DetectedBoard{}
	for _, key := range keys {
		candidate := byDevice[key]
		boards = append(boards, DetectedBoard{
			Port:        candidate.port,
			Name:        "CanMV K230",
			Description: "USB modem serial callout port",
		})
	}
	return boards, nil
}

func NormalizePortName(portName string) string {
	name := filepath.Base(portName)
	if !strings.HasPrefix(name, "tty.usbmodem") {
		return portName
	}
	candidate := filepath.Join(filepath.Dir(portName), "cu."+strings.TrimPrefix(name, "tty."))
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	return portName
}
