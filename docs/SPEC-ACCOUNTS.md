# Accounts and roles

Two problems with v0.4.0-beta.4 and earlier:

1. **Anyone can do anything.** Every account can create, rename and delete channels. The only check is
   that you can delete only your own messages.
2. **Logins get lost.** An account is one random token, saved on one PC.
   - The PC saves it under the exact server URL (`token:http://100.91.169.79:3001`) in a
     safeStorage-encrypted file.
   - If decryption fails, or the server is reached through another address, the app silently shows
     onboarding.
   - The user's name is taken, so they pick a new one and become a new account. There is no way back.
     (dzk has three accounts this way. Decryption fails after updates on a Windows Insider build.)

No passwords and no codes to copy (the user's call: they are fragile). Instead:

## 1. Never lose the saved login (desktop)

- **Key by server id.** The server has a permanent random `serverId`. It is sent in `bootstrap.serverId`
  and in `GET /api/info`, and the app saves logins as `token:id:<serverId>`.
  - A localStorage map `url → serverId` lets `init()` find the token without a network round trip.
  - Connecting to a URL with no known id calls `/api/info` first.
  - Legacy `token:<url>` entries are still read and are migrated to the id key on the first bootstrap
    that carries `serverId`.
  - Avatar and attachment uploads use the same lookup.
- **Two copies.** Each secrets.json entry keeps the safeStorage-encrypted value **and** a plain copy.
  - The plain copy is used when decryption fails or encryption is unavailable.
  - On a successful read the encrypted copy is re-encrypted if needed.
  - Older files that only have `enc` keep working.
  - (Decision: DPAPI adds little against malware running as the same user, and losing identities is the
    real problem.)
- **No silent failure.**
  - If an entry exists but no copy can be read, the renderer is told, and onboarding shows a notice
    instead of quietly offering a new name.
  - The main process writes `[nexo]` warnings and errors to `<userData>/logs/main.log`, rotated at
    about 1 MB with one old file kept.

## 2. Roles (server enforced, UI gated)

`users.role`: `owner` | `admin` | `member`.

| Action | member | admin | owner |
|---|---|---|---|
| chat, own messages, voice, share, profile | ✓ | ✓ | ✓ |
| create / rename / delete channels | | ✓ | ✓ |
| delete anyone's message | | ✓ | ✓ |
| approve / deny sign-in requests | (own account only) | ✓ | ✓ |
| remove a member's account | | ✓ | ✓ |
| remove an admin's account, set admin/member | | | ✓ |

- **Exactly one owner.** On a new server the first account becomes owner. On migration, the oldest
  account becomes owner, if there is no owner yet.
- **The owner can't be removed or demoted from the app.** `nexo-server owner <name>` (server-cli, works on
  the DB directly like `rename-user`) moves ownership.
- **Server error strings:** "Only admins can manage channels", "Only admins can delete other people's
  messages", and so on.
- **Old clients and old servers.**
  - Old clients still show every button; the server refuses with those messages.
  - New clients treat a missing `role` as `admin`, because old servers check no permissions.
- **Removing an account.**
  - Deletes its messages (with attachment files), avatar, tokens and device links, then the user row.
  - Broadcasts `user:removed` and disconnects its sockets.
  - It frees the name.
  - Any later connection with that account's token gets `UNKNOWN_TOKEN`.

## 3. "Welcome back" via Tailscale

Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48) are authenticated by WireGuard keys, so a
connection from one is that device.

- **Device links.** Table `user_devices(user_id, address, last_seen_at)`. Every accepted socket connection
  whose remote address (IPv4-mapped IPv6 unwrapped) is a Tailscale address upserts a row.
  - Never trust `X-Forwarded-For` or any header.
  - Behind a proxy the address is not Tailscale, so the feature just stays off.
- **`GET /api/info`** returns `recognized`: the accounts linked to the caller's address, most recent
  first. It is `[]` otherwise.
- **The claim.** Handshake `{ claim: userId }` is accepted only if the caller's address is linked to that
  user. The server issues a new token for the account, as an extra login next to its others. Otherwise it
  rejects with `NOT_RECOGNIZED`.
- **The app's side.** With no saved login (first run, unreadable secret, or a new URL), the app calls
  `/api/info`.
  - If `recognized` is non-empty, onboarding first shows **"Welcome back"** with the account(s) (avatar,
    name, color). There is a **Continue** button per account and a "Not me — create a new account" link.

## 4. Sign-in requests (last resort)

This is for a new PC, or a connection from outside Tailscale.

- **Onboarding.** When the chosen name is taken, onboarding offers **"This is my account"**.
  - `POST /api/access-requests { name, password? }` creates a request, kept in memory with a 10 minute TTL.
  - The server password is required when the server has one.
  - Limits: at most 3 pending requests per address and 20 in total, and one pending request per account
    (a new one replaces the old).
- **Notifying approvers.** The server emits `access:request` to admins/owner and to the target account's
  own sockets, and includes pending requests in their `bootstrap.accessRequests`.
  - The app shows a banner: "**dzk** wants to sign in on a new device (100.77.123.46) — Approve / Deny".
- **Answering.** `access:respond` approves or denies. Either way the server emits `access:resolved` to the
  same audience.
  - Approve creates a new token for the account, delivered once to the requester's poll.
- **The requester's app** polls `GET /api/access-requests/:id` every 2 s, showing "Waiting for an admin to
  approve…" with Cancel.
  - Approved: save the token and connect with it.
  - Denied or expired: back to onboarding with a notice.

## 5. Server data changes (additive migrations)

- **`meta(key PRIMARY KEY, value)`**, with `server_id`.
- **`users.role`**: TEXT NOT NULL DEFAULT 'member', plus the owner backfill.
- **`user_tokens(token_hash PRIMARY KEY, user_id REFERENCES users ON DELETE CASCADE, created_at,
  last_used_at)`.**
  - Backfilled from `users.token_hash`, which stays as a legacy column (NOT NULL UNIQUE, so new accounts
    still write their first token hash there).
  - Authentication looks only at `user_tokens`.
- **`user_devices`** as in §3.
- **Logging.** `UNKNOWN_TOKEN` and `NOT_RECOGNIZED` rejections log the address. Claims, requests,
  approvals, role changes and removals are logged.
