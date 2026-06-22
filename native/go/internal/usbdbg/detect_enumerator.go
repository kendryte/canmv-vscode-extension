//go:build linux || windows

package usbdbg

import (
	"strings"

	"go.bug.st/serial/enumerator"
)

func DetectBoards() ([]DetectedBoard, error) {
	ports, err := enumerator.GetDetailedPortsList()
	if err != nil {
		return nil, err
	}

	boards := []DetectedBoard{}
	for _, p := range ports {
		vid := strings.ToLower(p.VID)
		pid := strings.ToLower(p.PID)
		if vid == "1209" && pid == "abd1" {
			boards = append(boards, DetectedBoard{
				Port:         p.Name,
				Name:         "CanMV K230",
				VID:          vid,
				PID:          pid,
				SerialNumber: p.SerialNumber,
				Description:  p.Product,
			})
		}
	}
	return boards, nil
}
