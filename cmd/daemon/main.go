package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"remote-agent/internal/daemon"
)

func main() {
	configPath := flag.String("config", "agentbridge.daemon.json", "daemon config path")
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	d := daemon.New(cfg)
	log.Printf("AgentBridge daemon %s connecting to %s", cfg.Device.ID, cfg.Server.URL)
	if err := d.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
