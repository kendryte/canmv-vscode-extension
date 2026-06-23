//go:build windows

package main

import "syscall"

var winmm = syscall.NewLazyDLL("winmm.dll")
var timeBeginPeriod = winmm.NewProc("timeBeginPeriod")
var timeEndPeriod = winmm.NewProc("timeEndPeriod")

func beginPreviewTimerResolution() func() {
	if ret, _, _ := timeBeginPeriod.Call(1); ret != 0 {
		return func() {}
	}
	return func() {
		timeEndPeriod.Call(1)
	}
}
