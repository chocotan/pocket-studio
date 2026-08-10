package daemon

import (
	"io"
	"time"
)

const (
	terminalOutputBatchDelay = 8 * time.Millisecond
	terminalOutputMaxBatch   = 64 << 10
	terminalOutputReadBuffer = 32 << 10
)

type terminalReadChunk struct {
	data []byte
	err  error
}

func streamTerminalOutput(reader io.Reader, batchDelay time.Duration, maxBatchSize int, emit func([]byte)) error {
	chunks := make(chan terminalReadChunk, 16)
	go func() {
		buffer := make([]byte, terminalOutputReadBuffer)
		for {
			n, err := reader.Read(buffer)
			if n > 0 {
				data := append([]byte(nil), buffer[:n]...)
				chunks <- terminalReadChunk{data: data}
			}
			if err != nil {
				chunks <- terminalReadChunk{err: err}
				return
			}
		}
	}()

	if batchDelay <= 0 {
		batchDelay = terminalOutputBatchDelay
	}
	if maxBatchSize <= 0 {
		maxBatchSize = terminalOutputMaxBatch
	}

	for {
		first := <-chunks
		batch := append([]byte(nil), first.data...)
		if first.err != nil {
			if len(batch) > 0 {
				emit(batch)
			}
			return first.err
		}

		timer := time.NewTimer(batchDelay)
		var readErr error
	collect:
		for len(batch) < maxBatchSize {
			select {
			case chunk := <-chunks:
				batch = append(batch, chunk.data...)
				if chunk.err != nil {
					readErr = chunk.err
					break collect
				}
			case <-timer.C:
				break collect
			}
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		if len(batch) > 0 {
			emit(batch)
		}
		if readErr != nil {
			return readErr
		}
	}
}
