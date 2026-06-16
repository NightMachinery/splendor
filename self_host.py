#!/usr/bin/env python3
import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / ".self-host"
PORTS_FILE = DATA / "ports.json"
CADDYFILE = Path.home() / "Caddyfile"
APP = "splendor"
DEFAULT_PORTS = {"lobby": 34172, "game": 33402, "dev": 38932}
SESSIONS = {"lobby": "splendor-lobby", "game": "splendor-game", "dev": "splendor-client-dev"}
PROXY_VARS = [
    "ALL_PROXY", "all_proxy", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
    "npm_config_proxy", "npm_config_https_proxy",
]


def run(cmd, cwd=ROOT, env=None):
    print("+", " ".join(map(str, cmd)))
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def capture(cmd, cwd=ROOT):
    return subprocess.check_output(cmd, cwd=cwd, text=True).strip()


def shq(value):
    return "'" + str(value).replace("'", "'\\''") + "'"


def is_macos():
    return platform.system() == "Darwin"


def default_url():
    return f"https://{APP}.pinky.lilf.ir"


def served_url(configured_url, dev=False):
    if dev and is_macos():
        return f"http://127.0.0.1:{ports()['dev']}"
    return configured_url


def parsed_url(url):
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.netloc:
        raise SystemExit("URL must be absolute http:// or https://")
    return u


def env_with_proxy():
    env = os.environ.copy()
    return env


def tmux_env_args(extra_env=None):
    env = {k: v for k, v in os.environ.items() if k in PROXY_VARS and v}
    if extra_env:
        env.update({k: str(v) for k, v in extra_env.items()})
    args = []
    for k, v in env.items():
        args.extend(["-e", f"{k}={v}"])
    return args


