#!/usr/bin/env python3
"""Run Splendor without Docker: the Lobby Service (LS), the game server (GS)
and the web front, each in its own tmux session.

The default instance is the production deployment (data in .self-host/,
public site through ~/Caddyfile). Named instances (instance-start NAME) are
isolated copies for tests and visual checks: own data dir, own ports, own
private Caddy, and they never touch ~/Caddyfile or the default sessions.
See docs/self-hosting.md.
"""
import argparse
import fcntl
import json
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / ".self-host"
PORTS_FILE = DATA / "ports.json"
INSTANCES = DATA / "instances"
CADDYFILE = Path.home() / "Caddyfile"
CLIENT = ROOT / "client"
DIST = CLIENT / "dist"
LS_JAR = ROOT / "setup" / "LobbyService" / "target" / "ls.jar"
GS_JAR = ROOT / "server" / "target" / "splendorGame.jar"
LS_BUILD_HINT = ("mvn -f setup/LobbyService/pom.xml -Psqlite -DskipTests -Dmaven.javadoc.skip=true "
                 "-Dpmd.skip=true package")
GS_BUILD_HINT = ("mvn -f server/pom.xml -DskipTests -Dmaven.javadoc.skip=true -Dpmd.skip=true "
                 "-Dcheckstyle.skip=true package")
APP = "splendor"
DEFAULT_PORTS = {"lobby": 34172, "game": 33402, "dev": 38932}
SESSIONS = {"lobby": "splendor-lobby", "game": "splendor-game", "dev": "splendor-client-dev"}
INSTANCE_PORT_BASE = 35100
INSTANCE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
# The game services the GS registers (server/.../control/Initializer.java).
# SPLENDOR_EXPECTED_SERVICES=a,b,c overrides this list.
EXPECTED_SERVICES = ["splendor_BASE_ORIENT", "splendor_BASE_ORIENT_CITIES", "splendor_BASE_ORIENT_TRADE_ROUTES"]
# Logged by the GS once every service is registered.
GS_REGISTERED_LOG_LINE = "Registered game on lobby service"
CLIENT_INPUTS = ["src", "public", "astro.config.mjs", "package.json", "pnpm-lock.yaml",
                 "tailwind.config.cjs", "tsconfig.json"]
PROXY_VARS = [
    "ALL_PROXY", "all_proxy", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
    "NO_PROXY", "no_proxy", "npm_config_proxy", "npm_config_https_proxy",
]
# tmux sessions inherit the tmux server's environment, which can be older than
# ours. Pass the variables that decide which java/node/pnpm runs.
PASS_VARS = ["PATH", "JAVA_HOME"]


