# Server administration

Open `https://your-domain/admin` and enter the server-admin password. No username
is needed. Search the calendar directory, choose **View access**, review every
calendar managed by that workspace, and choose **Copy organizer link**. Share it
privately with the intended organizer. Public view links are separate.

The current app has no organizer contact directory and sends no invitation emails.
Instance settings are read-only; configuration changes require server access.

## Configure or reset the password

There is no default password. Generate a hash using the README's interactive Bash
command, or pipe a password securely into `node scripts/hash-admin-password.mjs`
with Node.js installed. The helper requires at least 16 characters and reads stdin
so the password does not need to appear in process arguments.

Put the resulting `scrypt:...` hash in `ADMIN_PASSWORD_HASH` in `.env`, then run
`docker compose up -d`. With external Radicale, include `-f compose.external.yaml`.
Store the password separately in a password manager. To disable admin login, empty
the variable and recreate the service. No email reset or public setup route exists.

## Sessions and access

Admin access is separate from organizer links. Production uses HTTPS-only,
HttpOnly, SameSite=Strict session cookies. Sessions expire after two hours and end
on logout or server restart. At most 16 sessions are kept in memory. Ten login
attempts per 15 minutes are allowed across the whole instance.

The directory itself contains no organizer tokens. The authenticated access-detail
endpoint returns the selected workspace link with its complete calendar scope.
Backend passwords are never returned to the UI. Anyone who gets a workspace link
can manage every calendar in it, including calendars added later.

If all organizer links are lost, the configured server-admin password can recover
them through this interface. If the admin password is lost, generate a new hash
with server access. Workspace journals and private static configuration also
contain the access data; keep them out of public tickets and screenshots.
