//go:build !linux

package main

import (
	"errors"
	"io"
)

func runHTTPRelay(_ io.Reader, _ io.Writer, _ int) error {
	return errors.New("HTTP relay mode is available only in Linux builds")
}