def run(cmd, cwd=ROOT, env=None):
    print("+", " ".join(map(str, cmd)), flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def capture(cmd, cwd=ROOT):
    return subprocess.check_output(cmd, cwd=cwd, text=True).strip()


def shq(value):
    return "'" + str(value).replace("'", "'\\''") + "'"


def is_macos():
    return platform.system() == "Darwin"


def default_url():
    return f"https://{APP}.pinky.lilf.ir"


def served_url(configured_url, dev=False, p=None):
    # Dev mode never goes through Caddy: the Astro dev server proxies /ls and
    # /gs itself (client/astro.config.mjs), so it is only served locally.
    if dev:
        return f"http://127.0.0.1:{(p or read_ports())['dev']}"
    return configured_url


def parsed_url(url):
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.netloc:
        raise SystemExit("URL must be absolute http:// or https://")
    return u


def maven_proxy_opts():
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    if not proxy:
        return ""
    u = urlparse(proxy)
    if u.scheme not in ("http", "https") or not u.hostname or not u.port:
        return ""
    non_proxy = (os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or "127.0.0.1,localhost,::1")
    non_proxy_hosts = "|".join(x.strip() for x in non_proxy.split(",") if x.strip())
    return " ".join([
        f"-Dhttp.proxyHost={u.hostname}", f"-Dhttp.proxyPort={u.port}",
        f"-Dhttps.proxyHost={u.hostname}", f"-Dhttps.proxyPort={u.port}",
        f"-Dhttp.nonProxyHosts={non_proxy_hosts}",
    ])


def env_with_proxy():
    env = os.environ.copy()
    opts = maven_proxy_opts()
    if opts:
        env["MAVEN_OPTS"] = (env.get("MAVEN_OPTS", "") + " " + opts).strip()
    return env


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def write_json(path, data):
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(tmp, path)


@contextmanager
def file_lock(path):
    """Hold an exclusive flock on path, so concurrent self_host.py runs queue up."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


# ---------------------------------------------------------------- instances

class Instance:
    """Where one deployment keeps its data, and what its tmux sessions are called.

    name None is the default (production) instance. It keeps the historical
    layout directly in .self-host/ and the historical session names, because
    the live server's tooling relies on them.
    """

    def __init__(self, name=None):
        self.name = name
        if name is None:
            self.dir = DATA
            self.sessions = dict(SESSIONS)
            self.ports_file = PORTS_FILE
        else:
            if not INSTANCE_NAME_RE.match(name):
                raise SystemExit("Instance names use lowercase letters, digits, '-' and '_' (at most 32).")
            self.dir = INSTANCES / name
            prefix = f"{APP}-{name}"
            self.sessions = {
                "lobby": f"{prefix}-lobby",
                "game": f"{prefix}-game",
                "web": f"{prefix}-web",
                "dev": f"{prefix}-client-dev",
            }
            self.ports_file = self.dir / "ports.json"
        self.sqlite = self.dir / "lobby.sqlite"
        self.saves = self.dir / "saves"
        self.logs = self.dir / "logs"
        self.jars = self.dir / "jars"
        self.caddyfile = self.dir / "Caddyfile"
        self.info_file = self.dir / "instance.json"
        self.token_file = self.dir / "service-token"

    @property
    def label(self):
        return "default instance" if self.name is None else f"instance {self.name}"

    def log(self, role):
        return self.logs / f"{role}.log"

    def prepare(self):
        for d in (self.dir, self.saves, self.logs):
            d.mkdir(parents=True, exist_ok=True)
        # The sqlite file holds every player's token; keep the tree private.
        os.chmod(self.dir, 0o700)

    def service_token_file(self):
        """Return the file holding this data dir's service token, creating it (0600) once.

        The LS accepts this token as the game service's identity. The GS uses a
        password that starts with "selfhost_" directly as its token (see
        server/.../control/Authentication.java), so the prefix is required.
        """
        if not self.token_file.exists():
            token = "selfhost_svc_" + secrets.token_hex(24)
            fd = os.open(self.token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(token + "\n")
        os.chmod(self.token_file, 0o600)
        token = self.token_file.read_text().strip()
        if not token.startswith("selfhost_") or not re.fullmatch(r"[A-Za-z0-9_]+", token):
            raise SystemExit(f"{self.token_file} must hold one token that starts with selfhost_ "
                             "(letters, digits, '_'). Delete it to generate a new one.")
        return self.token_file


# --------------------------------------------------------------------- tmux

def tmux_env_args(extra_env=None):
    env = {k: v for k, v in os.environ.items() if (k in PROXY_VARS or k in PASS_VARS) and v}
    if extra_env:
        env.update({k: str(v) for k, v in extra_env.items()})
    args = []
    for k, v in env.items():
        args.extend(["-e", f"{k}={v}"])
    return args


def tmux_alive(name):
    return subprocess.run(["tmux", "has-session", "-t", f"={name}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def tmux_kill(name):
    # "=" makes tmux match the exact session name. A bare -t falls back to
    # prefix matching and could kill another instance's session.
    subprocess.run(["tmux", "kill-session", "-t", f"={name}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def start_log(log):
    """Keep the previous run's log as NAME.log.1 and start an empty, private one."""
    log = Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists():
        os.replace(log, log.with_name(log.name + ".1"))
    os.close(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600))


def tmux_new(name, script, cwd=ROOT, extra_env=None, log=None):
    """Run a /bin/sh script in a fresh detached tmux session.

    With log, stdout and stderr also go to that file, so the output survives
    when the process exits and tmux closes the session.
    """
    tmux_kill(name)
    if log:
        start_log(log)
        script = f"{{ {script} ; }} 2>&1 | tee -a {shq(log)}"
    env_args = tmux_env_args(extra_env)
    full = f"cd {shq(cwd)} && {script}"
    # Print variable names only: values such as PATH are long and need not be logged.
    names = sorted({a.split("=", 1)[0] for a in env_args if a != "-e"})
    print(f"+ tmux new-session -d -s {name} [env: {' '.join(names)}] /bin/sh -c {shq(full)}", flush=True)
    subprocess.run(["tmux", "new-session", "-d", "-s", name, *env_args, "/bin/sh", "-c", full], check=True)


def ensure_tools(tools):
    for tool in tools:
        if not shutil.which(tool):
            raise SystemExit(f"Missing required tool: {tool}")


# -------------------------------------------------------------------- ports

