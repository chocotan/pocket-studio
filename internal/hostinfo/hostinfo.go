package hostinfo

import (
	"fmt"
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
)

func DisplayName() string {
	hostname := strings.TrimSpace(hostnameOrFallback())
	ip := ReachableIPv4()
	if ip == "" {
		return hostname
	}
	return fmt.Sprintf("%s (%s)", hostname, ip)
}

func ResolveDeviceName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || name == "Local Machine" || HasEmbeddedUnreportableIPv4(name) {
		return DisplayName()
	}
	return name
}

func hostnameOrFallback() string {
	if hostname, err := os.Hostname(); err == nil && strings.TrimSpace(hostname) != "" {
		return hostname
	}
	return "localhost"
}

func ReachableIPv4() string {
	return firstNonLoopbackIPv4()
}

func defaultOutboundIPv4() string {
	conn, err := net.Dial("udp4", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()

	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP == nil || addr.IP.IsLoopback() {
		return ""
	}
	ip := addr.IP.To4()
	if ip == nil || isDefaultDockerBridgeIPv4(ip) || isDockerInterfaceIPv4(ip) {
		return ""
	}
	return ip.String()
}

type InterfaceAddress struct {
	Name  string
	IP    string
	Flags net.Flags
}

func firstNonLoopbackIPv4() string {
	return SelectReachableIPv4(interfaceIPv4Candidates())
}

func interfaceIPv4Candidates() []InterfaceAddress {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	candidates := make([]InterfaceAddress, 0)
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ip := ipFromAddr(addr)
			if ip == nil || ip.IsLoopback() {
				continue
			}
			if ipv4 := ip.To4(); ipv4 != nil {
				candidates = append(candidates, InterfaceAddress{Name: iface.Name, IP: ipv4.String(), Flags: iface.Flags})
			}
		}
	}
	return candidates
}

func SelectReachableIPv4(candidates []InterfaceAddress) string {
	type rankedCandidate struct {
		candidate InterfaceAddress
		ip        net.IP
		priority  int
		index     int
	}
	ranked := make([]rankedCandidate, 0, len(candidates))
	for index, candidate := range candidates {
		ip := net.ParseIP(strings.TrimSpace(candidate.IP)).To4()
		if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			continue
		}
		priority := interfaceAddressPriority(candidate, ip)
		if priority < 0 {
			continue
		}
		ranked = append(ranked, rankedCandidate{candidate: candidate, ip: ip, priority: priority, index: index})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].priority != ranked[j].priority {
			return ranked[i].priority < ranked[j].priority
		}
		return ranked[i].index < ranked[j].index
	})
	if len(ranked) == 0 {
		return ""
	}
	return ranked[0].ip.String()
}

func interfaceAddressPriority(candidate InterfaceAddress, ip net.IP) int {
	name := strings.ToLower(strings.TrimSpace(candidate.Name))
	if looksLikeContainerOrBridgeInterface(name) || isDefaultDockerBridgeIPv4(ip) {
		return -1
	}
	if candidate.Flags != 0 && candidate.Flags&net.FlagRunning == 0 {
		return 30
	}
	if looksLikePhysicalInterface(name) && isPrivateIPv4(ip) {
		return 0
	}
	if looksLikePhysicalInterface(name) {
		return 1
	}
	if isPrivateIPv4(ip) && !looksLikeTunnelOrVPNInterface(name) {
		return 5
	}
	if looksLikeTunnelOrVPNInterface(name) {
		return 20
	}
	return 10
}

func HasEmbeddedUnreportableIPv4(value string) bool {
	for _, match := range embeddedIPv4Pattern.FindAllString(value, -1) {
		ip := net.ParseIP(match).To4()
		if ip != nil && (isDefaultDockerBridgeIPv4(ip) || isDockerLikeIPv4(ip)) {
			return true
		}
	}
	return false
}

var embeddedIPv4Pattern = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)

func IsUnreportableHost(value string) bool {
	host := strings.TrimSpace(value)
	if host == "" {
		return false
	}
	if splitHost, _, err := net.SplitHostPort(host); err == nil {
		host = splitHost
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host).To4()
	if ip == nil {
		return false
	}
	return IsUnreportableIPv4(ip)
}

func IsUnreportableIPv4(ip net.IP) bool {
	ipv4 := ip.To4()
	if ipv4 == nil {
		return false
	}
	return isDefaultDockerBridgeIPv4(ipv4) || isDockerInterfaceIPv4(ipv4)
}

func isPrivateIPv4(ip net.IP) bool {
	ipv4 := ip.To4()
	if ipv4 == nil {
		return false
	}
	return ipv4[0] == 10 || (ipv4[0] == 172 && ipv4[1] >= 16 && ipv4[1] <= 31) || (ipv4[0] == 192 && ipv4[1] == 168)
}

func isDockerLikeIPv4(ip net.IP) bool {
	ipv4 := ip.To4()
	if ipv4 == nil {
		return false
	}
	// Docker's default pools commonly allocate 172.17.0.0/16 upward. Keep
	// SelectReachableIPv4 conservative by also requiring interface evidence, but
	// use this for stale auto-generated display names that already embedded a
	// container bridge address.
	return ipv4[0] == 172 && ipv4[1] >= 17 && ipv4[1] <= 31
}

func looksLikePhysicalInterface(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	physicalPrefixes := []string{"eth", "en", "wl", "ww", "ib", "sl"}
	for _, prefix := range physicalPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func looksLikeTunnelOrVPNInterface(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	prefixes := []string{"tun", "tap", "tailscale", "zt", "wg", "utun", "ppp", "ipsec", "singbox", "clash", "mihomo", "flylayer"}
	for _, prefix := range prefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func isDockerInterfaceIPv4(target net.IP) bool {
	target = target.To4()
	if target == nil {
		return false
	}
	for _, candidate := range interfaceIPv4Candidates() {
		if !looksLikeContainerOrBridgeInterface(candidate.Name) {
			continue
		}
		ip := net.ParseIP(strings.TrimSpace(candidate.IP)).To4()
		if ip != nil && ip.Equal(target) {
			return true
		}
	}
	return false
}

func looksLikeContainerOrBridgeInterface(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	prefixes := []string{"docker", "br-", "veth", "virbr", "podman", "cni", "flannel", "cilium", "kube", "nerdctl", "containerd"}
	for _, prefix := range prefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func isDefaultDockerBridgeIPv4(ip net.IP) bool {
	ipv4 := ip.To4()
	if ipv4 == nil {
		return false
	}
	return ipv4[0] == 172 && (ipv4[1] == 17 || ipv4[1] == 18)
}

func ipFromAddr(addr net.Addr) net.IP {
	switch value := addr.(type) {
	case *net.IPNet:
		return value.IP
	case *net.IPAddr:
		return value.IP
	default:
		return nil
	}
}
