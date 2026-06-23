//go:build !windows

package main

func beginPreviewTimerResolution() func() {
	return func() {}
}
