# Staff authentication and login traffic

The owner chose internet staff access with on-premises AD, confirmed this VM can
reach AD privately, and explicitly requested no MFA. There is no existing company
SSO/AD FS/Entra service. The implemented integration is direct, certificate-validated
LDAPS username/password verification, retaining application-managed roles and
stable application user IDs. No identity broker or MFA is planned. Public customer
QR submissions do not require a staff login and retain their separate controls.

**AD sign-in is opt-in and has not been connected to the company's AD.** Set
`AUTH_MODE=ad` only after the operator setup and acceptance below. Unconfigured
local development retains PIN sign-in; partial AD settings without an explicit
mode fail closed. AD mode rejects PIN login and old PIN sessions. Both modes use
the existing 12-hour application session limit. No MFA or broker was added.

## Shared pre-authentication budgets

POST `/api/auth` first applies its existing streamed 4-KiB JSON and credential
shape validation. Eligible login attempts reserve PostgreSQL counters before any
user lookup, legacy alias scan, PIN derivation, directory connection or user-row lock:

| Scope | Maximum admissions per fixed 60-second window |
| --- | ---: |
| All staff logins, across every process | 300 |
| One authenticated ingress client IP | 60 |
| One canonical username, across client IPs/processes | 30 |

The canonical selector is the same username used by the selected authentication mode;
case/outer whitespace cannot select a different budget. Unknown usernames count.
Successful and incorrect sign-ins count, as do account lookup failures after a
reservation. Global, client and username counters are updated in that order in one
transaction, separate from the account/session transaction. A budget denial commits
its counters; a later authentication failure cannot roll them back. Saturated
earlier scopes stop allocating later selector rows, bounding table cardinality.
Hits saturate at the limit plus one. Expired rows are removed during reservations.

Exhausted attempts receive JSON HTTP 429, `Cache-Control: no-store`, a `Retry-After`
of 1–60 seconds and no new session cookie. A counter database/schema/grant failure
returns generic HTTP 503 and does not continue authentication. Readiness requires
the counter table. A browser-marked `Sec-Fetch-Site: cross-site` attempt returns 403
before counter work; this header check supplements the existing application
session/cookie controls and is not evidence of a caller's identity.

Local PIN mode retains its five-failed-PIN/15-minute account lockout. AD mode uses
AD's credential/account policies and does not increment or reset PIN counters.
Application active-account checks and session issuance/revocation remain enforced.
Malformed bodies/actions/credentials are rejected before reservations. These are
credential-attempt limits, not limits on all HTTP traffic. Fixed windows can admit
bursts across a minute boundary. A global ceiling can also temporarily delay
legitimate staff during abuse; edge connection/request limits remain deployment
work. These counters do not guarantee protection from denial of service or an AD
domain's lockout policy.

## Trusted internet ingress

For production internet staff ingress, configure a newly generated server-only
`LOGIN_PROXY_SECRET` of 32–128 URL-safe letters/digits/underscore/hyphen. Keep it
out of Git, browser configuration, logs and `NEXT_PUBLIC_` variables. Use a distinct
secret from QR ingress and app-to-app credentials. The reverse proxy must strip
visitor-supplied values and overwrite these headers on staff login requests:

| Header | Proxy-supplied value |
| --- | --- |
| `x-login-proxy-secret` | Exact configured `LOGIN_PROXY_SECRET` |
| `x-login-client-ip` | A single real client IPv4/IPv6 address |

Use the source address established by trusted network ingress, not an arbitrary
visitor `X-Forwarded-For`. If another proxy exists upstream, define and restrict
that trust chain explicitly. Block direct internet access to the Node backend;
retain loopback binding, approved HTTPS and private environment/service handling.

The app compares the secret using a timing-safe check and accepts only a single
valid IP (no lists, hostnames, ports or bracketed IPv6 literals). Equivalent IPv6
spellings share a key. Plain `X-Forwarded-For` is ignored. A configured but malformed
secret, missing/wrong header or invalid address returns 503 before account reads
or reservations; there is no fallback to trusting another header. This secret
authenticates the proxy metadata, never an account or application permission.

