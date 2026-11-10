# Timekeeper account operator guide

Run these commands from the repository root as the operator, with the same database path and filesystem access as the service. Build the application and apply its migrations before the first start.

```sh
npm ci
npm run build
npm run db:migrate
npm run account -- provision owner@example.com
```

The account command asks you to enter the password twice with typing hidden. Enter 15–128 Unicode characters on one line. Keep the password in a password manager. The database allows one account and provisioning a second account fails. Start Timekeeper and sign in with the provisioned email and password.

## Restore access

Run the reset command on the host that can access the application's database.

```sh
npm run account -- reset
```

Enter and confirm the replacement password. The command retains the account email, replaces the password, and revokes every session in one transaction. Sign in again with the replacement password. If login has been throttled, wait for the interval shown on the sign-in screen. The application keeps these attempt counters in memory, so restarting it clears them. After restoring a database snapshot, reset the account password before opening the service to clients so any sessions in the snapshot are revoked.

For local automation, the account command accepts a single password line on standard input. Pass it directly from a secret source. The command takes no password argument and requires no email service.

## Storage and HTTPS

Environment variables can be set by the service manager or in the repository's local `.env` file. [Example environment file](../.env.example)

- `TIMEKEEPER_DATABASE_URL` selects the absolute local SQLite file URL, such as `file:/var/lib/timekeeper/timekeeper.sqlite`. The default is `timekeeper.sqlite` in the repository root. Run migrations, the account command and the application with the same value. Keep the database and its SQLite sidecar files in a private directory owned by the service account. Application migrations live under `prisma/app`. The portability fixture uses separate schemas and databases.
- Start with `NODE_ENV=production` behind an HTTPS reverse proxy. Set `TIMEKEEPER_ORIGIN` to the exact browser-visible HTTPS origin, such as `https://timekeeper.example.com`, with no path or trailing slash. Plain HTTP is supported for loopback development only. The Vite development origin is `http://127.0.0.1:5173` by default.
- Fastify binds to `127.0.0.1:3000` by default. Keep the listener accessible only to the proxy and local administration. If the proxy runs on another host or container, set `HOST` to the appropriate internal interface and restrict access at the network boundary.
- Leave `TIMEKEEPER_TRUSTED_PROXY_IPS` unset for direct local use. When the reverse proxy forwards client addresses, set it to a comma-separated list of literal IPs of the immediate proxy peers. Configure the proxy to overwrite incoming `X-Forwarded-For` with the address it observed, and send only one client address. Fastify checks the immediate peer and uses the nearest forwarded address from a trusted peer. The public origin and cookie security come from `TIMEKEEPER_ORIGIN` independent of forwarded headers.
- Keep request body and header logging disabled in the proxy. Timekeeper's request logging includes request IDs and methods and omits URLs, request payloads, and cookies. Run production with dependency debug logging disabled.

## Authentication policy

| Area | Policy |
| --- | --- |
| Passwords | `argon2@0.45.1` produces salted Argon2id hashes with 19,456 KiB, two passes, and parallelism of one. The work factor follows OWASP's baseline. On a macOS ARM64 Apple M1 Max using Node 24.19.0, 20 sequential samples after warm-up had median hash and verify times of 20.4 ms and 20.5 ms and p95 times of 22.1 ms and 22.2 ms. |
| Cookies | `@fastify/cookie@11.1.2` parses and serializes host-only, HttpOnly, SameSite=Strict cookies. HTTPS adds Secure and the `__Host-` prefix. |
| Sessions | Prisma client and SQLite adapter are pinned with the Prisma CLI at 7.10.1. Sessions use a SHA-256 digest of a random 256-bit token. Server expiry and cookie max age are 12 hours from issuance. Login rotates the session presented by the browser. Logout revokes that session. Password change revokes all prior sessions and issues a new one for the current browser. |
| Browser mutations | The configured origin and `X-CSRF-Token` are required. The session endpoint supplies a token derived from the authenticated session cookie or from a separate anonymous cookie with a 30-minute browser lifetime. |
| Login and current-password verification | Each has independent 15-minute windows allowing five attempts per normalized account email and 20 per client address. Both use one process-wide limit of two concurrent password operations. Responses for throttled requests include `Retry-After`. The counters reset on service restart. |

The sign-in shell, liveness, OpenAPI schemas, and session discovery are available before sign-in. Private endpoints require a live session and use `Cache-Control: no-store`. Use the authenticated account ID to scope private queries and mutations.

The pinned Argon2 package ships Linux ARM64 and x64 builds. Application-level hash timings and production startup on a Raspberry Pi 4 or VPS remain deployment checks. [Argon2 release and platform support](https://github.com/ranisalt/node-argon2/releases/tag/v0.45.1) [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
