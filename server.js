#!/usr/bin/env node
// Minimal HTTP endpoint that remote-controls matts-pc: wakes it via a WOL
// magic packet, or shuts it down over SSH, and tracks a single merged
// power-status state machine for a phone widget.
//
// Binds to 127.0.0.1 only. Reachability from the phone is provided by
// `tailscale serve`, which proxies from the tailnet (HTTPS, tailnet-only)
// to this local port. The token is defense-in-depth on top of that.
//
// State machine (pcStatus.state):
//   unknown       - only during the first few seconds after startup, before
//                   the idle poller has taken its first reading
//   ready         - PC on, SSH reachable, nothing in flight
//   powered-off   - PC unreachable for 2+ consecutive pings, nothing in flight
//   booting-up    - /wake triggered, waiting for SSH to come up
//   shutting-down - /shutdown triggered, waiting for ping to stay down
//
// An idle background poll (every STATUS_POLL_INTERVAL_MS) keeps ready/
// powered-off honest even outside of /wake and /shutdown (e.g. the PC was
// turned on/off some other way). It steps aside while booting-up/
// shutting-down are in flight so it doesn't race the tight poll loops those
// own. Errors and timeouts revert to whatever state was current right
// before the transition started (priorState), since the polling evidence
// gathered during the failed attempt already tells us the PC likely never
// left that state.

"use strict";

const crypto = require("crypto");
const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const HOST = "127.0.0.1";
const PORT = 8765;
const WOL_PORT = 9;
const SSH_PORT = 22;
const SSH_POLL_INTERVAL_MS = 5000;
const SSH_POLL_TIMEOUT_MS = 3000;
const SSH_MAX_WAIT_MS = 600000;
const TOKEN_FILE = path.join(__dirname, "token.txt");
const CONFIG_FILE = path.join(__dirname, "config.json");

const SHUTDOWN_CMD = "shutdown /s /t 5";
const SSH_CONNECT_TIMEOUT_S = 5;
const PING_POLL_INTERVAL_MS = 5000;
const PING_TIMEOUT_S = 2;
const PING_MAX_WAIT_MS = 300000;
const PING_CONSECUTIVE_FAILS_TO_CONFIRM = 2;

const STATUS_POLL_INTERVAL_MS = 30000;

const TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const TARGET_MAC = config.targetMac;
const BROADCAST_IP = config.broadcastIp;
const SSH_HOST = config.sshHost; // resolved over the tailnet via MagicDNS
const SSH_USER = config.sshUser;
const SSH_KEY = config.sshKeyPath.replace(/^~/, os.homedir());

const pcStatus = { state: "unknown", since: Date.now(), checkedAt: null, error: null };
let priorState = null; // state to revert to if the in-flight transition errors or times out

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(newState, { error = null } = {}) {
  const now = Date.now();
  if (pcStatus.state !== newState) {
    pcStatus.since = now;
  }
  pcStatus.state = newState;
  pcStatus.checkedAt = now;
  pcStatus.error = error;
}

function touchChecked() {
  pcStatus.checkedAt = Date.now();
}

function inFlight() {
  return pcStatus.state === "booting-up" || pcStatus.state === "shutting-down";
}

function sendMagicPacket(mac, broadcastIp, port) {
  const macBytes = Buffer.from(mac.replace(/[:-]/g, ""), "hex");
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), Buffer.concat(Array(16).fill(macBytes))]);
  const sock = dgram.createSocket("udp4");
  sock.bind(() => {
    sock.setBroadcast(true);
    sock.send(packet, port, broadcastIp, () => sock.close());
  });
}

function sshIsUp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (up) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function runSshShutdown() {
  return new Promise((resolve) => {
    execFile(
      "ssh",
      [
        "-i", SSH_KEY,
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
        `${SSH_USER}@${SSH_HOST}`,
        SHUTDOWN_CMD,
      ],
      { timeout: (SSH_CONNECT_TIMEOUT_S + 10) * 1000 },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed) {
            resolve({ ok: false, error: "ssh command timed out" });
            return;
          }
          resolve({ ok: false, error: (stderr || stdout || "ssh exited non-zero").trim() });
          return;
        }
        resolve({ ok: true, error: "" });
      }
    );
  });
}

function pingOnce(host, timeoutS) {
  return new Promise((resolve) => {
    execFile(
      "ping",
      ["-c", "1", "-W", String(timeoutS), host],
      { timeout: (timeoutS + 2) * 1000 },
      (error) => resolve(!error)
    );
  });
}