def tmux_kill(name):
    subprocess.run(["tmux", "kill-session", "-t", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def tmux_new(name, cmd, cwd=ROOT, extra_env=None):
    # Equivalent to: tmux kill-session -t "$1" || true; tmux new -d -s "$@"
    tmux_kill(name)
    args = ["tmux", "new", "-d", "-s", name]
    args.extend(tmux_env_args(extra_env))
    args.append(f"cd {shq(cwd)} && {cmd}")
    run(args)


def ensure_tools(dev=False):
    required = ["tmux", "caddy", "mvn", "pnpm", "java"]
    if dev:
        required.append("node")
    for tool in required:
        if not shutil.which(tool):
            raise SystemExit(f"Missing required tool: {tool}")


def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        return s.connect_ex(("127.0.0.1", int(port))) == 0


def first_free(start):
    p = int(start)
    while p < 65535:
        if not port_busy(p):
            return p
        p += 1
    raise SystemExit(f"Could not find a free port at or above {start}")


def ports(reset=False):
    DATA.mkdir(exist_ok=True)
    if reset or not PORTS_FILE.exists():
        current = dict(DEFAULT_PORTS)
    else:
        try:
            current = {**DEFAULT_PORTS, **json.loads(PORTS_FILE.read_text())}
        except Exception:
            current = dict(DEFAULT_PORTS)
    changed = False
    for name, default in DEFAULT_PORTS.items():
        if port_busy(current[name]):
            current[name] = first_free(default)
            changed = True
    if changed or reset or not PORTS_FILE.exists():
        PORTS_FILE.write_text(json.dumps(current, indent=2) + "\n")
    return current


def wait_for_http(url, label, timeout=180):
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if 200 <= resp.status < 500:
                    return
        except Exception as exc:
            last_error = exc
        time.sleep(1)
    raise SystemExit(f"Timed out waiting for {label} at {url}: {last_error}")


def caddy_block(url, dev=False):
    p = ports()
    u = parsed_url(url)
    host = u.netloc
    scheme = u.scheme
    other = "http" if scheme == "https" else "https"
    main_addr = f"{scheme}://{host}"
    redir_addr = f"{other}://{host}"
    target = f"{scheme}://{host}{{uri}}"
    static_root = ROOT / "client" / "dist"
    frontend = (
        f"reverse_proxy 127.0.0.1:{p['dev']}"
        if dev
        else f"root * {static_root}\n    try_files {{path}} {{path}}/ /index.html\n    file_server"
    )
    return f"""# BEGIN {APP} self-host managed block
{redir_addr} {{
    redir {target} permanent
}}

{main_addr} {{
    encode gzip zstd
    handle_path /ls/* {{
        reverse_proxy 127.0.0.1:{p['lobby']}
    }}
    handle_path /gs/* {{
        reverse_proxy 127.0.0.1:{p['game']}
    }}
    handle {{
    {frontend.replace(chr(10), chr(10)+'    ')}
    }}
}}
# END {APP} self-host managed block
"""


def update_caddy(url, dev=False):
    if dev and is_macos():
        return
    block = caddy_block(url, dev)
    old = CADDYFILE.read_text() if CADDYFILE.exists() else ""
    pat = re.compile(rf"# BEGIN {APP} self-host managed block.*?# END {APP} self-host managed block\n?", re.S)
    new = pat.sub("", old).rstrip() + "\n\n" + block
    CADDYFILE.write_text(new)
    run(["caddy", "fmt", "--overwrite", str(CADDYFILE)])
    run(["caddy", "reload", "--config", str(CADDYFILE)])


def build(dev=False):
    DATA.mkdir(exist_ok=True)
    client = ROOT / "client"
    if not (client / "pnpm-lock.yaml").exists():
        run(["pnpm", "import"], cwd=client, env=env_with_proxy())
    run(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], cwd=client, env=env_with_proxy())
    run(["pnpm", "dedupe"], cwd=client, env=env_with_proxy())
    if not dev:
        run(["pnpm", "build"], cwd=client, env=env_with_proxy())
    run(["mvn", "-DskipTests", "package"], cwd=ROOT / "server", env=env_with_proxy())
    run(["mvn", "-Psqlite", "-DskipTests", "package"], cwd=ROOT / "setup" / "LobbyService", env=env_with_proxy())


def stop(_args=None):
    for name in SESSIONS.values():
        tmux_kill(name)
    print("Stopped Splendor self-host tmux sessions.")


def start(args, dev=False):
    ensure_tools(dev=dev)
    stop()
    p = ports()
    DATA.mkdir(exist_ok=True)
    (DATA / "saves").mkdir(exist_ok=True)
    update_caddy(args.url, dev=dev)
    lsjar = ROOT / "setup" / "LobbyService" / "target" / "ls.jar"
    gsjar = ROOT / "server" / "target" / "splendorGame.jar"
    missing = [str(x) for x in [lsjar, gsjar] if not x.exists()]
    if missing:
        raise SystemExit("Missing built jar(s). Run ./self_host.py setup first: " + ", ".join(missing))
    common = {"LS_SQLITE_PATH": str(DATA / "lobby.sqlite")}
    tmux_new(
        SESSIONS["lobby"],
        f"java -jar {shq(lsjar)} --server.port={p['lobby']} --api.games.url=/api/sessions/ --spring.profiles.active=sqlite",
        extra_env=common,
    )
    wait_for_http(f"http://127.0.0.1:{p['lobby']}/api/online", "Lobby service")
    tmux_new(
        SESSIONS["game"],
        f"java -jar {shq(gsjar)} --server.port={p['game']} --LS.location=http://127.0.0.1:{p['lobby']} "
        f"--LS.server.password=selfhost_service_token --gs.location=http://127.0.0.1:{p['game']} --save.location={shq(DATA / 'saves')}",
    )
    wait_for_http(f"http://127.0.0.1:{p['game']}/api/online", "Game service")
    if dev:
        tmux_new(SESSIONS["dev"], f"pnpm dev --host 127.0.0.1 --port {p['dev']}", cwd=ROOT / "client")
        wait_for_http(f"http://127.0.0.1:{p['dev']}", "Astro dev server")
    print(f"Started {'dev' if dev else 'prod'} self-host at {served_url(args.url, dev=dev)}")


def setup(args):
    stop()
    ports(reset=True)
    build(dev=False)
    start(args, dev=False)


def redeploy(args):
    stop()
    build(dev=False)
    start(args, dev=False)


def dev_start(args):
    stop()
    build(dev=True)
    start(args, dev=True)


def status(args):
    p = ports()
    print(f"Configured URL: {args.url}")
    print("Ports: " + json.dumps(p, sort_keys=True))
    for key, session in SESSIONS.items():
        alive = subprocess.run(["tmux", "has-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        print(f"{key}: {'running' if alive else 'stopped'} ({session})")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["setup", "redeploy", "start", "stop", "dev-start", "status"])
    parser.add_argument("--url", default=default_url())
    args = parser.parse_args()
    if args.command == "setup": setup(args)
    elif args.command == "redeploy": redeploy(args)
    elif args.command == "start": start(args, dev=False)
    elif args.command == "dev-start": dev_start(args)
    elif args.command == "stop": stop(args)
    elif args.command == "status": status(args)


if __name__ == "__main__":
    main()
