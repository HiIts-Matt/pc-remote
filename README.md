# pc-remote

Remotely wake and shut down a PC from anywhere, over Tailscale, from an iOS
Shortcut and home-screen widget — with a small Raspberry Pi service doing all
the actual work (Wake-on-LAN, SSH, polling for confirmation) so the phone
stays a dumb controller/display.

## How it works

- A Node.js HTTP server (`server.js`) runs on a Raspberry Pi (or any
  always-on Linux box on the same LAN as the target PC), bound to
  `127.0.0.1:8765` only.
- [`tailscale serve`](https://tailscale.com/kb/1312/serve) proxies that local
  port to an HTTPS URL reachable from anywhere on your tailnet — no port
  forwarding, no public exposure. A shared token (`token.txt`, never
  committed) is checked on every request as defense-in-depth on top of that.
- `GET /wake` sends a Wake-on-LAN magic packet, then polls the target's SSH
  port until it responds.
- `GET /shutdown` SSHes into the target and runs a shutdown command, then
  polls ICMP ping until it stops responding.
- Both endpoints return immediately after *triggering* the action — they
  don't block until it completes. A single merged state machine
  (`GET /pc-status`) tracks the current state (`ready`, `powered-off`,
  `booting-up`, `shutting-down`, `unknown`) so a phone widget can poll a
  cheap, pre-computed status instead of the Pi doing a live check on every
  widget refresh.
- An idle background poll on the Pi (every 30s) keeps `ready`/`powered-off`
  accurate even if the PC's power state changes outside of this app.
- `scriptable-widget.js` is a [Scriptable](https://scriptable.app) script for
  an iOS home-screen widget that reads `/pc-status` and displays it.

## Prerequisites

- A Raspberry Pi (or similar always-on Linux box) on the same LAN as the
  target PC, with [Tailscale](https://tailscale.com) installed and signed in.
- [Node.js](https://nodejs.org) 20+ on that Pi.
- The target PC also signed into the same tailnet, with:
  - Wake-on-LAN enabled (see below).
  - An SSH server running, with key-based auth set up for a user that can
    trigger a shutdown.

### Windows target PC setup

1. **Enable Wake-on-LAN**: in BIOS/UEFI, enable "Wake on LAN" / "Power On by
   PCI-E". In Windows, Device Manager → your network adapter → Properties →
   Power Management → check "Allow this device to wake the computer", and
   under the Advanced tab enable "Wake on Magic Packet". Also disable Fast
   Startup (Control Panel → Power Options → "Choose what the power button
   does" → uncheck "Turn on fast startup") — it can prevent WOL from working
   after a shutdown.
2. **Enable OpenSSH Server**: Settings → Apps → Optional Features → Add a
   feature → "OpenSSH Server". Start the `sshd` service and set it to start
   automatically (`Set-Service sshd -StartupType Automatic` in an admin
   PowerShell).
3. **Add your SSH public key**: generate a keypair on the Pi (see below) and
   append the **public** key to `C:\Users\<user>\.ssh\authorized_keys` on the
   target PC (or `C:\ProgramData\ssh\administrators_authorized_keys` if the
   SSH user is a local administrator — that file needs its ACLs restricted to
   `Administrators` and `SYSTEM` only, or `sshd` will reject it).

## Setup

1. Clone this repo onto the Pi, e.g. to `~/pc-remote`.

2. **Generate an SSH keypair** dedicated to this (don't reuse an existing
   one):
   ```
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_yourpc -N ""
   ```
   Copy the `.pub` file's contents to the target PC's `authorized_keys` as
   described above.

3. **Create `token.txt`** — a random secret the phone will pass on every
   request:
   ```
   openssl rand -hex 32 > token.txt
   chmod 600 token.txt
   ```

4. **Create `config.json`** from the example and fill in your own values:
   ```
   cp config.example.json config.json
   ```

   | Field | Where to find it |
   |---|---|
   | `targetMac` | On the target PC: `ipconfig /all`, find the "Physical Address" of the network adapter it'll wake on. Must be the same adapter Wake-on-LAN was enabled on. |
   | `broadcastIp` | The LAN broadcast address of the subnet the PC is on — usually `<your-subnet>.255` (e.g. `192.168.1.255` for a `192.168.1.0/24` network). Confirm on the Pi with `ip -4 addr show <interface>` and check the `brd` field. |
   | `sshHost` | The target PC's Tailscale MagicDNS hostname. Once it's signed into your tailnet, run `tailscale status` on the Pi to see it, or check the [admin console](https://login.tailscale.com/admin/machines). |
   | `sshUser` | The Windows account username you'll SSH in as (the one whose `authorized_keys` you set up above). |
   | `sshKeyPath` | Path to the private key from step 2, e.g. `~/.ssh/id_ed25519_yourpc`. |

5. **Expose the server over your tailnet**:
   ```
   sudo tailscale serve --bg 8765
   ```
   Run `tailscale serve status` to see the HTTPS URL it's now reachable at —
   that's the `BASE_URL` you'll use in the widget script and Shortcut.

6. **Install as a systemd service** so it survives reboots:
   ```
   sudo cp pc-remote.service.example /etc/systemd/system/pc-remote.service
   sudo $EDITOR /etc/systemd/system/pc-remote.service   # fill in your user/paths
   sudo systemctl daemon-reload
   sudo systemctl enable --now pc-remote.service
   ```

## API

All endpoints require `?token=<contents of token.txt>` and return JSON.

| Endpoint | Effect |
|---|---|
| `GET /wake` | Sends a WOL packet if currently `powered-off`/`unknown`; no-op otherwise. |
| `GET /shutdown` | SSHes in and shuts down if currently `ready`/`unknown`; no-op otherwise. |
| `GET /pc-status` | Reads the cached state — no live check, always fast. |

Response shape:
```json
{ "state": "booting-up", "since": 1752514200000, "checkedAt": 1752514230000, "error": null }
```

`state` is one of `unknown`, `ready`, `powered-off`, `booting-up`,
`shutting-down`. `error` is non-null only after a timed-out or failed
transition (e.g. the SSH shutdown command itself failed), and clears on the
next successful state change.

## Widget

`scriptable-widget.js` is a [Scriptable](https://scriptable.app) script for
an iOS home-screen widget:

1. Install Scriptable, create a new script, paste in the contents of
   `scriptable-widget.js`.
2. Replace the `BASE_URL` placeholder at the top with your own tailnet URL
   from step 5 above.
3. Run it once manually (not as a widget) — it'll prompt for your token and
   store it in iOS Keychain.
4. Add a Scriptable widget to your home screen and set its script to this one.

It only ever reads the cached `/pc-status` — no live SSH/ping check happens
on the phone, since widget refresh execution budgets are too tight for that
and iOS's own refresh scheduling is opportunistic (typically every 15–70+
minutes, not something you can force from outside).

## Shortcut

Not included as a portable file (Shortcuts don't export cleanly to a repo),
but the pattern: call `/wake` or `/shutdown`, check the immediate `state` in
the response — if it's already the target state, it was a no-op, notify and
stop. Otherwise poll `/pc-status` every few seconds until `state` is no
longer `booting-up`/`shutting-down`, then notify based on the final state
and `error` field.
