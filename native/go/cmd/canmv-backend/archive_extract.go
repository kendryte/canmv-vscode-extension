package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func extractArchive(archivePath string, targetDir string) error {
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return err
	}

	lower := strings.ToLower(archivePath)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		return extractZipArchive(archivePath, targetDir)
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		return extractTarGzArchive(archivePath, targetDir)
	default:
		return fmt.Errorf("unsupported archive type: %s", archivePath)
	}
}

func extractZipArchive(archivePath string, targetDir string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()

	for _, entry := range reader.File {
		targetPath, err := archiveEntryTarget(targetDir, entry.Name)
		if err != nil {
			return err
		}
		if targetPath == "" {
			continue
		}

		mode := entry.FileInfo().Mode()
		if mode&os.ModeSymlink != 0 {
			continue
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(targetPath, 0o755); err != nil {
				return err
			}
			continue
		}

		src, err := entry.Open()
		if err != nil {
			return err
		}
		written, err := writeArchiveFile(targetPath, mode.Perm(), src)
		closeErr := src.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if entry.UncompressedSize64 != uint64(written) {
			return fmt.Errorf("archive entry size mismatch for %s: wrote %d bytes, expected %d", entry.Name, written, entry.UncompressedSize64)
		}
		if err := verifyArchiveFile(targetPath, entry.Name, entry.UncompressedSize64); err != nil {
			return err
		}
	}
	return nil
}

func extractTarGzArchive(archivePath string, targetDir string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()

	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzipReader.Close()

	tarReader := tar.NewReader(gzipReader)
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}

		targetPath, err := archiveEntryTarget(targetDir, header.Name)
		if err != nil {
			return err
		}
		if targetPath == "" {
			continue
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(targetPath, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if _, err := writeArchiveFile(targetPath, header.FileInfo().Mode().Perm(), tarReader); err != nil {
				return err
			}
		}
	}
}

func archiveEntryTarget(targetDir string, entryName string) (string, error) {
	if strings.Contains(entryName, "\x00") {
		return "", fmt.Errorf("archive entry contains NUL byte: %q", entryName)
	}

	normalized := strings.ReplaceAll(entryName, "\\", "/")
	if path.IsAbs(normalized) {
		return "", fmt.Errorf("archive entry uses absolute path: %s", entryName)
	}

	cleaned := path.Clean(normalized)
	if cleaned == "." {
		return "", nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("archive entry escapes target directory: %s", entryName)
	}

	targetPath := filepath.Join(targetDir, filepath.FromSlash(cleaned))
	rootAbs, err := filepath.Abs(targetDir)
	if err != nil {
		return "", err
	}
	targetAbs, err := filepath.Abs(targetPath)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(rootAbs, targetAbs)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("archive entry escapes target directory: %s", entryName)
	}
	return targetPath, nil
}

func writeArchiveFile(targetPath string, mode os.FileMode, src io.Reader) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return 0, err
	}
	if mode == 0 {
		mode = 0o644
	}

	dst, err := os.OpenFile(targetPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()
	if copyErr != nil {
		return written, copyErr
	}
	return written, closeErr
}

func verifyArchiveFile(targetPath string, entryName string, expectedSize uint64) error {
	info, err := os.Stat(targetPath)
	if err != nil {
		return fmt.Errorf("archive entry was not created for %s: %w", entryName, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("archive entry is not a regular file after extraction: %s", entryName)
	}
	if uint64(info.Size()) != expectedSize {
		return fmt.Errorf("archive entry size mismatch on disk for %s: got %d bytes, expected %d", entryName, info.Size(), expectedSize)
	}
	return nil
}
