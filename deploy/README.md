# Home deployment (Atlas `vm api`)

`api.girke.dev` moves from Hostinger to Atlas VM 3500 (quantself ADR 0045, "Girke API on Atlas").

```text
client -> api.girke.dev (CNAME to Vercel) -> Vercel project girke-api-edge (vercel-edge/)
       -> https://gate.tail555ca5.ts.net:10000 (Gate Funnel) -> Gate Caddy 127.0.0.1:8803 (gate/)
       -> tailnet girke-api:8080 (tailscale serve) -> edge Caddy -> girke-api:3000 | Boards files
```

Same pattern as `meet.girke.dev`. Measured through Vercel: request bodies of 120 MB pass;
the proxy gives up after 120 s, so long media must use async transcription jobs.
An unauthenticated upload over ~5 MB gets 502 instead of 401, because the API answers
before reading the body.

## Release

`home/girke-deploy` runs every minute from `girke-deploy.timer` inside the VM. It
fetches `main` over HTTPS (the repo is public, so nothing pushes into the VM),
builds `girke-api:<sha>` and `girke-whisper:<sha>`, migrates, recreates the API and
Whisper, and requires `/health` plus `/version` = `<sha>` within 90 s. Any failure
restores the previous release and records the SHA as failed until `main` moves on.
Several merges in a row deploy as the newest one.

```sh
girke-deploy status
girke-deploy --ref <branch-or-sha>   # staging only
journalctl -u girke-deploy
```

## Setup

1. Atlas: `ssh atlas-ops sudo -n /usr/local/libexec/agent-ops/vm-service 3500 create`, then `... vm-service 3500 up`.
2. Copy `home/` into the VM and run `setup-vm.sh` with a `tag:girke-api` auth key on stdin.
3. Put the Hostinger `.env` at `/srv/girke-api/.env` (0600) and the Boards files in
   `/srv/girke-api/boards`; restore the Postgres dump; `girke-deploy --ref main`;
   `systemctl enable --now girke-deploy.timer`.
4. Gate (Owner sudo once): `sudo bash gate/install.sh girke-api.<tailnet>.ts.net`.
5. Vercel: `cd vercel-edge && vercel deploy --prod`, then add `api.girke.dev` to the project.
