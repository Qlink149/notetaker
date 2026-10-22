# Worker deploys (DigitalOcean droplet, Vultr registry)

On every push to `phase-2-speaker-identity` that passes the tests, GitHub Actions (`deploy-worker` in
`.github/workflows/ci-deploy.yml`):

1. builds `Dockerfile.worker` and pushes `blr.vultrcr.com/qlink01/meetingid-worker:<git sha>` (and `:latest`);
2. connects to the droplet with the CI deploy key and runs `deploy <git sha> <registry user>`, with the registry
   password on stdin.

On the droplet, `deploy-worker.sh`:

- pulls the image;
- waits until no meeting is processing (`node apps/api/dist/scripts/busy.js` from the new image: running jobs, or
  queued ones due within 2 minutes; benchmarks don't count), up to 30 minutes, and gives up (exit 4) rather than
  cut a meeting short;
- stops the worker with 40 s grace (it finishes or hands back its jobs within 25 s), starts the new image with the
  same limits (850 MB memory, 2.8 GB with swap, port 10000, `/etc/meetingid/worker.env`);
- checks `http://127.0.0.1:10000/health` for a minute; if the new worker is not healthy, starts the previous image
  again (exit 5).

## One-time set-up

**Droplet** (as root):

```sh
install -m 755 deploy-worker.sh /opt/meetingid/deploy-worker.sh
# in /root/.ssh/authorized_keys, one line: the key can only run the deploy script
command="/opt/meetingid/deploy-worker.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... meetingid-ci-deploy
```

The deploy key is `~/.ssh/meetingid-ci-deploy` on the PC that set this up (not the personal
`~/.ssh/meetingid-worker` key, which stays for people).

**GitHub** (repository → Settings → Secrets and variables → Actions → New repository secret):

| Secret | Value |
| --- | --- |
| `VULTR_CR_USERNAME` | registry `qlink01`, "Username" |
| `VULTR_CR_PASSWORD` | registry `qlink01`, "API Key" |
| `DROPLET_SSH_KEY` | the whole private key file `meetingid-ci-deploy` |

## By hand

Deploy a given build: `ssh -i ~/.ssh/meetingid-ci-deploy root@139.59.39.155 "deploy <sha> <registry user>"` with
the registry API key typed on stdin. Roll back: the same with an older sha (images are kept for a week).
