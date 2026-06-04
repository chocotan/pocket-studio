package daemon

import (
	"testing"
	"time"
)

func TestReconnectDelayBackoff(t *testing.T) {
	delay := reconnectInitialDelay
	expected := []time.Duration{
		time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
	}

	for _, want := range expected {
		var got time.Duration
		got, delay = reconnectDelay(delay, 0)
		if got != want {
			t.Fatalf("reconnectDelay() delay = %s, want %s", got, want)
		}
	}
}

func TestReconnectDelayCapsAtMax(t *testing.T) {
	got, next := reconnectDelay(reconnectMaxDelay, 0)
	if got != reconnectMaxDelay {
		t.Fatalf("reconnectDelay() delay = %s, want %s", got, reconnectMaxDelay)
	}
	if next != reconnectMaxDelay {
		t.Fatalf("reconnectDelay() next = %s, want %s", next, reconnectMaxDelay)
	}
}

func TestReconnectDelayResetsAfterStableConnection(t *testing.T) {
	got, next := reconnectDelay(reconnectMaxDelay, reconnectStableAfter)
	if got != reconnectInitialDelay {
		t.Fatalf("reconnectDelay() delay after stable connection = %s, want %s", got, reconnectInitialDelay)
	}
	if next != 2*time.Second {
		t.Fatalf("reconnectDelay() next after stable connection = %s, want 2s", next)
	}
}
