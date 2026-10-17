"""``python -m mdcif_server`` / ``mdcif-server``: start the server.

Binds 127.0.0.1 only. The token comes from ``$MDCIF_SERVER_TOKEN`` or is made here, never from
the command line, and is printed once, in the ``mdcif-server URL:`` line, when the server is
listening. uvicorn's access log is off (it would print ``GET /?token=...``).
"""

import argparse
import logging
import os
import secrets
import socket
import sys

from . import __version__
from .settings import (
    DEFAULT_DATA_DIR,
    DEFAULT_ROOT,
    TOKEN_ENV,
    TOKEN_RE,
    Settings,
    SettingsError,
    cpus,
)

LOG_LEVELS = ["critical", "error", "warning", "info", "debug", "trace"]


def _positive_int(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return value


def _port(text):
    value = int(text)
    if not 0 <= value <= 65535:
        raise argparse.ArgumentTypeError("must be 0..65535")
    return value


def _positive_float(text):
    value = float(text)
    if not value > 0:
        raise argparse.ArgumentTypeError("must be positive")
    return value


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        prog="mdcif-server",
        description="Local web server that builds mdcif files from MD trajectories. Binds "
                    "127.0.0.1 only; the access token comes from $MDCIF_SERVER_TOKEN or is "
                    "generated, and is printed in the 'mdcif-server URL:' line.")
    p.add_argument("--port", type=_port, default=8765, help="TCP port; 0 = pick a free port.")
    p.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="Uploads and jobs.")
    p.add_argument("--allow-root", action="append", metavar="PATH",
                   help=f"Root for server-path inputs and browsing (repeatable; default "
                        f"{DEFAULT_ROOT}).")
    p.add_argument("--workers", type=_positive_int, default=1, help="Jobs run at the same time.")
    p.add_argument("--threads", type=_positive_int, default=None,
                   help="Threads per worker (default: CPUs // workers).")
    p.add_argument("--max-upload-gb", type=_positive_float, default=20.0,
                   help="Largest single upload, in GiB.")
    p.add_argument("--chunk-mb", type=_positive_int, default=8,
                   help="Upload chunk size in MiB.")
    p.add_argument("--log-level", default="info", choices=LOG_LEVELS,
                   help="uvicorn / server log level.")
    return p.parse_args(argv)


def _token():
    token = os.environ.pop(TOKEN_ENV, None)          # not inherited by the worker processes
    if token is None:
        return secrets.token_urlsafe(32)
    if not TOKEN_RE.fullmatch(token):
        raise SettingsError(f"${TOKEN_ENV} must match ^{TOKEN_RE.pattern}$")
    return token


def main(argv=None):
    args = parse_args(argv)
    import uvicorn

    level = 5 if args.log_level == "trace" else getattr(logging, args.log_level.upper())
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger = logging.getLogger("mdcif_server")
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False

    try:
        token = _token()
        threads = args.threads or max(1, cpus() // args.workers)
        settings = Settings(data_dir=args.data_dir, token=token,
                            allowed_roots=args.allow_root or [DEFAULT_ROOT], port=args.port,
                            workers=args.workers, threads=threads,
                            max_upload_bytes=int(args.max_upload_gb * 1024 ** 3),
                            chunk_size=args.chunk_mb * 1024 ** 2, log_level=args.log_level)
    except SettingsError as exc:
        print(f"mdcif-server: error: {exc}", file=sys.stderr)
        return 2

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("127.0.0.1", args.port))
    except OSError as exc:
        print(f"mdcif-server: error: cannot listen on 127.0.0.1:{args.port}: {exc}",
              file=sys.stderr)
        return 1
    sock.listen(128)
    sock.set_inheritable(False)
    settings.port = sock.getsockname()[1]

    import mdcif

    from .app import create_app

    print(f"mdcif-server {__version__} (mdcif {mdcif.__version__}) on {socket.gethostname()}",
          flush=True)
    print(f"data dir: {settings.data_dir}", flush=True)
    print(f"allowed roots: {', '.join(str(r) for r in settings.allowed_roots)}", flush=True)
    print(f"workers: {settings.workers} x {settings.threads} threads", flush=True)
    url = f"http://127.0.0.1:{settings.port}/?token={settings.token}"
    app = create_app(settings)
    manager = app.state.jobs

    class Server(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if not self.should_exit:
                print(f"mdcif-server URL: {url}", flush=True)

        def handle_exit(self, sig, frame):
            # srun (Ctrl-C, time limit) signals the workers too, and uvicorn may wait up to 5 s
            # for open requests before the lifespan shutdown: a worker that dies meanwhile was
            # stopped with the server, not killed
            manager.stopping = True
            super().handle_exit(sig, frame)

    config = uvicorn.Config(app, host="127.0.0.1", port=settings.port,
                            log_level=args.log_level, access_log=False, lifespan="on",
                            proxy_headers=False, server_header=False,
                            timeout_graceful_shutdown=5)
    try:
        Server(config).run(sockets=[sock])
    except KeyboardInterrupt:        # uvicorn re-raises the Ctrl-C after it has shut down
        pass
    finally:
        manager.shutdown()           # a no-op after the lifespan shutdown, which uvicorn skips
    return 0                         # on a forced exit (second Ctrl-C)


if __name__ == "__main__":
    sys.exit(main())
