# Staff authentication and login traffic

The owner chose internet staff access with on-premises AD, confirmed this VM can
reach AD privately, and explicitly requested no MFA. There is no existing company
SSO/AD FS/Entra service. The planned integration is direct, certificate-validated
LDAPS username/password verification, retaining application-managed roles and
stable application user IDs. No identity broker or MFA is planned. Public customer
QR submissions do not require a staff login and retain their separate controls.

**AD sign-in is not implemented in this change.** Staff still use the existing
4–8 digit PIN path and 12-hour application sessions. This change bounds login
traffic before expensive account lookup/credential verification. It does not
approve deployment or make current PIN authentication ready for internet use.

## Shared pre-authentication budgets

POST `/api/auth` first applies its existing streamed 4-KiB JSON and username/PIN
shape validation. Eligible login attempts reserve PostgreSQL counters before any
user lookup, legacy alias scan, PIN derivation or user-row lock:

| Scope | Maximum admissions per fixed 60-second window |
| --- | ---: |
| All staff logins, across every process | 300 |
| One authenticated ingress client IP | 60 |
| One canonical username, across client IPs/processes | 30 |

The canonical selector is the same normalized username used by authentication;
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

The existing five-failed-PIN/15-minute account lockout, row locking, active-account
checks and session issuance/revocation remain enforced after the traffic gate.
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

## Next AD integration

Implement a bounded private LDAPS adapter with trusted CA/hostname verification,
escaped search filters, a restricted directory reader and disabled/locked-account
checks. Passwords must stay server-side transient inputs, without database storage
or logging. Change the staff UI to AD username/password sign-in and reuse this
traffic gate before directory work. The AD mode must not offer a public PIN bypass.

Explicit operator linking must associate immutable AD objectGUIDs with existing
application users while preserving their IDs, roles and recovery ownership; do not
auto-link by matching username/email. Define directory recheck/session invalidation
and operator recovery alongside the adapter. Actual AD addresses, CA certificates,
reader credentials, lockout-policy acceptance and production cutover are separate
operator work. No AD connection or directory change was attempted for this task.

Primary integration reference: [ldapts TLS, bind and search APIs](https://github.com/ldapts/ldapts).