def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        return s.connect_ex(("127.0.0.1", int(port))) == 0


def port_bindable(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", int(port)))
        except OSError:
            return False
    return True


def port_free(port):
    return not port_busy(port) and port_bindable(port)


def first_free(start, exclude=()):
    p = int(start)
    while p < 65535:
        if p not in exclude and port_free(p):
            return p
        p += 1
    raise SystemExit(f"Could not find a free port at or above {start}")


def read_ports():
    """Return the default instance's recorded ports without probing or rewriting anything."""
    data = read_json(PORTS_FILE, {})
    return {**DEFAULT_PORTS, **(data if isinstance(data, dict) else {})}


def ports(reset=False):
    """Choose the default instance's ports for a start, after its sessions were stopped.

    A recorded port stays as long as it is free, or is still held by our own
    tmux session for that role. Only a port held by some other program moves,
    and ports.json is rewritten only when something actually moved.
    """
    DATA.mkdir(exist_ok=True)
    current = dict(DEFAULT_PORTS) if reset else read_ports()
    changed = reset or not PORTS_FILE.exists()
    taken = set()
    for name, default in DEFAULT_PORTS.items():
        port = int(current[name])
        if port in taken or (not port_free(port) and not tmux_alive(SESSIONS[name])):
            port = first_free(default, exclude=taken)
            changed = True
        current[name] = port
        taken.add(port)
    if changed:
        write_json(PORTS_FILE, current)
    return current


def claimed_ports(except_instance):
    """Ports recorded by the default instance and by every other named instance."""
    claimed = set(DEFAULT_PORTS.values()) | {int(v) for v in read_ports().values()}
    if INSTANCES.is_dir():
        for d in INSTANCES.iterdir():
            if d.name == except_instance or not d.is_dir():
                continue
            data = read_json(d / "ports.json", {})
            if isinstance(data, dict):
                claimed |= {int(v) for v in data.values() if isinstance(v, int)}
    return claimed


def instance_ports(inst):
    """Pick (or reuse) free lobby/game/web ports for a named instance and persist them.

    The allocation runs under a lock and skips every port another instance has
    recorded, so instances started at the same time never pick the same port.
    """
    with file_lock(INSTANCES / ".ports.lock"):
        current = read_json(inst.ports_file, {})
        if not isinstance(current, dict):
            current = {}
        taken = claimed_ports(inst.name)
        chosen = {}
        for role in ("lobby", "game", "web"):
            port = current.get(role)
            if not isinstance(port, int) or port in taken or not port_free(port):
                port = first_free(INSTANCE_PORT_BASE, exclude=taken)
            chosen[role] = port
            taken.add(port)
        write_json(inst.ports_file, chosen)
    return chosen


# ---------------------------------------------------------- process cleanup

def listener_pids(port):
    out = subprocess.run(["lsof", "-nP", f"-iTCP:{int(port)}", "-sTCP:LISTEN", "-t"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout
    return sorted({int(x) for x in out.split() if x.strip().isdigit()})


def process_command(pid):
    return subprocess.run(["ps", "-o", "command=", "-p", str(int(pid))],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout.strip()


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def kill_pid(pid, why):
    """TERM, then KILL after 10 s. pid must come from an explicit, validated listing."""
    pid = int(pid)
    if pid <= 1 or pid == os.getpid():
        return
    print(f"Killing {why} (pid {pid}): {process_command(pid)[:200]}")
    for sig in ("-TERM", "-KILL"):
        subprocess.run(["kill", sig, str(pid)], stderr=subprocess.DEVNULL)
        end = time.time() + 10
        while time.time() < end and pid_alive(pid):
            time.sleep(0.3)
        if not pid_alive(pid):
            return


def release_ports(owned, timeout=20):
    """Wait until each port in owned is released; return the ports still busy.

    owned maps a port to a list of signatures, each a list of substrings. A
    listener whose command line contains every substring of one signature is
    an orphan of ours and is killed by PID; any other listener is reported and
    left alone. tmux kill-session returns before a JVM closes its socket, so
    this also stops a quick restart from seeing our own ports as taken.
    """
    deadline = time.time() + timeout
    while time.time() < deadline and any(port_busy(p) for p in owned):
        time.sleep(0.5)
    for port, signatures in owned.items():
        for pid in listener_pids(port):
            cmd = process_command(pid)
            if any(sig and all(part in cmd for part in sig) for sig in signatures):
                kill_pid(pid, f"orphan on port {port}")
            else:
                print(f"Warning: port {port} is held by a process that is not ours (pid {pid}): {cmd[:160]}")
    return [p for p in owned if port_busy(p)]


def kill_instance_orphans(inst):
    """Kill java/caddy processes started from this named instance's directory.

    Filters a ps listing in Python on literal, instance-specific markers (the
    instance's jar directory and Caddyfile), never on a regex.
    """
    markers = [f"{inst.dir}/jars/", f"--config {inst.caddyfile}"]
    out = subprocess.run(["ps", "-axo", "pid=,command="], stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True).stdout
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        pid, cmd = int(parts[0]), parts[1]
        exe = os.path.basename(cmd.split()[0]) if cmd.split() else ""
        if exe in ("java", "caddy") and any(m in cmd for m in markers):
            kill_pid(pid, f"leftover process of {inst.label}")


# --------------------------------------------------------------------- HTTP

def http_get(url, timeout=3):
    req = urllib.request.Request(url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never via a proxy
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def log_tail(log, lines=40):
    try:
        text = Path(log).read_text(errors="replace").splitlines()
    except OSError:
        return f"(no log at {log})"
    return "\n".join(text[-lines:])


def fail(message, logs=()):
    for log in logs:
        print(f"----- last lines of {log} -----", file=sys.stderr)
        print(log_tail(log), file=sys.stderr)
    raise SystemExit(message)


def start_timeout():
    try:
        return int(os.environ.get("SPLENDOR_START_TIMEOUT", "240"))
    except ValueError:
        return 240


def wait_for_http(url, label, timeout=None, session=None, log=None):
    """Poll url until it answers below 500. Fail early if session has exited."""
    deadline = time.time() + (timeout or start_timeout())
    last_error = None
    while time.time() < deadline:
        try:
            status, _ = http_get(url)
            if 200 <= status < 500:
                return
            last_error = f"HTTP {status}"
        except Exception as exc:
            last_error = exc
        if session and not tmux_alive(session):
            fail(f"{label} exited during startup (tmux session {session} is gone).", [log] if log else [])
        time.sleep(1)
    fail(f"Timed out waiting for {label} at {url}: {last_error}", [log] if log else [])


def expected_services():
    raw = os.environ.get("SPLENDOR_EXPECTED_SERVICES", "")
    names = [x.strip() for x in raw.split(",") if x.strip()]
    return names or list(EXPECTED_SERVICES)


def registered_services(lobby_port):
    status, body = http_get(f"http://127.0.0.1:{lobby_port}/api/gameservices")
    if status != 200:
        return []
    try:
        return [x.get("name") for x in json.loads(body) if isinstance(x, dict)]
    except ValueError:
        return []


def wait_for_registration(inst, p, timeout=None):
    """Wait until the GS has registered every game service with the LS.

    /api/online answers before registration finishes, and a GS that gives up
    registering exits a little later, so "online" alone proves nothing.
    Ready means: every expected service is listed by GET /api/gameservices
    and the GS logged that registration finished (or, if that log line never
    shows up, the listing stayed complete for 15 s).
    """
    deadline = time.time() + (timeout or start_timeout())
    want = expected_services()
    complete_since = None
    names = []
    while time.time() < deadline:
        if not tmux_alive(inst.sessions["game"]):
            fail("The game server exited before registering its game services.",
                 [inst.log("game"), inst.log("lobby")])
        if not tmux_alive(inst.sessions["lobby"]):
            fail("The lobby service exited during startup.", [inst.log("lobby")])
        names = registered_services(p["lobby"])
        if all(n in names for n in want):
            complete_since = complete_since or time.time()
            logged = GS_REGISTERED_LOG_LINE in log_tail(inst.log("game"), 400)
            if logged or time.time() - complete_since > 15:
                print("Registered game services: " + ", ".join(sorted(n for n in names if n)))
                return names
        else:
            complete_since = None
        time.sleep(1)
    fail(f"Timed out waiting for game services {want} to register; the LS lists {names}.",
         [inst.log("game"), inst.log("lobby")])


# ------------------------------------------------------------------ backend

def check_jar(path, hint):
    if not path.exists():
        raise SystemExit(f"Missing {path}. Build it first: {hint}")
    try:
        with zipfile.ZipFile(path):
            pass
    except zipfile.BadZipFile:
        raise SystemExit(f"{path} is not a valid jar; a build may still be writing it. Retry, or rebuild: {hint}")


def snapshot_jar(src, dest_dir):
    """Copy a jar for a deployment to run from, so a rebuild cannot change it underneath."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    tmp = dest_dir / (src.name + ".tmp")
    shutil.copy2(src, tmp)
    try:
        with zipfile.ZipFile(tmp):
            pass
    except zipfile.BadZipFile:
        tmp.unlink()
        raise SystemExit(f"{src} changed while it was being copied; a build is probably writing it. Retry.")
    os.replace(tmp, dest)
    return dest


def start_backend(inst, p, lsjar, gsjar):
    """Start the LS, then the GS, and wait until the GS registered its services.

    Both JVMs listen on 127.0.0.1 only, so the public side can reach them only
    through Caddy and its route rules.

    The service token reaches both JVMs as an environment variable that the
    tmux shell reads from the token file. It never appears on a command line,
    so ps and the tmux client arguments only show the file's path.
    """
    inst.prepare()
    token_file = shq(inst.service_token_file())
    tmux_new(
        inst.sessions["lobby"],
        f"SPLENDOR_SERVICE_TOKEN=\"$(cat {token_file})\" "
        f"java -jar {shq(lsjar)} --server.address=127.0.0.1 --server.port={p['lobby']} "
        f"--api.games.url=/api/sessions/ --spring.profiles.active=sqlite",
        extra_env={"LS_SQLITE_PATH": str(inst.sqlite)},
        log=inst.log("lobby"),
    )
    wait_for_http(f"http://127.0.0.1:{p['lobby']}/api/online", "Lobby service",
                  session=inst.sessions["lobby"], log=inst.log("lobby"))
    tmux_new(
        inst.sessions["game"],
        # Spring's relaxed binding maps LS_SERVER_PASSWORD to LS.server.password.
        f"LS_SERVER_PASSWORD=\"$(cat {token_file})\" "
        f"java -jar {shq(gsjar)} --server.address=127.0.0.1 --server.port={p['game']} "
        f"--LS.location=http://127.0.0.1:{p['lobby']} "
        f"--gs.location=http://127.0.0.1:{p['game']} --save.location={shq(inst.saves)}",
        log=inst.log("game"),
    )
    wait_for_http(f"http://127.0.0.1:{p['game']}/api/online", "Game service",
                  session=inst.sessions["game"], log=inst.log("game"))
    wait_for_registration(inst, p)


def dev_server_env(p, inst):
    env = {
        "SPLENDOR_LS_URL": f"http://127.0.0.1:{p['lobby']}",
        "SPLENDOR_GS_URL": f"http://127.0.0.1:{p['game']}",
    }
    if inst.name is not None:
        env["SPLENDOR_VITE_CACHE_DIR"] = str(inst.dir / "vite-cache")
    return env


# ------------------------------------------------------------------- client

def client_inputs_mtime():
    newest = 0.0
    for rel in CLIENT_INPUTS:
        path = CLIENT / rel
        if path.is_dir():
            for f in path.rglob("*"):
                if f.is_file():
                    newest = max(newest, f.stat().st_mtime)
        elif path.exists():
            newest = max(newest, path.stat().st_mtime)
    return newest


def dist_is_stale():
    index = DIST / "index.html"
    return not index.exists() or index.stat().st_mtime < client_inputs_mtime()


def ensure_node_modules():
    if not (CLIENT / "node_modules").is_dir():
        run(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], cwd=CLIENT, env=env_with_proxy())


def build_client_staging():
    """pnpm build into a staging directory; client/dist is not touched."""
    staging = DATA / "build" / f"dist-staging-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.parent.mkdir(parents=True, exist_ok=True)
    env = env_with_proxy()
    env["SPLENDOR_DIST_DIR"] = str(staging)
    run(["pnpm", "build"], cwd=CLIENT, env=env)
    if not (staging / "index.html").exists():
        raise SystemExit(f"pnpm build did not produce {staging / 'index.html'}")
    return staging


def swap_dist(staging):
    """Replace client/dist with a finished build by two renames, so it is never half-written."""
    old = DATA / "build" / f"dist-old-{os.getpid()}"
    if old.exists():
        shutil.rmtree(old)
    if DIST.exists():
        os.rename(DIST, old)
    os.rename(staging, DIST)
    shutil.rmtree(old, ignore_errors=True)


def ensure_client_dist(no_build):
    if no_build:
        if not (DIST / "index.html").exists():
            raise SystemExit(f"{DIST} is missing. Run without --no-build to build it.")
        return
    with file_lock(DATA / "client-build.lock"):
        if dist_is_stale():
            ensure_node_modules()
            swap_dist(build_client_staging())
        else:
            print(f"{DIST} is up to date.")


# -------------------------------------------------------------------- Caddy

# Path segments a player action URL may contain. No leading dot, so ".." can
# never pass for a session id, player name or action.
_SEGMENT = r"[A-Za-z0-9_~-][A-Za-z0-9_.~-]*"
GS_PLAYER_ACTION_RE = rf"^/api/sessions/{_SEGMENT}/players/{_SEGMENT}/actions/{_SEGMENT}$"


def site_routes(p, frontend):
    """The routes shared by the public site and the private instance fronts.

    Service-only routes are refused from the public side. The GS registers
    with the LS, and the LS launches games on the GS, over 127.0.0.1 directly,
    so neither call ever needs to pass through Caddy:
    - /ls/api/gameservices*: anything but GET (registering, unregistering and
      savegame writes are for the game service or an admin). The match is any
      path containing /gameservices, in any case, so variants such as
      /api/gameservices;x/... are caught without relying on the LS firewall.
    - /gs/*: every PUT except a player action. That blocks the LS->GS launch
      call PUT /api/sessions/{{id}}, which has no authentication.
    """
    return f"""    encode gzip zstd
    handle_path /ls/* {{
        @ls_service_only {{
            not method GET
            path_regexp (?i)/gameservices
        }}
        respond @ls_service_only "Forbidden: service-only route" 403
        reverse_proxy 127.0.0.1:{p['lobby']}
    }}
    handle_path /gs/* {{
        @gs_service_only {{
            method PUT
            not path_regexp {GS_PLAYER_ACTION_RE}
        }}
        respond @gs_service_only "Forbidden: service-only route" 403
        reverse_proxy 127.0.0.1:{p['game']}
    }}
    handle {{
{frontend}
    }}
"""


def static_frontend(root):
    return (f"        root * {root}\n"
            f"        try_files {{path}} {{path}}/ /index.html\n"
            f"        file_server")


def caddy_block(url, p):
    u = parsed_url(url)
    host = u.netloc
    scheme = u.scheme
    other = "http" if scheme == "https" else "https"
    main_addr = f"{scheme}://{host}"
    redir_addr = f"{other}://{host}"
    target = f"{scheme}://{host}{{uri}}"
    return f"""# BEGIN {APP} self-host managed block
{redir_addr} {{
    redir {target} permanent
}}

{main_addr} {{
{site_routes(p, static_frontend(DIST))}}}
# END {APP} self-host managed block
"""


def update_caddy(url, p, dev=False):
    if dev:
        # Dev mode is local-only. Exposing the Vite 4 dev server publicly would
        # also expose its known file-read bugs, so Caddy is left untouched.
        return
    block = caddy_block(url, p)
    old = CADDYFILE.read_text() if CADDYFILE.exists() else ""
    pat = re.compile(rf"# BEGIN {APP} self-host managed block.*?# END {APP} self-host managed block\n?", re.S)
    new = pat.sub("", old).rstrip() + "\n\n" + block
    CADDYFILE.write_text(new)
    run(["caddy", "fmt", "--overwrite", str(CADDYFILE)])
    run(["caddy", "reload", "--config", str(CADDYFILE)])


def instance_caddyfile(inst, p):
    """A private Caddy config: no admin API, no HTTPS, loopback only, own storage.

    Caddy's autosave and data go to XDG dirs that start_web points into the
    instance, so nothing touches the user's Caddy state.
    """
    return f"""{{
    admin off
    auto_https off
    storage file_system {inst.dir / 'caddy' / 'data'}
}}

http://:{p['web']} {{
    bind 127.0.0.1
{site_routes(p, static_frontend(DIST))}}}
"""


def start_web(inst, p, mode):
    if mode == "static":
        inst.caddyfile.write_text(instance_caddyfile(inst, p))
        caddy_home = inst.dir / "caddy"
        tmux_new(
            inst.sessions["web"],
            f"caddy run --config {shq(inst.caddyfile)} --adapter caddyfile",
            # Caddy keeps its state under XDG dirs; point them into the
            # instance so the user's own Caddy data is never touched.
            extra_env={"XDG_DATA_HOME": caddy_home / "data", "XDG_CONFIG_HOME": caddy_home / "config"},
            log=inst.log("web"),
        )
        session, log = inst.sessions["web"], inst.log("web")
    else:
        tmux_new(
            inst.sessions["dev"], f"pnpm dev --host 127.0.0.1 --port {p['web']}", cwd=CLIENT,
            extra_env=dev_server_env(p, inst), log=inst.log("client-dev"),
        )
        session, log = inst.sessions["dev"], inst.log("client-dev")
    base = f"http://127.0.0.1:{p['web']}"
    wait_for_http(f"{base}/", "web front", session=session, log=log)
    for prefix, label in (("ls", "lobby service"), ("gs", "game server")):
        status, body = http_get(f"{base}/{prefix}/api/online", timeout=20)
        if status != 200:
            fail(f"The web front does not reach the {label}: GET {base}/{prefix}/api/online gave {status} {body[:200]}",
                 [log])


# ------------------------------------------------------- default instance

DEFAULT = Instance(None)


def build(dev=False):
    DATA.mkdir(exist_ok=True)
    if not (CLIENT / "pnpm-lock.yaml").exists():
        run(["pnpm", "import"], cwd=CLIENT, env=env_with_proxy())
    run(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], cwd=CLIENT, env=env_with_proxy())
    if not dev:
        run(["pnpm", "build"], cwd=CLIENT, env=env_with_proxy())
    run(["mvn", "-DskipTests", "-Dmaven.javadoc.skip=true", "-Dpmd.skip=true", "package"], cwd=ROOT / "server", env=env_with_proxy())
    run(["mvn", "-Psqlite", "-DskipTests", "-Dmaven.javadoc.skip=true", "-Dpmd.skip=true", "package"], cwd=ROOT / "setup" / "LobbyService", env=env_with_proxy())


def stop(_args=None):
    p = read_ports()
    for name in SESSIONS.values():
        tmux_kill(name)
    busy = release_ports({
        p["lobby"]: [["ls.jar", f"--server.port={p['lobby']}"]],
        p["game"]: [["splendorGame.jar", f"--server.port={p['game']}"]],
        p["dev"]: [["astro", f"--port {p['dev']}"]],
    })
    print("Stopped Splendor self-host tmux sessions." + (f" Ports still busy: {busy}" if busy else ""))


def start(args, dev=False):
    ensure_tools(["tmux", "java", "lsof"] + (["pnpm", "node"] if dev else ["caddy"]))
    stop()
    p = ports()
    DEFAULT.prepare()
    update_caddy(args.url, p, dev=dev)
    check_jar(LS_JAR, LS_BUILD_HINT)
    check_jar(GS_JAR, GS_BUILD_HINT)
    start_backend(DEFAULT, p, LS_JAR, GS_JAR)
    if dev:
        tmux_new(
            SESSIONS["dev"], f"pnpm dev --host 127.0.0.1 --port {p['dev']}", cwd=CLIENT,
            extra_env=dev_server_env(p, DEFAULT), log=DEFAULT.log("client-dev"),
        )
        wait_for_http(f"http://127.0.0.1:{p['dev']}", "Astro dev server",
                      session=SESSIONS["dev"], log=DEFAULT.log("client-dev"))
    print(f"Started {'dev' if dev else 'prod'} self-host at {served_url(args.url, dev=dev, p=p)}")
    print(f"Logs: {DEFAULT.logs}")


def setup(args):
    ensure_tools(["tmux", "java", "lsof", "mvn", "pnpm", "node", "caddy"])
    stop()
    ports(reset=True)
    build(dev=False)
    start(args, dev=False)


def redeploy(args):
    ensure_tools(["tmux", "java", "lsof", "mvn", "pnpm", "node", "caddy"])
    stop()
    build(dev=False)
    start(args, dev=False)


def dev_start(args):
    ensure_tools(["tmux", "java", "lsof", "mvn", "pnpm", "node"])
    stop()
    build(dev=True)
    start(args, dev=True)


def status(args):
    # Read-only: never probes for new ports or rewrites ports.json.
    p = read_ports()
    print(f"Configured URL: {args.url}")
    print("Ports: " + json.dumps(p, sort_keys=True))
    for key, session in SESSIONS.items():
        alive = tmux_alive(session)
        listening = port_busy(p[key])
        print(f"{key}: {'running' if alive else 'stopped'} ({session}), port {p[key]} {'listening' if listening else 'not listening'}")
    print(f"Logs: {DEFAULT.logs}")


# --------------------------------------------------------- named instances

def require_name(args):
    if not args.name:
        raise SystemExit(f"{args.command} needs an instance NAME, for example: ./self_host.py {args.command} e2e")
    return Instance(args.name)


def stop_instance(inst):
    """Stop a named instance; return the list of its ports that are still busy."""
    p = read_json(inst.ports_file, {})
    if not isinstance(p, dict):
        p = {}
    for session in inst.sessions.values():
        tmux_kill(session)
    owned = {}
    for role in ("lobby", "game"):
        if isinstance(p.get(role), int):
            owned[p[role]] = [[f"{inst.dir}/jars/", f"--server.port={p[role]}"]]
    if isinstance(p.get("web"), int):
        owned[p["web"]] = [[f"--config {inst.caddyfile}"], ["astro", f"--port {p['web']}"]]
    busy = release_ports(owned)
    kill_instance_orphans(inst)
    if inst.info_file.exists():
        inst.info_file.unlink()
    return busy


def instance_info(inst, p, mode):
    return {
        "name": inst.name,
        "mode": mode,
        "baseUrl": f"http://127.0.0.1:{p['web']}",
        "lsUrl": f"http://127.0.0.1:{p['lobby']}",
        "gsUrl": f"http://127.0.0.1:{p['game']}",
        "ports": {"lobby": p["lobby"], "game": p["game"], "web": p["web"]},
        "dataDir": str(inst.dir),
    }


def instance_start(args):
    inst = require_name(args)
    mode = args.mode
    tools = ["tmux", "java", "lsof"] + (["caddy"] if mode == "static" else ["pnpm", "node"])
    if mode == "static" and not args.no_build:
        tools += ["pnpm", "node"]
    ensure_tools(tools)
    if any(tmux_alive(s) for s in inst.sessions.values()):
        print(f"Restarting {inst.label}.")
    stop_instance(inst)
    inst.prepare()
    if mode == "static":
        ensure_client_dist(args.no_build)
    elif not args.no_build:
        ensure_node_modules()
    check_jar(LS_JAR, LS_BUILD_HINT)
    check_jar(GS_JAR, GS_BUILD_HINT)
    lsjar = snapshot_jar(LS_JAR, inst.jars)
    gsjar = snapshot_jar(GS_JAR, inst.jars)
    p = instance_ports(inst)
    try:
        start_backend(inst, p, lsjar, gsjar)
        start_web(inst, p, mode)
    except BaseException:
        print(f"Start failed; stopping {inst.label}. Logs stay in {inst.logs}.", file=sys.stderr)
        stop_instance(inst)
        raise
    info = instance_info(inst, p, mode)
    write_json(inst.info_file, info)
    print(json.dumps(info, indent=2))


def instance_stop(args):
    inst = require_name(args)
    busy = stop_instance(inst)
    if busy:
        raise SystemExit(f"Stopped {inst.label}, but these ports are still busy: {busy}")
    print(f"Stopped {inst.label}; its ports are free.")


def instance_status(args):
    """Print the instance's state as JSON (read-only). Exit 0 only if it is fully up."""
    inst = require_name(args)
    p = read_json(inst.ports_file, {})
    if not isinstance(p, dict):
        p = {}
    info = read_json(inst.info_file, None)
    mode = info.get("mode") if isinstance(info, dict) else None
    sessions = {role: tmux_alive(s) for role, s in inst.sessions.items()}
    listening = {role: port_busy(port) for role, port in p.items() if isinstance(port, int)}
    needed = ["lobby", "game", "web" if mode == "static" else "dev"]
    running = bool(info) and all(sessions.get(r) for r in needed) and bool(listening) and all(listening.values())
    print(json.dumps({
        "name": inst.name,
        "running": running,
        "sessions": {inst.sessions[r]: alive for r, alive in sessions.items()},
        "ports": p,
        "listening": listening,
        "logs": str(inst.logs),
        "instance": info,
    }, indent=2))
    if not running:
        sys.exit(1)


COMMANDS = {
    "setup": setup,
    "redeploy": redeploy,
    "start": lambda args: start(args, dev=False),
    "stop": stop,
    "dev-start": dev_start,
    "status": status,
    "instance-start": instance_start,
    "instance-stop": instance_stop,
    "instance-status": instance_status,
}


def main():
    parser = argparse.ArgumentParser(description="Self-host Splendor in tmux sessions (see docs/self-hosting.md).")
    parser.add_argument("command", choices=list(COMMANDS))
    parser.add_argument("name", nargs="?", help="instance name, for the instance-* commands")
    parser.add_argument("--url", default=default_url(), help="public URL of the default instance")
    parser.add_argument("--mode", choices=["static", "dev"], default="static",
                        help="instance-start: web front is a private Caddy over client/dist (static) or astro dev (dev)")
    parser.add_argument("--no-build", action="store_true",
                        help="instance-start: do not build client/dist or install node_modules")
    args = parser.parse_args()
    if args.name and not args.command.startswith("instance-"):
        parser.error(f"{args.command} does not take an instance name")
    COMMANDS[args.command](args)


if __name__ == "__main__":
    main()
