package protocol

import (
	"bytes"
	"testing"
)

func TestTerminalStreamDataBinaryRoundTrip(t *testing.T) {
	want := TerminalStreamData{
		ProjectID:  "ws_test",
		TerminalID: "term_1",
		Data:       []byte("abc\x1b[D"),
	}
	raw, err := MarshalTerminalStreamDataBinary(want)
	if err != nil {
		t.Fatalf("MarshalTerminalStreamDataBinary() error = %v", err)
	}
	got, ok, err := UnmarshalTerminalStreamDataBinary(raw)
	if err != nil {
		t.Fatalf("UnmarshalTerminalStreamDataBinary() error = %v", err)
	}
	if !ok {
		t.Fatal("UnmarshalTerminalStreamDataBinary() ok = false, want true")
	}
	if got.ProjectID != want.ProjectID || got.TerminalID != want.TerminalID || !bytes.Equal(got.Data, want.Data) {
		t.Fatalf("UnmarshalTerminalStreamDataBinary() = %#v, want %#v", got, want)
	}
}

func TestTerminalStreamDataBinaryIgnoresNonBinaryFrame(t *testing.T) {
	_, ok, err := UnmarshalTerminalStreamDataBinary([]byte(`{"type":"daemon.hello"}`))
	if err != nil {
		t.Fatalf("UnmarshalTerminalStreamDataBinary() error = %v", err)
	}
	if ok {
		t.Fatal("UnmarshalTerminalStreamDataBinary() ok = true, want false")
	}
}
