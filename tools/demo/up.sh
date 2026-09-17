#!/usr/bin/env bash
# A pretend homelab for screenshots and for trying the dashboard: docker-in-docker named
# "homelab", two loop disks, a handful of real small apps as compose stacks, and the
# dashboard built from this checkout watching them. Nothing of the machine it runs on
# but its CPU, memory and sensors shows.
#   tools/demo/up.sh          → http://127.0.0.1:8899
#   tools/demo/up.sh down     → removes it, volumes included
set -euo pipefail
cd "$(dirname "$0")"
NAME=mk-dashboard-demo
PORT=${DEMO_PORT:-8899}

# loop devices belong to the kernel, not to the container: let go of them before it goes
release() { docker exec "$NAME" sh -c 'docker rm -f $(docker ps -aq); umount /srv/backups /srv; losetup -D' >/dev/null 2>&1 || true; }

if [ "${1:-}" = down ]; then
  release
  docker rm -fv "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME" >/dev/null 2>&1 || true
  exit 0
fi

docker build -q -t mk-dashboard:demo --build-arg BUILD_SHA="$(git rev-parse --short HEAD)" ../.. >/dev/null
release
docker rm -fv "$NAME" >/dev/null 2>&1 || true
docker run -d --privileged --name "$NAME" --hostname homelab \
  -p "127.0.0.1:$PORT:8800" -v "$NAME:/var/lib/docker" -e DOCKER_TLS_CERTDIR= docker:28-dind >/dev/null
box() { docker exec -i "$NAME" "$@"; }
until box docker info >/dev/null 2>&1; do sleep 1; done

# two disks of its own, sparse, with something on them so the gauges are not empty
box sh -euc '
  apk add -q e2fsprogs losetup
  disk() { # name size mount used
    truncate -s "$2" "/var/lib/docker/$1.img"
    mkfs.ext4 -q -F "/var/lib/docker/$1.img"
    # /dev in a container is a tmpfs: a loop device the kernel hands out now has no node there yet
    dev=$(losetup -f | cut -d" " -f1); [ -b "$dev" ] || mknod "$dev" b 7 "${dev#/dev/loop}"
    losetup "$dev" "/var/lib/docker/$1.img"
    mkdir -p "$3" && mount "$dev" "$3"
    rmdir "$3/lost+found"
    fallocate -l "$4" "$3/.fill"
  }
  disk srv 120G /srv 46G
  mkdir -p /srv/stacks
  disk backups 500G /srv/backups 310G
'

docker save mk-dashboard:demo | box docker load >/dev/null
tar -C stacks -c . | box tar -C /srv/stacks -x
for stack in proxy gitea vaultwarden miniflux adguard backup ops; do
  box docker compose --project-directory "/srv/stacks/$stack" up -d --quiet-pull
done
echo "http://127.0.0.1:$PORT"
