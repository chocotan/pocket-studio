package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"remote-agent/internal/appconfig"
	"remote-agent/internal/daemon"
)

func main() {
	configPath := flag.String("config", "agentbridge.daemon.json", "daemon config path")
	clientConfigPath := flag.String("client-config", "", "client config path; server_url overrides daemon server.url when set")
	initConfig := flag.Bool("init-config", false, "write an example config and exit")
	flag.Parse()

	if *initConfig {
		if err := daemon.WriteExampleConfig(*configPath); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("wrote %s\n", *configPath)
		return
	}

	cfg, err := daemon.LoadConfig(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	if *clientConfigPath != "" {
		clientCfg, err := appconfig.Load(*clientConfigPath)
		if err != nil {
			log.Fatal(err)
		}
		daemonURL, err := appconfig.DaemonWebSocketURL(clientCfg.ServerURL)
		if err != nil {
			log.Fatal(err)
		}
		cfg.Server.URL = daemonURL
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	d := daemon.New(cfg)
	log.Printf("PocketStudio daemon %s connecting to %s", cfg.Device.ID, cfg.Server.URL)
	if err := d.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
