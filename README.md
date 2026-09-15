# Commons Cal

Small, self-hosted calendars for communities. Organizers make plans in a private
workspace; everyone else views the calendar or subscribes in their own calendar app.

- Public calendar pages with upcoming events, month views, and ICS subscriptions.
- Private organizer links with event creation, editing, and deletion.
- Multiple calendars in one workspace, each with its own public URL and FAQ.
- Optional server-admin sign-in to find calendars and recover organizer links.
- Mobile layouts, keyboard navigation, and light, dark, or device-based appearance.
- React + Vite frontend, Express server, and Radicale calendar storage.

Commons is designed for a small community server. It uses private organizer links
instead of user accounts. **Events, descriptions, meeting links, agenda links, and
FAQs are public.** Only share information suitable for a public calendar.

## Try it locally

Install Node.js 22.12 or newer, then:

```sh
git clone https://github.com/zendesignlabs/commons-cal.git
cd commons-cal
npm ci
npm run dev
```

Do not copy the production `.env.example` for this demo. With no `.env`, the app
runs at `http://127.0.0.1:4010` with synthetic data:

- Public view: `http://127.0.0.1:4010/c/community/`
- Organizer workspace: `http://127.0.0.1:4010/o/local-organizer/`

Demo events reset on restart; settings and workspace records live in ignored
`.local/calendar-data/`. Demo links are deliberately predictable and only for local
use. Production refuses to start with `DEMO_MODE=true`.

## Install on your server

The default Docker Compose setup runs Commons and a dedicated Radicale service.
It creates separate persistent volumes for events and workspace metadata. No
existing calendar server or manually provisioned collection is required.

### 1. Prepare the host

You need:

- A Linux server with Git, OpenSSL, Docker Engine, and the Docker Compose plugin.
- A domain pointing to the server, such as `calendar.example.org`.
- An HTTPS reverse proxy. The example below uses Caddy installed on the host.
- Enough memory for the two containers and builds; start with 1 GB or more.

