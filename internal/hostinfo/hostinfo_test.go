package hostinfo

import "testing"

func TestSelectReachableIPv4PrefersNonDockerInterface(t *testing.T) {
	candidates := []InterfaceAddress{
		{Name: "docker0", IP: "172.17.0.2"},
		{Name: "br-123", IP: "172.18.0.4"},
		{Name: "eth0", IP: "192.168.1.23"},
	}
	if got := SelectReachableIPv4(candidates); got != "192.168.1.23" {
		t.Fatalf("SelectReachableIPv4() = %q, want LAN address", got)
	}
}

func TestSelectReachableIPv4DoesNotDropLegitimate172LAN(t *testing.T) {
	candidates := []InterfaceAddress{{Name: "eth0", IP: "172.20.1.9"}}
	if got := SelectReachableIPv4(candidates); got != "172.20.1.9" {
		t.Fatalf("SelectReachableIPv4() = %q, want legitimate 172.20 LAN", got)
	}
}

func TestSelectReachableIPv4ReturnsEmptyForDockerOnlyCandidates(t *testing.T) {
	candidates := []InterfaceAddress{
		{Name: "docker0", IP: "172.17.0.2"},
		{Name: "br-456", IP: "172.18.0.4"},
		{Name: "vethabc", IP: "10.99.0.7"},
	}
	if got := SelectReachableIPv4(candidates); got != "" {
		t.Fatalf("SelectReachableIPv4() = %q, want empty for Docker-only candidates", got)
	}
}

func TestSelectReachableIPv4SkipsDockerInterfaceOutsideDefaultBridgeRange(t *testing.T) {
	candidates := []InterfaceAddress{
		{Name: "br-custom", IP: "172.20.0.9"},
		{Name: "eth0", IP: "10.0.0.5"},
	}
	if got := SelectReachableIPv4(candidates); got != "10.0.0.5" {
		t.Fatalf("SelectReachableIPv4() = %q, want non-Docker candidate", got)
	}
}

func TestSelectReachableIPv4PrefersPhysicalLANOverDockerAndTunnel(t *testing.T) {
	candidates := []InterfaceAddress{
		{Name: "singbox_tun", IP: "172.18.0.1"},
		{Name: "docker0", IP: "172.17.0.1"},
		{Name: "br-custom", IP: "172.20.0.1"},
		{Name: "tailscale0", IP: "100.67.227.95"},
		{Name: "wlp2s0", IP: "10.10.133.167"},
	}
	if got := SelectReachableIPv4(candidates); got != "10.10.133.167" {
		t.Fatalf("SelectReachableIPv4() = %q, want physical LAN address", got)
	}
}

func TestSelectReachableIPv4SkipsCustomDockerBridge172(t *testing.T) {
	candidates := []InterfaceAddress{
		{Name: "br-ae8018580a1c", IP: "172.20.0.1"},
		{Name: "docker_gwbridge", IP: "172.19.0.1"},
	}
	if got := SelectReachableIPv4(candidates); got != "" {
		t.Fatalf("SelectReachableIPv4() = %q, want empty for Docker bridge candidates", got)
	}
}

func TestHasEmbeddedUnreportableIPv4DetectsStaleDockerDisplayName(t *testing.T) {
	if !HasEmbeddedUnreportableIPv4("host (172.20.0.1)") {
		t.Fatal("expected stale Docker-like display IP to be unreportable")
	}
	if HasEmbeddedUnreportableIPv4("host (10.10.133.167)") {
		t.Fatal("expected physical LAN display IP to remain reportable")
	}
}

func TestResolveDeviceNameRefreshesStaleDockerDisplayName(t *testing.T) {
	stale := "host (172.18.0.1)"
	if got := ResolveDeviceName(stale); got == stale || HasEmbeddedUnreportableIPv4(got) {
		t.Fatalf("ResolveDeviceName(%q) = %q, want refreshed non-Docker name", stale, got)
	}
}

func TestIsUnreportableHostDetectsLocalDockerBridge(t *testing.T) {
	if !IsUnreportableHost("172.18.0.1") {
		t.Fatal("expected 172.18.0.1 to be unreportable")
	}
	if IsUnreportableHost("10.10.133.167") {
		t.Fatal("expected LAN host to be reportable")
	}
}
