package main

import "testing"

func TestParseWorkerdOptions(t *testing.T) {
	for _, testCase := range []struct {
		name         string
		args         []string
		binary       string
		experimental bool
	}{
		{"default", []string{"--workerd-binary", "/private/workerd"}, "/private/workerd", false},
		{"equals", []string{"--workerd-binary=/private/workerd"}, "/private/workerd", false},
		{"candidate", []string{"--workerd-binary", "/private/workerd", "--experimental-workerd-candidate"}, "/private/workerd", true},
		{"candidate-equals", []string{"--workerd-binary=/private/workerd", "--experimental-workerd-candidate"}, "/private/workerd", true},
		{"missing", nil, "", false},
		{"missing-binary", []string{"--experimental-workerd-candidate"}, "", false},
		{"empty-binary", []string{"--workerd-binary", "", "--experimental-workerd-candidate"}, "", false},
		{"false-is-not-a-mode", []string{"--workerd-binary", "/private/workerd", "--experimental-workerd-candidate=false"}, "", false},
		{"duplicate", []string{"--workerd-binary", "/private/workerd", "--experimental-workerd-candidate", "--experimental-workerd-candidate"}, "", false},
		{"arbitrary-arg", []string{"--workerd-binary", "/private/workerd", "--inspect"}, "", false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			options, err := parseWorkerdOptions(testCase.args)
			if testCase.binary == "" {
				if err == nil {
					t.Fatal("expected invalid CLI arguments to be rejected")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if options.WorkerdBinary != testCase.binary || options.ExperimentalWorkerdCandidate != testCase.experimental {
				t.Fatalf("unexpected options: %#v", options)
			}
		})
	}
}
