package main

import (
	"fmt"
	"os"

	"github.com/tako0614/takoserver/services/workflow-execution-guard"
)

func main() {
	workerdBinary, err := parseWorkerdBinary(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := guard.Run(guard.Options{
		WorkerdBinary: workerdBinary,
		In:            os.Stdin,
		Out:           os.Stdout,
	}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func parseWorkerdBinary(args []string) (string, error) {
	if len(args) == 2 && args[0] == "--workerd-binary" && args[1] != "" {
		return args[1], nil
	}
	if len(args) == 1 {
		const prefix = "--workerd-binary="
		if len(args[0]) > len(prefix) && args[0][:len(prefix)] == prefix {
			return args[0][len(prefix):], nil
		}
	}
	return "", fmt.Errorf("usage: workflow-execution-guard --workerd-binary /absolute/path")
}
