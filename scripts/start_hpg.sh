#!/usr/bin/env bash
# Start mdcif-server on a HiPerGator compute node (via srun) and print how to reach it.
#
# Usage: scripts/start_hpg.sh [options] [-- extra mdcif-server options]
#
#   --port PORT        port on the compute node and on the login node (default 8765)
#   --workers N        builds that run at the same time (default 1)
#   --data-dir DIR     uploads and jobs; must be on /blue (default <repo>/data)
#   --cpus N           srun --cpus-per-task (default 8; shared by the workers)
#   --mem SIZE         srun --mem (default 32gb)
#   --time HH:MM:SS    srun --time (default 08:00:00); the server stops when it runs out
#   --account A        srun --account (default alberto.perezant)
#   --qos Q            srun --qos (default alberto.perezant)
#   --here             don't call srun: run on this node (inside salloc/sbatch)
#   -h, --help         this help
#
# Example: scripts/start_hpg.sh --port 8790 --workers 2 --cpus 16 -- --allow-root /orange/x
#
# It prints the compute node, the ssh tunnel command to run on the login node, and the URL
# (with the access token) to open in your browser. Then the server runs in the foreground:
# Ctrl-C stops it and ends the srun job. Under sbatch the URL lands in the job's output file:
# keep that file private (chmod 600), since the token is the only protection.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${MDCIF_PYTHON:-/blue/alberto.perezant/t.desilva/conda/envs/mdcif/bin/python}"

PORT=8765
WORKERS=1
DATA_DIR="$ROOT/data"
CPUS=8
MEM=32gb
TIME=08:00:00
ACCOUNT=alberto.perezant
QOS=alberto.perezant
HERE=0
ON_NODE=0
EXTRA=()

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "start_hpg.sh: $*" >&2; exit 2; }
value() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value (see --help)"; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)     value "$@"; PORT="$2"; shift 2 ;;
        --workers)  value "$@"; WORKERS="$2"; shift 2 ;;
        --data-dir) value "$@"; DATA_DIR="$2"; shift 2 ;;
        --cpus)     value "$@"; CPUS="$2"; shift 2 ;;
        --mem)      value "$@"; MEM="$2"; shift 2 ;;
        --time)     value "$@"; TIME="$2"; shift 2 ;;
        --account)  value "$@"; ACCOUNT="$2"; shift 2 ;;
        --qos)      value "$@"; QOS="$2"; shift 2 ;;
        --here)     HERE=1; shift ;;
        --on-node)  ON_NODE=1; shift ;;           # internal: we are inside the srun step
        -h|--help)  usage; exit 0 ;;
        --)         shift; EXTRA=("$@"); break ;;
        *)          die "unknown argument '$1' (see --help)" ;;
    esac
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
    die "--port must be a number from 1024 to 65535"
fi
[[ "$WORKERS" =~ ^[1-9][0-9]*$ ]] || die "--workers must be a positive integer"
[[ -x "$PYTHON" ]] || die "no python at $PYTHON (set MDCIF_PYTHON)"

on_node() {
    local node url
    node="$(hostname -s)"
    if ! PYTHONPATH='' "$PYTHON" - "$PORT" <<'EOF'
import socket
import sys

s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
EOF
    then
        echo "start_hpg.sh: port $PORT is already in use on $node; pick another with --port" >&2
        exit 1
    fi
    url="http://127.0.0.1:$PORT/?token=$MDCIF_SERVER_TOKEN"
    cat <<EOF

mdcif-server is starting on compute node $node${SLURM_JOB_ID:+ (Slurm job $SLURM_JOB_ID)}.

1. In another terminal on the login node, open the tunnel and leave it running:

     ssh -N -L $PORT:127.0.0.1:$PORT $node

   (VS Code connected to the login node: then forward port $PORT in the Ports panel.)

2. Open this link in your browser (it holds the access token; don't share it):

     $url

Stop the server with Ctrl-C here.

EOF
    export PYTHONPATH="$ROOT/src" PYTHONUNBUFFERED=1
    exec "$PYTHON" -m mdcif_server --port "$PORT" --workers "$WORKERS" --data-dir "$DATA_DIR" \
        "${EXTRA[@]}"
}

if (( ON_NODE )); then
    [[ -n "${MDCIF_SERVER_TOKEN:-}" ]] || die "--on-node is internal (no token in the environment)"
    on_node
fi

case "$DATA_DIR" in
    /tmp|/tmp/*) die "--data-dir must be visible on compute nodes (/blue, not /tmp)" ;;
esac
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

# The token travels in the environment (srun exports it), never on a command line, where
# every user of the node could read it with ps.
MDCIF_SERVER_TOKEN="$(PYTHONPATH='' "$PYTHON" -c 'import secrets; print(secrets.token_urlsafe(32))')"
export MDCIF_SERVER_TOKEN

if (( HERE )); then
    on_node
fi

exec srun --account="$ACCOUNT" --qos="$QOS" --ntasks=1 --cpus-per-task="$CPUS" --mem="$MEM" \
    --time="$TIME" --job-name=mdcif-server --quit-on-interrupt \
    "$ROOT/scripts/start_hpg.sh" --on-node --port "$PORT" --workers "$WORKERS" \
    --data-dir "$DATA_DIR" -- "${EXTRA[@]}"