Blank/unset `LOGIN_PROXY_SECRET` supports local development: all supplied source
headers are ignored and only global/username budgets apply. This is not the
production internet ingress configuration. With a secret, client/username bucket
selectors use HMAC-SHA256; local selectors use domain-separated SHA256. Raw
usernames/IPs, PINs and passwords are not saved in the table. These are pseudonymous
keys, not a claim of anonymization. Rotating the secret changes client/username
keys; the independent global bucket remains effective.

## Migration and recovery

Apply tracker `0006_login_rate_limits.sql` as the migration owner before deploying
the updated staff server. Grant the runtime role SELECT/INSERT/UPDATE/DELETE on
`app_login_rate_limits` and the restricted backup role SELECT. Web requests never
create tables or migrate. No QR migration/configuration changes are required.

The complete backup catalog and restore drill include the counter table and
restricted restored runtime access. Older archive schemas require a reviewed
upgrade plan before the current restore tool accepts them; never alter migration
checksums or omit the table to bypass validation. See
[self-hosting](SELF-HOSTING.md) and [database recovery](DATABASE-BACKUPS.md).

## Private AD configuration

Install the root lockfile (`ldapts` is pinned at 9.2.0), and apply tracker
`0007_ad_identities.sql` with the migration owner. It adds identity/session columns
to existing tables, requiring no new table grants. Apply 0006 and its grants too
when upgrading older deployments. The QR service does not change. Readiness
checks these columns and local AD configuration; it does **not** probe AD or prove
directory availability.

Store these server-only settings in the protected tracker environment, never in
browser configuration, Git, command arguments or chat:

| Setting | Purpose |
| --- | --- |
| `AUTH_MODE=ad` | Selects password-only AD authentication; no PIN fallback |
| `AD_DIRECTORY_ID` | Stable namespace identifying this directory, 1–64 lowercase letters/digits/underscore/hyphen, starting with a letter/digit |
| `AD_LDAP_URL` | Private `ldaps://` DNS endpoint, normally port 636, with no embedded credentials/query/path |
| `AD_BASE_DN` | Approved search scope containing authorized staff accounts |
| `AD_BIND_DN` | Dedicated restricted reader's distinguished name; never Domain Admin |
| `AD_BIND_PASSWORD` | Reader secret held only in the protected server environment |
| `AD_CA_FILE` | Absolute path to a readable PEM certificate bundle containing the approved directory CA; mandatory, at most 256 KiB |

TLS verifies the certificate chain and hostname, with TLS 1.2 minimum. Plain LDAP,
disabled certificate validation, referrals and automatic rebinding are unsupported.
Reader permissions must allow the six required attributes: `objectGUID`,
`sAMAccountName`, `userAccountControl`, `msDS-User-Account-Control-Computed`,
`pwdLastSet` and `accountExpires`. Missing/malformed values fail closed with a
generic 503. Scope should contain people, not computers/service accounts. The app
does not write to AD, reset passwords, unlock accounts or create directory users.

Staff enter only `sAMAccountName` (for example, `j.doe`), without `DOMAIN\\` or
`@domain`. Case and outer username whitespace normalize; dots/dashes are preserved.
The supported format is 1–64 ASCII letters/digits/dots/dashes/underscores, starting
with a letter/digit. Passwords are nonempty strings of at most 256 characters,
without NUL; leading/trailing spaces remain part of the password. No end-user
password is stored in PostgreSQL, browser storage or logs. LDAP filter values use
structured equality objects, including binary GUID bytes, rather than interpolated
filter syntax or a user-constructed bind DN.

One five-second wall-clock budget covers reader binds, bounded searches, TLS and
the user bind, with two-second individual connection/request limits. The reader
finds exactly one account; the user password binds its returned DN on a separate
connection. AD status/password metadata is reread by immutable GUID after bind.
Disabled/locked, non-user, expired-account/password and must-change-password
accounts cannot authenticate. Wrong credentials, missing accounts and unlinked
accounts receive the same generic 401. Configuration/TLS/reader outages receive
503, without raw directory diagnostics. Ordinary invalid input receives 400.

## Explicit application identity links

AD proves identity; application records still control roles and active status.
There is no automatic admission or linking by username/email. Obtain each
reviewed AD `objectGUID` using approved directory administration and match it to
the existing **application user ID**, preserving that ID, role, inventory and
draft/recovery ownership. A renamed AD username keeps its link; deleting/recreating
the same username with another GUID cannot inherit access. One directory/GUID pair
can belong to only one application user.

