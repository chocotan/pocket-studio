package daemon

import (
	"bytes"
	"io"
	"sync"
	"testing"
	"time"
)

type chunkReader struct {
	chunks [][]byte
	index  int
}

func (r *chunkReader) Read(buffer []byte) (int, error) {
	if r.index >= len(r.chunks) {
		return 0, io.EOF
	}
	chunk := r.chunks[r.index]
	r.index++
	return copy(buffer, chunk), nil
}

func TestStreamTerminalOutputCoalescesBurstInOrder(t *testing.T) {
	reader := &chunkReader{chunks: [][]byte{
		[]byte("\x1b[?2026h"),
		[]byte("first render fragment"),
		[]byte("second render fragment"),
		[]byte("\x1b[?2026l"),
	}}
	var emitted [][]byte
	err := streamTerminalOutput(reader, 50*time.Millisecond, 64<<10, func(data []byte) {
		emitted = append(emitted, append([]byte(nil), data...))
	})
	if err != io.EOF {
		t.Fatalf("streamTerminalOutput error = %v, want EOF", err)
	}
	if len(emitted) != 1 {
		t.Fatalf("emitted batches = %d, want 1", len(emitted))
	}
	want := bytes.Join(reader.chunks, nil)
	if !bytes.Equal(emitted[0], want) {
		t.Fatalf("emitted data = %q, want %q", emitted[0], want)
	}
}

func TestStreamTerminalOutputFlushesSustainedOutput(t *testing.T) {
	reader, writer := io.Pipe()
	var mu sync.Mutex
	var emitted [][]byte
	done := make(chan error, 1)
	go func() {
		done <- streamTerminalOutput(reader, 5*time.Millisecond, 64<<10, func(data []byte) {
			mu.Lock()
			emitted = append(emitted, append([]byte(nil), data...))
			mu.Unlock()
		})
	}()

	if _, err := writer.Write([]byte("first")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if _, err := writer.Write([]byte("second")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != io.EOF {
			t.Fatalf("streamTerminalOutput error = %v, want EOF", err)
		}
	case <-time.After(time.Second):
		t.Fatal("streamTerminalOutput did not finish")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(emitted) != 2 || string(emitted[0]) != "first" || string(emitted[1]) != "second" {
		t.Fatalf("emitted batches = %q", emitted)
	}
}
