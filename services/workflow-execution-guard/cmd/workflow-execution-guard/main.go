package main

import (
	"fmt"
	"os"

	"github.com/tako0614/takoserver/services/workflow-execution-guard"
)

func main() {
	options, err := parseWorkerdOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	options.In, options.Out = os.Stdin, os.Stdout
	if err := guard.Run(options); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func parseWorkerdOptions(args []string) (guard.Options, error) {
	options := guard.Options{}
	if len(args) > 0 && args[len(args)-1] == "--experimental-workerd-candidate" {
		options.ExperimentalWorkerdCandidate = true
		args = args[:len(args)-1]
	}
	binary, err := parseWorkerdBinary(args)
	if err != nil {
		return guard.Options{}, err
	}
	options.WorkerdBinary = binary
	return options, nil
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
	return "", fmt.Errorf("usage: workflow-execution-guard --workerd-binary /absolute/path [--experimental-workerd-candidate]")
}
