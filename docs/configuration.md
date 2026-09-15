# Configuration

The bundled stack is the simplest starting point; follow the root README first.
These settings are read on startup. Recreate the container after changing `.env`.

## Bring an existing Radicale server

1. Create a dedicated account on your Radicale server. Enable authenticated
   `owner_only` rights; the account must be able to create collections under its
   own `/username/` home. Do not connect a personal calendar account.
2. Copy `.env.example` to `.env`; configure your HTTPS `PUBLIC_ORIGIN` and set
   `SIGNUP_RADICALE_URL` to that account's full home URL, with a trailing slash.
3. Set its `SIGNUP_RADICALE_USERNAME` and `SIGNUP_RADICALE_PASSWORD`, and keep
   `ALLOW_CALENDAR_CREATION=true` to allow workspace creation.
4. Build and start with `docker compose -f compose.external.yaml up -d --build`.
   Use that `-f` argument consistently for all operations, including backups and
   admin password generation. No bundled Radicale container is started.

The URL must be reachable from inside the Commons container. `localhost` there
means Commons itself. Use HTTPS when the backend connection leaves a trusted
private network. See [Radicale's configuration documentation](https://radicale.org/v3.html#configuration).

## Statically configured calendars

To manage calendars through configuration instead of homepage creation, prepare a
**separate existing collection** per calendar in Radicale. These collections must
already exist; use Radicale's web interface or a CalDAV client to create them.

For one calendar, set `RADICALE_URL` to its full collection URL, `RADICALE_USERNAME`,
`RADICALE_PASSWORD`, `CALENDAR_ID`, `CALENDAR_NAME`, and optionally
`CALENDAR_DESCRIPTION`. Generate `ORGANIZER_TOKEN` with `openssl rand -hex 32`.
Set `ALLOW_CALENDAR_CREATION=false`. Remove the signup settings if the instance
has never had dynamically created workspaces.

For multiple calendars:

1. Copy `calendars.example.json` to `config/calendars.json`.
2. Replace the example names, slugs, collection URLs, and usernames.
3. Add the referenced password/token variables to `.env` with fresh values.
4. Set `CALENDARS_FILE=/config/calendars.json` in `.env`.
5. Run `docker compose -f compose.external.yaml up -d --build`.

The registry replaces the single-calendar environment configuration. Each entry
needs a unique `id`, `name`, `organizerTokenEnv`, and `radicale` settings. Optional
`faq` entries use `{ "question": "…", "answer": "…" }` plain-text objects. Use the
same token environment variable on multiple entries to grant one workspace access
to them. The example contains environment variable names, not actual credentials.

Public URLs use `/c/<id>/`; organizer URLs use `/o/<organizer-token>/`. IDs are
stable public slugs. Optional `viewToken` (registry) or `CALENDAR_TOKEN` (single
calendar) values preserve legacy read-only URLs; new deployments do not need them.
Saved names, descriptions, and FAQs override initial registry values on restart.

## Runtime settings

| Variable | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | Canonical HTTPS origin for form validation. |
| `DEMO_MODE` | `false` in production; demo mode is forbidden there. |
| `ALLOW_CALENDAR_CREATION` | Allows both new workspaces and additions to existing ones. |
| `MAX_CALENDARS` | Instance cap, including static calendars and pending reservations; default 25. |
| `SIGNUP_RADICALE_*` | Dedicated storage account for dynamically created calendars. |
| `ADMIN_PASSWORD_HASH` | Scrypt password hash; empty disables admin login. |
| `CALENDARS_FILE` | Optional static registry path inside the container. |
| `CALENDAR_DATA_DIR` | Persistent metadata directory; Compose sets `/data`. |
| `PORT` | Host port in Compose; container always uses 4010. |
| `HOST` | Node listening address; Compose sets `0.0.0.0`. |
| `CONTACT_NAME` | Optional organizer label for the single configured calendar. |

`.env` is interpreted by Docker Compose. Quote values that contain interpolation
characters as described in the [Compose environment documentation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
Generated hex credentials avoid those characters. Do not run `docker compose config`
into a shared log: the expanded output can contain secrets.

## Storage and rotation

`/data/<id>.json` stores editable calendar settings. `/data/.workspaces/registry.json`
stores dynamically created calendars, collection IDs, organizer tokens, and retry
state. Keep the journal private and preserve it with the events volume.

Static organizer access can be rotated by replacing its environment token and
recreating Commons. If that same workspace has dynamically added calendars, stop
Commons and update **all matching journal records** to the same new token too.
For a fully dynamic workspace, stop Commons, back up the journal, generate a fresh
URL-safe token, and replace the old token in every matching record. Restart and
verify the old link is rejected and the new link has the intended scope. There is
no token-rotation UI. Public URLs are unaffected.

Removing a registry entry disables its Commons routes but does not delete its
Radicale collection. Failed creation reservations intentionally remain retryable
and consume capacity. Inspect and back up both systems before manually removing a
reservation or calendar; do not delete unrelated collections.
