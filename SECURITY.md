# Security

Report suspected vulnerabilities privately to **zendesignlabs@pm.me**. Include
reproduction steps and the affected commit, using fake calendar data and tokens.
Do not publish real organizer URLs, credentials, backups, or exploitable details
in public issues.

## Access model

Calendar pages, FAQs, event details, meeting links, and ICS feeds are public.
An organizer URL is a bearer credential: everyone holding it can manage all
calendars assigned to that workspace. Server administrators can recover those
links after password authentication. There are no organizer accounts or email
recovery flows.

Use HTTPS. Protect `.env`, private calendar registries, both data volumes, browser
profiles, and backups. Avoid logging `/o/` URLs at the reverse proxy. Do not add
analytics that capture URLs. Run one Commons process per metadata volume.

## Checking a release for secrets

Scan the exact source snapshot and Git history before publishing. For example,
with TruffleHog installed:

```sh
trufflehog filesystem . --no-verification --no-update --fail
trufflehog git file://"$PWD" --no-verification --no-update --fail
```

Run the filesystem scan in a clean checkout without dependencies or runtime data.
Review every finding, including unverified results. These commands do not test
candidate credentials against external services. Pattern scanners cannot identify
every private URL or application-specific organizer token; also review the file
list, examples, commit attribution, and configuration manually. Never dismiss a
real credential just because a scanner calls it unverified.

The repository includes only synthetic development/test credentials. Demo mode
is rejected in production. Production setup generates fresh credentials locally.
