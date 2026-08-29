# LAN Mouse — sharing one keyboard/mouse between the Linux dev laptop and the Windows game laptop

We use [LAN Mouse](https://github.com/feschber/lan-mouse) (software KVM over the LAN) so the Linux laptop's
keyboard/mouse also drive the Windows game laptop (`ZEQUENCE107`), which sits to the **right** of the Linux screen.
The Windows side stays as it is; this page rebuilds the **Linux** side after a reinstall.

## What the working setup looks like (captured 2026-08-29, Arch/Omarchy, Hyprland)

- Package: `lan-mouse` 0.11.0 from the official `extra` repo (`sudo pacman -S lan-mouse`).
- Daemon runs as a **user systemd service** tied to the graphical session (Wayland/Hyprland: the emulation backend
  talks to the compositor and the capture portal needs the session bus, so it must start after the session exists).
- Listens on **UDP 4242** (default). No firewall is active on the Linux side (ufw inactive). If you enable one later, allow UDP 4242 in.
- Pairing is by **TLS certificate fingerprint** in both directions. The Linux identity is `~/.config/lan-mouse/lan-mouse.pem`
  (private, mode 400). **Back it up before wiping** and restore it: then the Windows side keeps trusting this laptop and
  nothing needs re-pairing. Its SHA-256 fingerprint (the one the Windows side has authorized) is:
  `D9:AF:ED:FA:C0:A4:93:5F:2E:67:3F:54:F1:B5:B2:D3:74:E4:53:02:69:AD:24:CC:00:F2:5B:73:77:15:5C:CA`
- The Windows laptop's fingerprint (authorized on the Linux side) is
  `2a:ec:3b:3b:0e:aa:53:1b:43:96:33:31:ef:57:f2:a4:07:f7:1b:21:12:55:ae:0f:4d:21:45:5a:3c:76:13:74`, hostname `ZEQUENCE107`,
  LAN IP `192.168.4.86` (DHCP — check with `ipconfig` on Windows if it moved).

## Fresh Linux install — steps

1. Install and create the config:
   ```sh
   sudo pacman -S lan-mouse
   mkdir -p ~/.config/lan-mouse ~/.config/systemd/user
   ```
2. If you have the backup, restore the identity certificate (skips re-pairing on Windows):
   ```sh
   cp /path/to/backup/lan-mouse.pem ~/.config/lan-mouse/lan-mouse.pem && chmod 400 ~/.config/lan-mouse/lan-mouse.pem
   ```
   Without the backup, the daemon generates a new `lan-mouse.pem` on first start; you then have to authorize the **new**
   Linux fingerprint on the Windows side (LAN Mouse app → the incoming connection prompt / Authorized fingerprints).
3. `~/.config/lan-mouse/config.toml`:
   ```toml
   [[clients]]
   hostname = "ZEQUENCE107"
   ips = ["192.168.4.86"]
   position = "right"
   activate_on_startup = true

   [authorized_fingerprints]
   "2a:ec:3b:3b:0e:aa:53:1b:43:96:33:31:ef:57:f2:a4:07:f7:1b:21:12:55:ae:0f:4d:21:45:5a:3c:76:13:74" = "ZEQUENCE107"
   ```
4. `~/.config/systemd/user/lan-mouse.service`:
   ```ini
   [Unit]
   Description=lan-mouse - share keyboard and mouse across computers
   Documentation=https://github.com/feschber/lan-mouse
   # The wlroots emulation backend talks to the compositor directly and the
   # capture portal needs the session bus, so this only makes sense once the
   # graphical session exists. default.target can be reached before it does.
   PartOf=graphical-session.target
   After=graphical-session.target

   [Service]
   Type=simple
   ExecStart=/usr/bin/lan-mouse daemon
   Restart=on-failure
   RestartSec=2

   [Install]
   WantedBy=graphical-session.target
   ```
   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now lan-mouse.service
   systemctl --user status lan-mouse.service      # active (running); `ss -lunp | grep 4242` shows the socket
   ```
5. On Windows nothing changes: the LAN Mouse app is already installed, running, and has the Linux fingerprint authorized
   (if you restored the .pem) — move the mouse off the right edge of the Linux screen and it appears on the Windows laptop.
   If Windows shows a new "unknown fingerprint" prompt, accept it (that means step 2 was skipped).

## Troubleshooting

- Cursor doesn't cross: confirm both machines are on the same LAN and the IP in `config.toml` is current; `journalctl --user -u lan-mouse -f`.
- Works only after a relogin: the unit is bound to `graphical-session.target` — that's expected; it starts with Hyprland.
- Fingerprint mismatch after a Linux reinstall without the .pem backup: re-authorize on Windows, then the Windows entry above stays valid.
- Keyboard layout oddities on the Windows side are a LAN Mouse limitation (it sends key codes); set the same layout on both.
- Version drift: keep both sides on the same LAN Mouse minor version (protocol changes between releases).