Install Docker using its [official instructions](https://docs.docker.com/engine/install/).
Clone the repository into the directory where you want to operate it:

```sh
git clone https://github.com/zendesignlabs/commons-cal.git
cd commons-cal
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

### 2. Configure your instance

Edit `.env` with a text editor:

- Set `PUBLIC_ORIGIN` to your exact HTTPS origin, e.g. `https://calendar.example.org`.
  Use no path or trailing slash.
- Paste the generated random value into `SIGNUP_RADICALE_PASSWORD`.
- Keep `DEMO_MODE=false` and `ALLOW_CALENDAR_CREATION=true`.
- Keep the example signup URL and username for the bundled Radicale service.
- Adjust `MAX_CALENDARS` if needed; the default is 25 across the whole instance.

Keep `.env` private. Do not reuse a personal calendar password. Compose refuses to
start the bundled stack with a blank backend password. The bundled service accepts
32–72 byte passwords; `openssl rand -hex 32` produces a suitable 64-character value.

### 3. Build and enable server-admin access

```sh
docker compose build
```

Admin access is optional, but enables organizer-link recovery. Run this command in
**Bash** to prompt privately and generate a password hash (at least 16 characters):

```sh
bash -c 'read -r -s -p "New admin password: " commons_admin_password; printf "\n" >&2; printf "%s" "$commons_admin_password" | docker compose run --rm --no-deps -T commons node scripts/hash-admin-password.mjs; unset commons_admin_password'
```

Copy the output beginning with `scrypt:` into `ADMIN_PASSWORD_HASH` in `.env`.
Save the actual password in your password manager. Leave the variable empty to
keep admin login disabled. There is no default admin password.

### 4. Start the services

```sh
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:4010/readyz
```

The readiness endpoint should return `{"ok":true}`. It checks existing calendar
collections; on an empty instance, it cannot yet verify collection creation.
Creating the first workspace in step 6 checks that path end to end.

Commons binds to host loopback port **4010**. Radicale has no published host port;
only containers on the Compose network can reach it. To use a different host port,
change `PORT` in `.env` and the proxy target together. The container port stays 4010.

### 5. Add HTTPS

With [Caddy](https://caddyserver.com/docs/install) running on the **same host**, add
this site to its Caddyfile, replacing the domain:

```caddyfile
calendar.example.org {
    reverse_proxy 127.0.0.1:4010
}
```

Reload Caddy after validating its configuration. Allow incoming ports 80 and 443
and ensure DNS points to this host. Caddy manages HTTPS certificates for the domain.

For Nginx or another proxy, forward to the same loopback address and preserve the
original `Host` header. For a containerized proxy or a Pangolin tunnel connector,
attach it to this Compose project's network and target **`http://commons:4010`**;
`127.0.0.1` inside a proxy container points to that proxy, not Commons.

Serve Commons at the root of its own domain. Public calendar pages and ICS feeds
must be accessible without an interactive proxy login. Avoid access logs that
record private `/o/` URLs. The Caddy example does not enable access logging.

### 6. Create your first workspace

1. Visit `https://calendar.example.org` and choose **Create a workspace**.
2. Name your calendar and choose its public slug.
3. Save the private organizer URL in your password manager or bookmarks.
4. Share the public `/c/<slug>/` URL with your community.
5. Open the private workspace to add an event and edit the calendar's FAQ.

An organizer can add calendars through **All calendars → Create calendar**. The
same private organizer link then manages every calendar in that workspace.

Visit `https://calendar.example.org/admin` to sign in as the server administrator,
find a calendar, and choose **View access → Copy organizer link**. Review the full
calendar scope before sharing a private link. See [admin operations](docs/admin-links.md).

**Anyone can create a workspace while creation is enabled.** Once your community
has the calendars it needs, set `ALLOW_CALENDAR_CREATION=false` and run
`docker compose up -d` to close creation. This also disables adding calendars to
existing workspaces. Keep the signup storage credentials configured: existing
created calendars still need them.

## Existing Radicale servers and advanced configuration

Use `docker compose -f compose.external.yaml` instead of the default stack to
connect to an existing dedicated Radicale account. See
[configuration](docs/configuration.md) for account permissions, static calendars,
environment variables, and multiple organizer scopes.

## Backups, updates, and recovery

Back up **both volumes**, `.env`, and `config/`. Events live in `radicale_data`;
calendar settings, FAQs, organizer tokens, and the provisioning journal live in
`commons_metadata`. Losing either volume loses part of the installation.

For a consistent backup, briefly stop the services. Run these commands from the
repository directory; use a new backup directory each time:

```sh
umask 077
commons_backup="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$commons_backup"
docker compose stop
docker compose run --rm --no-deps -T --entrypoint tar commons -czf - -C /data . > "$commons_backup/metadata.tar.gz"
docker compose run --rm --no-deps -T --entrypoint tar radicale -czf - -C /data . > "$commons_backup/events.tar.gz"
tar -czf "$commons_backup/config.tar.gz" .env config
git rev-parse HEAD > "$commons_backup/revision.txt"
docker compose up -d
```

Check every command for success and verify the archives with `tar -tzf` before
trusting a backup. Store encrypted copies off-server; these backups contain private
organizer links and backend credentials. With external Radicale, back up its storage
using that server's procedure instead of the `radicale` command above.

To restore on a replacement host, check out the recorded revision, restore `.env`
and `config/`, and run `docker compose build`. With **empty destination volumes**
and services stopped, restore the matching pair of data archives:

```sh
docker compose run --rm --no-deps -T --entrypoint tar commons -xzf - -C /data < /path/to/metadata.tar.gz
docker compose run --rm --no-deps -T --entrypoint tar radicale -xzf - -C /data < /path/to/events.tar.gz
docker compose up -d
```

Restore to an empty installation to avoid merging old and new records. Keep the
original Compose project name (normally the directory name) when operating an
existing installation; changing it can select different volumes. Never use
`docker compose down -v` unless you intend to delete all stored data.

To update, take a backup, review changes, and run:

```sh
git pull --ff-only
docker compose up -d --build
curl --fail http://127.0.0.1:4010/readyz
```

Restarting Commons ends active admin sessions. Organizer links survive restarts.
For a rollback, check out the prior revision and rebuild. If a future release changes
the data format, restore its matching backup too; do not mix incompatible versions.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Container will not start | `docker compose logs --tail=100 commons radicale`; check `.env`, hash format, and volume permissions. |
| Creation fails | Backend password, matching signup username/home path, capacity limit, and Radicale health. |
| Form submission returns 403 | `PUBLIC_ORIGIN` must match the URL in your browser, including scheme and any nonstandard port. |
| Admin login does not stay signed in | Use HTTPS; production session cookies are Secure. |
| Calendar returns 503 | Check Radicale connectivity and credentials, then `/readyz`. |
| Calendar missing after moving files | Check Compose project name and mounted volumes before creating new data. |
| A calendar app updates slowly | Subscription refresh intervals are controlled by the receiving calendar app. |

Review logs before sharing them; never include private links, passwords, `.env`,
workspace journals, or backups in public issues.

## Behavior and limits

- Event editing/deletion applies to a whole recurring series. Complex imported
  recurrence schedules and all-day schedules can have details edited while their
  schedule is preserved; change those schedules with a CalDAV client.
- Calendar FAQs are separate from general Help. Public feeds strip attendee,
  organizer, alarm, and nonessential fields; event text and links remain public.
- Calendar reads are cached for 15 seconds. Stale website data is marked; feeds
  return an error instead of silently publishing stale or empty data on failure.
- Run **one Commons process per metadata volume**. There is no clustered write
  coordination, organizer account system, or invitation email service.
- Calendar creation is limited to 20 requests per hour across the instance;
  event writes to 40 per hour per calendar. Pending creation reservations count
  against `MAX_CALENDARS`, so retries can safely resume after interruptions.

## Development

```sh
npm test
npm run build
```

Tests cover event CRUD, recurrence, safe exports, access boundaries, isolated
calendars and FAQs, workspace provisioning/retries, admin sessions, and conflicts.
The CI workflow runs tests and builds on pushes and pull requests.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and release
secret-scanning guidance.

## License

Copyright 2026 zendesignlabs. Licensed under the GNU Affero General Public License
version 3.0 only ([AGPL-3.0-only](LICENSE)). Third-party dependencies retain their
own licenses.
