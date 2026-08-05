//go:build windows

package main

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

// enforcerService is the SCM handler. Go's svc package does the SCM control
// dance; we just translate Stop/Shutdown into a context cancel that tells the
// HTTP server to drain and exit.
type enforcerService struct {
	cfg  *Config
	elog *eventlog.Log
}

func (s *enforcerService) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- serve(ctx, s.cfg) }()

	changes <- svc.Status{State: svc.Running, Accepts: accepted}
	if s.elog != nil {
		_ = s.elog.Info(1, fmt.Sprintf("enforcer-node running on %s:%d", s.cfg.Server.Host, s.cfg.Server.Port))
	}

loop:
	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				break loop
			default:
				// ignore other control codes
			}
		case err := <-errCh:
			// Server exited on its own (bind failure etc.) — report + stop so
			// the SCM restart-on-failure policy kicks in.
			if err != nil && s.elog != nil {
				_ = s.elog.Error(1, fmt.Sprintf("enforcer-node server error: %v", err))
			}
			break loop
		}
	}

	changes <- svc.Status{State: svc.StopPending}
	cancel()
	// Give the graceful shutdown a moment to complete.
	select {
	case <-errCh:
	case <-time.After(6 * time.Second):
	}
	return false, 0
}

// runService is entered when the process is launched by the SCM.
func runService(cfg *Config) error {
	elog, err := eventlog.Open(serviceName)
	if err != nil {
		elog = nil
	}
	if elog != nil {
		defer elog.Close()
	}
	return svc.Run(serviceName, &enforcerService{cfg: cfg, elog: elog})
}

// installService registers the binary with the SCM (auto-start, restart on
// failure) and starts it. Requires an elevated (Administrator) prompt.
func installService(exePath, configPath string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	if s, err := m.OpenService(serviceName); err == nil {
		s.Close()
		return fmt.Errorf("service %q already exists — run `uninstall` first", serviceName)
	}

	s, err := m.CreateService(serviceName, exePath, mgr.Config{
		DisplayName: serviceDisplay,
		Description: serviceDesc,
		StartType:   mgr.StartAutomatic,
	}, "run", "--config", configPath)
	if err != nil {
		return err
	}
	defer s.Close()

	// Windows-native self-heal: restart on crash, with escalating delays,
	// resetting the failure counter once a day. This is the Windows analogue
	// of systemd Restart=on-failure / the chroot cron watchdog.
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, 86400); err != nil {
		// Non-fatal: the service still installs, just without auto-restart.
		fmt.Printf("warning: could not set recovery actions: %v\n", err)
	}

	// Register an event-log source so runtime errors land in Event Viewer.
	if err := eventlog.InstallAsEventCreate(serviceName,
		eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
		fmt.Printf("warning: could not register eventlog source: %v\n", err)
	}

	return s.Start("run", "--config", configPath)
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		// Not installed → nothing to do. Idempotent so a pre-install
		// `uninstall` on a fresh box is a clean no-op, not a fatal error.
		fmt.Printf("service %q is not installed — nothing to uninstall\n", serviceName)
		return nil
	}
	defer s.Close()

	// Best-effort stop before delete.
	_, _ = s.Control(svc.Stop)
	time.Sleep(500 * time.Millisecond)

	if err := s.Delete(); err != nil {
		return err
	}
	_ = eventlog.Remove(serviceName)
	return nil
}

func startService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	return s.Start()
}

func stopService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	_, err = s.Control(svc.Stop)
	return err
}

func isWindowsService() bool {
	ok, err := svc.IsWindowsService()
	if err != nil {
		return false
	}
	return ok
}
