#!/usr/bin/env python3
import argparse
import os
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / ".self-host"
CADDYFILE = Path.home() / "Caddyfile"
APP = "splendor"
PORTS = {"lobby": 34172, "game": 33402, "dev": 3000}
SESSIONS = {"lobby": "splendor-lobby", "game": "splendor-game", "dev": "splendor-client-dev"}
PROXY_VARS = [
    "ALL_PROXY", "all_proxy", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
    "npm_config_proxy", "npm_config_https_proxy",
]

def run(cmd, cwd=ROOT, env=None):
    print("+", " ".join(map(str, cmd)))
    subprocess.run(cmd, cwd=cwd, env=env, check=True)

def output(cmd):
    return subprocess.check_output(cmd, text=True).strip()

def tmux_kill(name):
    subprocess.run(["tmux", "kill-session", "-t", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def tmux_new(name, cmd, cwd=ROOT, extra_env=None):
    tmux_kill(name)
    args = ["tmux", "new", "-d", "-s", name]
    env = {k: v for k, v in os.environ.items() if k in PROXY_VARS and v}
    if extra_env:
        env.update(extra_env)
    for k, v in env.items():
        args.extend(["-e", f"{k}={v}"])
    args.append(f"cd {shq(cwd)} && {cmd}")
    run(args)

def shq(p):
    return "'" + str(p).replace("'", "'\\''") + "'"

def ensure_tools():
    for tool in ["tmux", "caddy", "mvn", "pnpm", "java"]:
        if not shutil.which(tool):
            raise SystemExit(f"Missing required tool: {tool}")

def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        return s.connect_ex(("127.0.0.1", port)) == 0

def check_ports(ports):
    busy = [str(p) for p in ports if port_busy(p)]
    if busy:
        raise SystemExit("Required port(s) already in use by another process: " + ", ".join(busy))

def default_url():
    return "https://splendor.pinky.lilf.ir"

def parsed_url(url):
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.netloc:
        raise SystemExit("URL must be absolute http:// or https://")
    return u

def caddy_block(url, dev=False):
    u = parsed_url(url)
    host = u.netloc
    scheme = u.scheme
    other = "http" if scheme == "https" else "https"
    main_addr = f"{scheme}://{host}"
    redir_addr = f"{other}://{host}"
    target = f"{scheme}://{host}{{uri}}"
    static_root = ROOT / "client" / "dist"
    if scheme == "http":
        target = f"http://{host}{{uri}}"
    frontend = "reverse_proxy 127.0.0.1:3000" if dev else f"root * {static_root}\n    try_files {{path}} {{path}}/ /index.html\n    file_server"
    return f"""# BEGIN {APP} self-host managed block
{redir_addr} {{
    redir {target} permanent
}}

{main_addr} {{
    encode gzip zstd
    handle_path /ls/* {{
        reverse_proxy 127.0.0.1:{PORTS['lobby']}
    }}
    handle_path /gs/* {{
        reverse_proxy 127.0.0.1:{PORTS['game']}
    }}
    handle {{
    {frontend.replace(chr(10), chr(10)+'    ')}
    }}
}}
# END {APP} self-host managed block
"""

def update_caddy(url, dev=False):
    block = caddy_block(url, dev)
    old = CADDYFILE.read_text() if CADDYFILE.exists() else ""
    pat = re.compile(rf"# BEGIN {APP} self-host managed block.*?# END {APP} self-host managed block\n?", re.S)
    new = pat.sub("", old).rstrip() + "\n\n" + block
    CADDYFILE.write_text(new)
    run(["caddy", "fmt", "--overwrite", str(CADDYFILE)])
    run(["caddy", "reload", "--config", str(CADDYFILE)])

def build():
    DATA.mkdir(exist_ok=True)
    if not (ROOT / "client" / "pnpm-lock.yaml").exists():
        run(["pnpm", "import"], cwd=ROOT / "client")
    run(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], cwd=ROOT / "client")
    run(["pnpm", "build"], cwd=ROOT / "client")
    run(["mvn", "-DskipTests", "package"], cwd=ROOT / "server")
    run(["mvn", "-Psqlite", "-DskipTests", "package"], cwd=ROOT / "setup" / "LobbyService")

def stop(_args=None):
    for name in SESSIONS.values():
        tmux_kill(name)

def start(args, dev=False):
    ensure_tools()
    stop()
    check_ports([PORTS["lobby"], PORTS["game"]] + ([PORTS["dev"]] if dev else []))
    DATA.mkdir(exist_ok=True)
    update_caddy(args.url, dev=dev)
    common = {"LS_SQLITE_PATH": str(DATA / "lobby.sqlite")}
    lsjar = ROOT / "setup" / "LobbyService" / "target" / "ls.jar"
    gsjar = ROOT / "server" / "target" / "splendorGame.jar"
    tmux_new(SESSIONS["lobby"], f"java -jar {shq(lsjar)} --server.port={PORTS['lobby']} --api.games.url=/api/sessions/ --spring.profiles.active=sqlite", extra_env=common)
    tmux_new(SESSIONS["game"], f"java -jar {shq(gsjar)} --server.port={PORTS['game']} --LS.location=http://127.0.0.1:{PORTS['lobby']} --LS.server.password=selfhost_service_token --gs.location=http://127.0.0.1:{PORTS['game']} --save.location={shq(DATA / 'saves')}")
    if dev:
        tmux_new(SESSIONS["dev"], "pnpm dev --host 127.0.0.1 --port 3000", cwd=ROOT / "client")
    print(f"Started {'dev' if dev else 'prod'} self-host at {args.url}")

def setup(args):
    stop()
    build()
    start(args, dev=False)

def redeploy(args):
    stop()
    build()
    start(args, dev=False)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["setup", "redeploy", "start", "stop", "dev-start"])
    parser.add_argument("--url", default=default_url())
    args = parser.parse_args()
    if args.command == "setup": setup(args)
    elif args.command == "redeploy": redeploy(args)
    elif args.command == "start": start(args, dev=False)
    elif args.command == "dev-start": start(args, dev=True)
    elif args.command == "stop": stop(args)

if __name__ == "__main__":
    main()
