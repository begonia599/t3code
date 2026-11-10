package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

func TestParseArgs(t *testing.T) {
	command := ".mutagen/agents/0.18.1/mutagen-agent synchronizer --log-level=info"
	for _, args := range [][]string{{"t3-host", command}, {"-oConnectTimeout=5", "-oServerAliveInterval=10", "-oServerAliveCountMax=1", "-p", "22", "user@t3-host", command}} {
		host, got, err := parseArgs(args)
		if err != nil || host != "t3-host" || got != command {
			t.Fatalf("%q: %q %q %v", args, host, got, err)
		}
	}
	for _, args := range [][]string{{}, {"host"}, {"-T", "host", command}, {"-oProxyCommand=x", "host", command}, {"-oConnectTimeout=0", "host", command}, {"-p"}, {"-p", "65536", "host", command}, {"a@b@c", command}, {"host:22", command}, {"host", command, "extra"}} {
		if _, _, err := parseArgs(args); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
}
func TestFrames(t *testing.T) {
	var wire bytes.Buffer
	payload := bytes.Repeat([]byte{0, 255, 13, 10}, maxPayload/4)
	if err := writeFrame(&wire, stdinData, payload); err != nil {
		t.Fatal(err)
	}
	if err := writeFrame(&wire, stdinEOF, nil); err != nil {
		t.Fatal(err)
	}
	kind, got, err := readFrame(&wire)
	if err != nil || kind != stdinData || !bytes.Equal(got, payload) {
		t.Fatal("binary roundtrip", err)
	}
	kind, got, err = readFrame(&wire)
	if err != nil || kind != stdinEOF || len(got) != 0 {
		t.Fatal("EOF", err)
	}
	if _, _, err = readFrame(&wire); err != io.EOF {
		t.Fatal(err)
	}
	if err := writeFrame(&wire, stdinData, make([]byte, maxPayload+1)); err == nil {
		t.Fatal("accepted oversized frame")
	}
	prefix := make([]byte, 5)
	binary.BigEndian.PutUint32(prefix[1:], maxPayload+1)
	if _, _, err := readFrame(bytes.NewReader(prefix)); err == nil {
		t.Fatal("accepted oversized input")
	}
	for _, data := range [][]byte{{1}, {1, 0, 0, 0, 2, 7}} {
		if _, _, err := readFrame(bytes.NewReader(data)); err == nil {
			t.Fatal("accepted truncated frame")
		}
	}
}
