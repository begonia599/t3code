// sync-ssh-shim is Mutagen's native SSH transport, not a general SSH client.
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Wire protocol shared with apps/desktop/src/sync/protocol.ts:
// uint8 kind, uint32 big-endian payload length, payload (maximum 64 KiB).
// EOF has no payload; exit is a uint32 big-endian status (0..255).
const (
	stdinData  byte = 1
	stdinEOF   byte = 2
	stdoutData byte = 3
	stderrData byte = 4
	exitStatus byte = 5
	relayError byte = 6
	maxPayload      = 64 * 1024
)

type header struct {
	Version int    `json:"v"`
	Token   string `json:"token"`
	Host    string `json:"host"`
	Command string `json:"command"`
}

func parseArgs(args []string) (string, string, error) {
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		arg := args[0]
		args = args[1:]
		if arg == "-p" {
			if len(args) == 0 {
				return "", "", errors.New("missing SSH port")
			}
			port, err := strconv.Atoi(args[0])
			args = args[1:]
			if err != nil || port < 1 || port > 65535 {
				return "", "", errors.New("invalid SSH port")
			}
		} else if strings.HasPrefix(arg, "-o") {
			pair := strings.SplitN(strings.TrimPrefix(arg, "-o"), "=", 2)
			if len(pair) != 2 {
				return "", "", errors.New("invalid SSH option")
			}
			switch pair[0] {
			case "ConnectTimeout", "ServerAliveInterval", "ServerAliveCountMax":
			default:
				return "", "", fmt.Errorf("unsupported SSH option: %s", pair[0])
			}
			n, err := strconv.Atoi(pair[1])
			if err != nil || n <= 0 {
				return "", "", errors.New("invalid SSH option value")
			}
		} else {
			return "", "", fmt.Errorf("unsupported SSH argument: %s", arg)
		}
	}
	if len(args) != 2 || args[1] == "" {
		return "", "", errors.New("expected host and one remote command argument")
	}
	host := args[0]
	if at := strings.IndexByte(host, '@'); at >= 0 {
		if at == 0 {
			return "", "", errors.New("empty SSH user")
		}
		host = host[at+1:]
	}
	if host == "" || strings.ContainsAny(host, ":@/\\ \t\r\n") || strings.HasPrefix(host, "-") {
		return "", "", errors.New("invalid SSH host")
	}
	return host, args[1], nil
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
func writeFrame(w io.Writer, kind byte, data []byte) error {
	if len(data) > maxPayload {
		return errors.New("frame too large")
	}
	var prefix [5]byte
	prefix[0] = kind
	binary.BigEndian.PutUint32(prefix[1:], uint32(len(data)))
	if err := writeAll(w, prefix[:]); err != nil {
		return err
	}
	return writeAll(w, data)
}
func readFrame(r io.Reader) (byte, []byte, error) {
	var prefix [5]byte
	if _, err := io.ReadFull(r, prefix[:]); err != nil {
		return 0, nil, err
	}
	size := binary.BigEndian.Uint32(prefix[1:])
	if size > maxPayload {
		return 0, nil, errors.New("frame too large")
	}
	data := make([]byte, int(size))
	_, err := io.ReadFull(r, data)
	return prefix[0], data, err
}

func run() (int, error) {
	if strings.EqualFold(strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe"), "scp") {
		return 255, errors.New("T3 synchronization does not install agents via scp; preinstall Mutagen agent 0.18.1 on the server")
	}
	host, command, err := parseArgs(os.Args[1:])
	if err != nil {
		return 255, err
	}
	address, token := os.Getenv("T3_SYNC_RELAY_ADDR"), os.Getenv("T3_SYNC_RELAY_TOKEN")
	ip, port, err := net.SplitHostPort(address)
	if err != nil || ip != "127.0.0.1" || port == "0" || token == "" {
		return 255, errors.New("missing or invalid T3 loopback relay configuration")
	}
	conn, err := net.DialTimeout("tcp4", address, 5*time.Second)
	if err != nil {
		return 255, err
	}
	defer conn.Close()
	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := json.NewEncoder(conn).Encode(header{1, token, host, command}); err != nil {
		return 255, err
	}
	conn.SetWriteDeadline(time.Time{})
	go func() {
		buffer := make([]byte, maxPayload)
		for {
			n, err := os.Stdin.Read(buffer)
			if n > 0 {
				if e := writeFrame(conn, stdinData, buffer[:n]); e != nil {
					conn.Close()
					return
				}
			}
			if err == io.EOF {
				if e := writeFrame(conn, stdinEOF, nil); e != nil {
					conn.Close()
				}
				return
			}
			if err != nil {
				conn.Close()
				return
			}
		}
	}()
	// Mutagen only drains stderr after a failed handshake. Buffer diagnostics so a
	// full stderr pipe cannot stall stdout during a successful synchronization.
	var diagnostics []byte
	defer func() {
		// A failed handshake must observe stdout EOF before it drains stderr.
		_ = os.Stdout.Close()
		if len(diagnostics) > 0 {
			_ = writeAll(os.Stderr, diagnostics)
		}
	}()
	for {
		kind, data, err := readFrame(conn)
		if err != nil {
			return 255, fmt.Errorf("relay disconnected before exit: %w", err)
		}
		switch kind {
		case stdoutData:
			if err := writeAll(os.Stdout, data); err != nil {
				return 255, err
			}
		case stderrData:
			remaining := 32*1024 - len(diagnostics)
			if len(data) > remaining {
				data = data[:remaining]
			}
			diagnostics = append(diagnostics, data...)
		case exitStatus:
			if len(data) != 4 || binary.BigEndian.Uint32(data) > 255 {
				return 255, errors.New("invalid exit frame")
			}
			return int(binary.BigEndian.Uint32(data)), nil
		case relayError:
			return 255, errors.New(string(data))
		default:
			return 255, errors.New("unexpected relay frame")
		}
	}
}
func main() {
	code, err := run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "T3 sync:", err)
	}
	os.Exit(code)
}
