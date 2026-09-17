# Security

mk-dashboard holds the docker socket, which makes it root-equivalent on the
host it watches. A way past its sign-in, or a way to make it act for someone
who should not be able to, is a serious bug — please report it privately.

## Reporting

Write to **hi@mateuszkornas.com** with what you found and how to reproduce it.
Please do not open a public issue for a vulnerability. You will get an answer
within a few days; this is a one-person project, so a fix may take a little
longer than that, and you will be told when it ships. Credit in the release
notes if you want it.

## What counts

- Getting in, or running an action, without being who `server/src/auth.ts`
  should require: past the trusted networks, Cloudflare Access, single
  sign-on, basic auth or `DASH_READONLY`.
- Making a signed-in browser act from another site (the mutation guard), or
  getting script to run in the dashboard's pages.
- Reading what should stay masked or out of reach: secrets in a container's
  environment, files outside the configured SQLite and backup directories.
- Anything in the published image or the release workflow that lets someone
  else's code in.

## What does not

- An instance deliberately exposed with no sign-in configured, or with a
  wide `DASH_TRUSTED_CIDRS`: the README says not to. A default that makes
  that mistake easy is still worth a report.
- What someone who can already run actions, or already has the docker
  socket, can do to the host: that is what the socket is.
- Denial of service against a dashboard on your own LAN.

## Supported versions

The latest image, `ghcr.io/mkornas/mk-dashboard:latest`, built from `main`.
There are no maintained older releases.