The operator command reads owner `DATABASE_URL` and `AD_DIRECTORY_ID` from
`.env.migrate`. Use the same namespace as the runtime. It does not need the reader
password and does not contact AD. Example placeholders, not actual identities:

```bash
npm run auth:link-ad -- --user-id EXISTING_APP_ID --guid REVIEWED_AD_OBJECT_GUID
```

Replacing a link requires `--expected-binding DIRECTORY_ID:OLD_GUID` with the exact
reviewed previous value. A changed/duplicate link fails atomically. A real change
revokes all that user's sessions and writes an audit entry in the same transaction;
an identical link is a no-op. Browser administrators cannot set GUIDs or change
AD passwords/unlocks; Settings shows whether each app account is linked and still
permits application role/activation changes. New AD-mode app accounts have no
usable chosen PIN and remain unable to sign in until explicitly linked.

For an empty database, `npm run admin:provision` with `AUTH_MODE=ad` prompts only
for an app username, then use `auth:link-ad` for its reviewed AD administrator.
Bootstrap still refuses any existing user and is unavailable over HTTP. For an
existing database, **link existing users instead of rerunning provisioning**.
The last-active-admin guard counts app records, not AD availability; verify at
least two reviewed, working linked administrators before cutover. Recovery of a
lost admin identity is an approved operator mapping task, never public bootstrap
or an automatic switch to PIN mode.

## Session approval and revocation

Sessions contain token hashes, the GUID/configuration binding, AD `pwdLastSet`
metadata and the last successful directory-check time; `pwdLastSet` is not a
password hash. Approval is cached for **at most 60 seconds**, using PostgreSQL
timestamps shared across Node processes. After that, authenticated requests must
reread account status/GUID/password metadata through the reader. Initial approval
is timestamped at directory verification; waiting for a SQL lock cannot extend it.
A disabled,
locked, deleted, expired or password-changed identity revokes sessions from that
credential/configuration epoch. Directory failure returns 503 without extending
approval; still-fresh cached approval can operate until its deadline. AD changes
are not instant: this interval and AD replication apply. LDAP and PostgreSQL do
not share a transaction, so a directory change immediately after a successful
check is detected at a later check.

Application deactivation, role changes, logout and relinking retain their existing
SQL locking and session revocation. A late directory reply cannot recreate a
deleted session. Changing directory namespace, endpoint, search scope, reader DN
or CA bundle invalidates sessions through the configuration binding. Reader-secret
rotation alone does not change identity binding. Keep clocks synchronized.
Switching provider rejects the other provider's sessions. Ship API/UI together,
reload old tabs (`app.js?v=68`) and retain the existing shared-device context,
password clearing, draft owner checks and acknowledged sign-out behavior.

Complete database backups retain the explicit GUID mappings and session metadata;
restoration revokes **all** restored sessions before granting application access.
CA/environment/reader secrets require separate protected configuration recovery.
Older archive migration histories require a reviewed upgrade plan; do not bypass
verification or edit recorded checksums. See [database recovery](DATABASE-BACKUPS.md).

## Acceptance before internet access

Synthetic TLS/LDAP, PostgreSQL and Chromium fixtures exercise the implementation;
they have not connected to company AD. An operator must approve the real endpoint,
scope, CA and restricted reader, install protected configuration, migrate and
review every identity link. Verify actual login, directory lockout/expiry/reset/
disablement, reader attribute access, certificate rejection/outages, recovery
administrators and preserved app ownership against the company's policies.
Logon-hour/workstation rules and replication depend on real AD behavior. Configure
the trusted HTTPS ingress above and block direct backend access. No domain,
production service, directory account, live migration or deployment was changed.

Primary references: [ldapts TLS, bind and search APIs](https://github.com/ldapts/ldapts),
[AD objectGUID](https://learn.microsoft.com/en-us/windows/win32/adschema/a-objectguid),
[computed lockout/password-expiry flags](https://learn.microsoft.com/en-us/windows/win32/adschema/a-msds-user-account-control-computed),
[AD pwdLastSet](https://learn.microsoft.com/en-us/windows/win32/adschema/a-pwdlastset) and
[AD account expiry](https://learn.microsoft.com/en-us/windows/win32/adschema/a-accountexpires).
