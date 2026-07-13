package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"sync"
	"time"
)

func main() {
	// Start a process that spawns a long-running grandchild process inheriting stdout
	cmd := exec.Command("bash", "-c", "echo 'hello'; (sleep 100 >&1) &")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fmt.Println("pipe err:", err)
		return
	}

	if err := cmd.Start(); err != nil {
		fmt.Println("start err:", err)
		return
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stdout)
		fmt.Println("Scanner starting...")
		for scanner.Scan() {
			fmt.Println("Scan line:", scanner.Text())
		}
		fmt.Println("Scanner done, err:", scanner.Err())
	}()

	time.Sleep(1 * time.Second)
	fmt.Println("cmd.Wait starting...")
	err = cmd.Wait()
	fmt.Println("cmd.Wait done, err:", err)

	fmt.Println("Closing stdout...")
	closeErr := stdout.Close()
	fmt.Println("Close stdout done, err:", closeErr)

	fmt.Println("Waiting for wg...")
	wg.Wait()
	fmt.Println("All done!")
}
