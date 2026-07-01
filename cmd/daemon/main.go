package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"remote-agent/internal/daemon"
	"remote-agent/internal/protocol"
)

type stringList []string

func (l *stringList) String() string {
	return strings.Join(*l, ",")
}

func (l *stringList) Set(value string) error {
	*l = append(*l, value)
	return nil
}

func main() {
	cfg, err := configFromFlags()
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	d := daemon.New(cfg)
	log.Printf("PocketStudio daemon %s connecting to %s", cfg.Device.ID, cfg.Server.URL)
	if err := d.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}

func configFromFlags() (daemon.Config, error) {
	cfg := daemon.DefaultConfig()
	var workspaceValues stringList
	var acpxArgs string
	var claudeArgs string

	flag.StringVar(&cfg.Device.ID, "daemon.device.id", cfg.Device.ID, "device id reported to server")
	flag.StringVar(&cfg.Device.Name, "daemon.device.name", cfg.Device.Name, "device display name")
	flag.StringVar(&cfg.Server.URL, "daemon.server.url", cfg.Server.URL, "required server websocket URL, for example ws://host:18080/ws/daemon")
	flag.StringVar(&cfg.Server.Token, "daemon.server.token", cfg.Server.Token, "required server access token")
	flag.Var(&workspaceValues, "daemon.workspace", "workspace path or id:name:path; may be repeated")
	flag.BoolVar(&cfg.ACPX.Enabled, "daemon.acpx.enabled", cfg.ACPX.Enabled, "enable acpx agent execution")
	flag.StringVar(&cfg.ACPX.Command, "daemon.acpx.command", cfg.ACPX.Command, "acpx command")
	flag.StringVar(&cfg.ACPX.Agent, "daemon.acpx.agent", cfg.ACPX.Agent, "default acpx agent")
	flag.StringVar(&cfg.ACPX.SessionName, "daemon.acpx.session-name", cfg.ACPX.SessionName, "default acpx session name")
	flag.IntVar(&cfg.ACPX.TTLSeconds, "daemon.acpx.ttl-seconds", cfg.ACPX.TTLSeconds, "acpx session ttl in seconds")
	flag.IntVar(&cfg.ACPX.CommandTimeoutSeconds, "daemon.acpx.command-timeout-seconds", cfg.ACPX.CommandTimeoutSeconds, "maximum seconds to wait for an acpx session or prompt command; 0 disables the daemon-side timeout")
	flag.StringVar(&acpxArgs, "daemon.acpx.args", strings.Join(cfg.ACPX.Args, ","), "comma-separated acpx global args")
	flag.BoolVar(&cfg.DirectWeb.Enabled, "daemon.direct-web.enabled", cfg.DirectWeb.Enabled, "enable daemon direct websocket server for Studio terminal connections")
	flag.StringVar(&cfg.DirectWeb.ListenAddr, "daemon.direct-web.listen", cfg.DirectWeb.ListenAddr, "daemon direct websocket listen address")
	flag.StringVar(&cfg.DirectWeb.PublicHost, "daemon.direct-web.public-host", cfg.DirectWeb.PublicHost, "host/IP advertised for daemon direct websocket connections; defaults to reachable non-Docker IPv4")
	flag.StringVar(&cfg.DirectWeb.Token, "daemon.direct-web.token", cfg.DirectWeb.Token, "token required by daemon direct websocket connections; auto-generated when empty")
	flag.StringVar(&cfg.Claude.Command, "daemon.claude.command", cfg.Claude.Command, "claude command")
	flag.StringVar(&claudeArgs, "daemon.claude.args", strings.Join(cfg.Claude.Args, ","), "comma-separated claude args")
	flag.Parse()

	if len(workspaceValues) > 0 {
		workspaces, err := parseWorkspaces(workspaceValues)
		if err != nil {
			return cfg, err
		}
		cfg.Workspaces = workspaces
	}
	cfg.ACPX.Args = splitArgs(acpxArgs)
	cfg.Claude.Args = splitArgs(claudeArgs)
	return daemon.NormalizeConfig(cfg)
}

func parseWorkspaces(values []string) ([]protocol.Workspace, error) {
	workspaces := make([]protocol.Workspace, 0, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		parts := strings.SplitN(value, ":", 3)
		if len(parts) == 3 {
			workspaces = append(workspaces, protocol.Workspace{
				ID:   strings.TrimSpace(parts[0]),
				Name: strings.TrimSpace(parts[1]),
				Path: expandPath(strings.TrimSpace(parts[2])),
			})
			continue
		}
		path := expandPath(value)
		name := filepath.Base(path)
		if name == "." || name == string(filepath.Separator) || name == "" {
			name = path
		}
		workspaces = append(workspaces, protocol.Workspace{
			ID:   "workspace-" + strconv.Itoa(len(workspaces)+1),
			Name: name,
			Path: path,
		})
	}
	if len(workspaces) == 0 {
		return nil, fmt.Errorf("daemon.workspace must not be empty")
	}
	return workspaces, nil
}

func splitArgs(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	args := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			args = append(args, part)
		}
	}
	return args
}

func expandPath(path string) string {
	if path == "~" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			return home
		}
	}
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			return filepath.Join(home, strings.TrimPrefix(path, "~/"))
		}
	}
	return path
}
