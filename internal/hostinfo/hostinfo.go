package hostinfo

import (
	"fmt"
	"net"
	"os"
	"strings"
)

func DisplayName() string {
	hostname := strings.TrimSpace(hostnameOrFallback())
	ip := defaultOutboundIPv4()
	if ip == "" {
		ip = firstNonLoopbackIPv4()
	}
	if ip == "" {
		return hostname
	}
	return fmt.Sprintf("%s (%s)", hostname, ip)
}

func ResolveDeviceName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || name == "Local Machine" {
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
	return addr.IP.String()
}

func firstNonLoopbackIPv4() string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
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
				return ipv4.String()
			}
		}
	}
	return ""
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
