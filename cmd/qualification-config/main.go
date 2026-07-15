package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"remote-agent/internal/daemon"
)

func main() {
	execAgent := flag.String("exec-agent", "", "execute one normalized agent configuration")
	flag.Parse()
	agents, err := daemon.LoadQualificationAgentConfigs()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if *execAgent != "" {
		agent, ok := agents[*execAgent]
		if !ok {
			fmt.Fprintf(os.Stderr, "unknown agent %q\n", *execAgent)
			os.Exit(2)
		}
		cmd := exec.Command(agent.Command, agent.Args...)
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Env = make([]string, 0, len(os.Environ())+len(agent.Env))
		for _, entry := range os.Environ() {
			key, _, _ := strings.Cut(entry, "=")
			if _, overridden := agent.Env[key]; !overridden {
				cmd.Env = append(cmd.Env, entry)
			}
		}
		for key, value := range agent.Env {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
		if err := cmd.Run(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := json.NewEncoder(os.Stdout).Encode(agents); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