async function pollBoot() {
  const deadline = Date.now() + SSH_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const attemptStart = Date.now();
    const up = await sshIsUp(SSH_HOST, SSH_PORT, SSH_POLL_TIMEOUT_MS);
    touchChecked();
    if (up) {
      setStatus("ready");
      return;
    }
    const elapsed = Date.now() - attemptStart;
    await sleep(Math.max(0, SSH_POLL_INTERVAL_MS - elapsed));
  }
  if (pcStatus.state === "booting-up") {
    setStatus(priorState || "powered-off", { error: "timed out waiting for boot" });
  }
}

async function pollShutdown() {
  const deadline = Date.now() + PING_MAX_WAIT_MS;
  let consecutiveFails = 0;
  while (Date.now() < deadline) {
    const attemptStart = Date.now();
    const up = await pingOnce(SSH_HOST, PING_TIMEOUT_S);
    consecutiveFails = up ? 0 : consecutiveFails + 1;
    touchChecked();
    if (consecutiveFails >= PING_CONSECUTIVE_FAILS_TO_CONFIRM) {
      setStatus("powered-off");
      return;
    }
    const elapsed = Date.now() - attemptStart;
    await sleep(Math.max(0, PING_POLL_INTERVAL_MS - elapsed));
  }
  if (pcStatus.state === "shutting-down") {
    setStatus(priorState || "ready", { error: "timed out waiting for shutdown" });
  }
}

async function doShutdown() {
  const { ok, error } = await runSshShutdown();
  if (!ok) {
    setStatus(priorState || "ready", { error: `ssh shutdown failed: ${error}` });
    return;
  }
  await pollShutdown();
}

// Idle poller: keeps ready/powered-off accurate outside of /wake and
// /shutdown. Steps aside while a transition owns pcStatus, and re-checks
// after each await in case a transition started mid-tick.
let idleConsecutiveFails = 0;

async function idlePollTick() {
  if (inFlight()) return;
  const up = await sshIsUp(SSH_HOST, SSH_PORT, SSH_POLL_TIMEOUT_MS);
  if (inFlight()) return;
  if (up) {
    idleConsecutiveFails = 0;
    setStatus("ready");
    return;
  }
  const pingUp = await pingOnce(SSH_HOST, PING_TIMEOUT_S);
  if (inFlight()) return;
  if (pingUp) {
    // network-reachable but SSH not open: ambiguous (e.g. mid-boot outside
    // our own /wake flow, or SSH briefly down) - don't flip state on this
    idleConsecutiveFails = 0;
    touchChecked();
    return;
  }
  idleConsecutiveFails += 1;
  touchChecked();
  if (idleConsecutiveFails >= PING_CONSECUTIVE_FAILS_TO_CONFIRM) {
    setStatus("powered-off");
  }
}

async function idlePollLoop() {
  for (;;) {
    await idlePollTick();
    await sleep(STATUS_POLL_INTERVAL_MS);
  }
}

function tokenMatches(supplied) {
  const suppliedHash = crypto.createHash("sha256").update(supplied).digest();
  const tokenHash = crypto.createHash("sha256").update(TOKEN).digest();
  return crypto.timingSafeEqual(suppliedHash, tokenHash);
}

function respondStatus(res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(pcStatus));
}

function handleWake(req, res) {
  if (pcStatus.state === "powered-off" || pcStatus.state === "unknown") {
    priorState = pcStatus.state;
    setStatus("booting-up");
    sendMagicPacket(TARGET_MAC, BROADCAST_IP, WOL_PORT);
    pollBoot();
  }
  respondStatus(res);
}

function handleShutdown(req, res) {
  if (pcStatus.state === "ready" || pcStatus.state === "unknown") {
    priorState = pcStatus.state;
    setStatus("shutting-down");
    doShutdown();
  }
  respondStatus(res);
}

function handlePcStatus(req, res) {
  respondStatus(res);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const supplied = parsed.searchParams.get("token") || "";
  if (!tokenMatches(supplied)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  if (parsed.pathname === "/wake") {
    handleWake(req, res);
  } else if (parsed.pathname === "/shutdown") {
    handleShutdown(req, res);
  } else if (parsed.pathname === "/pc-status") {
    handlePcStatus(req, res);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, HOST);
idlePollLoop();
