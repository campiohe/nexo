import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Attachment, Channel, ChannelType, Message, Role, User } from '../../shared/protocol.ts'
import { MESSAGE_PAGE_SIZE } from '../../shared/protocol.ts'

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 2000;

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color       TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    avatar      TEXT NULL,
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member'))
  );

  CREATE TABLE IF NOT EXISTS channels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('text', 'voice')),
    position    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id),
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (channel_id, created_at);

  -- v0.3: chat images. message_id is NULL while the upload is pending (not yet claimed by a message).
  -- Created with IF NOT EXISTS, so older databases simply gain the table.
  CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NULL REFERENCES messages(id) ON DELETE CASCADE,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    type        TEXT NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments (message_id, position);

  -- v0.5 (docs/SPEC-ACCOUNTS.md §5): server id, several logins per account, Tailscale device links.
  CREATE TABLE IF NOT EXISTS meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
  );

  -- Every login (device token) of an account. Authentication looks only here; users.token_hash is the
  -- legacy column (still NOT NULL UNIQUE, so new accounts write their first token hash there too).
  CREATE TABLE IF NOT EXISTS user_tokens (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NULL
  );
  CREATE INDEX IF NOT EXISTS user_tokens_by_user ON user_tokens (user_id);

  -- Tailscale addresses an account connected from (unwrapped, see address.ts).
  CREATE TABLE IF NOT EXISTS user_devices (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address      TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, address)
  );
  CREATE INDEX IF NOT EXISTS user_devices_by_address ON user_devices (address, last_seen_at);
`

export type Db = ReturnType<typeof openDb>

/**
 * Idempotent, additive migrations for databases created by older versions.
 * (New databases already get every column from SCHEMA.)
 */
function migrate(db: DatabaseSync): void {
  const userCols = new Set((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name))
  db.exec('BEGIN')
  try {
    // v0.2: profile pictures. NULL = no picture; otherwise the picture's version token.
    if (!userCols.has('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT NULL')
    // v0.5: roles.
    if (!userCols.has('role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member'))")
    }
    // Exactly one owner: the oldest account, when there is none yet.
    db.exec(`
      UPDATE users SET role = 'owner'
      WHERE id = (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')
    `)
    // Accounts with no login in user_tokens get their legacy one. (On every open, not just once, so accounts
    // created by an older server after a downgrade can still sign in after upgrading again.)
    db.exec(`
      INSERT OR IGNORE INTO user_tokens (token_hash, user_id, created_at, last_used_at)
      SELECT token_hash, id, created_at, NULL FROM users
      WHERE id NOT IN (SELECT user_id FROM user_tokens)
    `)
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('server_id', ?)").run(randomUUID())
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** True when `err` is a SQLite UNIQUE constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

/** Opens (and migrates/seeds) the Nexo database in `dataDir`. Use `':memory:'` for a throwaway DB. */
export function openDb(dataDir: string) {
  let file = ':memory:'
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true })
    file = path.join(dataDir, 'nexo.db')
  }
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  migrate(db)

  const userCols = 'id, name, color, avatar, role'
  const userColsU = 'u.id, u.name, u.color, u.avatar, u.role'
  const chanCols = 'id, name, type, position'
  const msgCols = 'id, channel_id AS channelId, user_id AS userId, content, created_at AS createdAt'
  const attCols = 'id, type, width, height, size'

  const q = {
    usersAll: db.prepare(`SELECT ${userCols} FROM users ORDER BY name`),
    userById: db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`),
    userByToken: db.prepare(
      `SELECT ${userColsU} FROM user_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    ),
    userByName: db.prepare(`SELECT ${userCols} FROM users WHERE name = ?`),
    /** The first account on a server becomes its owner. */
    userInsert: db.prepare(
      `INSERT INTO users (id, name, color, token_hash, created_at, role) VALUES (?, ?, ?, ?, ?,
         CASE WHEN EXISTS (SELECT 1 FROM users WHERE role = 'owner') THEN 'member' ELSE 'owner' END)`,
    ),
    userSetColor: db.prepare('UPDATE users SET color = ? WHERE id = ?'),
    userSetAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
    userSetRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    userOwner: db.prepare(`SELECT ${userCols} FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1`),
    userDelete: db.prepare('DELETE FROM users WHERE id = ?'),

    tokenInsert: db.prepare('INSERT INTO user_tokens (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)'),
    tokenTouch: db.prepare('UPDATE user_tokens SET last_used_at = ? WHERE token_hash = ?'),
    tokenDeleteForUser: db.prepare('DELETE FROM user_tokens WHERE user_id = ?'),

    deviceUpsert: db.prepare(
      `INSERT INTO user_devices (user_id, address, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, address) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ),
    deviceLinked: db.prepare('SELECT 1 AS linked FROM user_devices WHERE user_id = ? AND address = ?'),
    deviceUsers: db.prepare(
      `SELECT ${userColsU} FROM user_devices d JOIN users u ON u.id = d.user_id
       WHERE d.address = ? ORDER BY d.last_seen_at DESC, u.name`,
    ),
    deviceDeleteForUser: db.prepare('DELETE FROM user_devices WHERE user_id = ?'),

    metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),

    chansAll: db.prepare(`SELECT ${chanCols} FROM channels ORDER BY type, position, created_at`),
    chanById: db.prepare(`SELECT ${chanCols} FROM channels WHERE id = ?`),
    chanCount: db.prepare('SELECT COUNT(*) AS n FROM channels'),
    chanNextPos: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels WHERE type = ?'),
    chanInsert: db.prepare('INSERT INTO channels (id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)'),
    chanRename: db.prepare('UPDATE channels SET name = ? WHERE id = ?'),
    chanDelete: db.prepare('DELETE FROM channels WHERE id = ?'),

    msgInsert: db.prepare('INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)'),
    msgById: db.prepare(`SELECT ${msgCols} FROM messages WHERE id = ?`),
    msgDelete: db.prepare('DELETE FROM messages WHERE id = ?'),
    msgMaxCreated: db.prepare('SELECT COALESCE(MAX(created_at), 0) AS t FROM messages'),
    msgLastByOthers: db.prepare(
      'SELECT channel_id AS channelId, MAX(created_at) AS t FROM messages WHERE user_id != ? GROUP BY channel_id',
    ),
    msgHistory: db.prepare(
      `SELECT ${msgCols} FROM messages WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ),

    attInsert: db.prepare(
      'INSERT INTO attachments (id, uploader_id, type, width, height, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    /** Pending, uploaded by the given user. */
    attPending: db.prepare(`SELECT ${attCols} FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL`),
    /** Only attachments that belong to a message are public. */
    attServable: db.prepare('SELECT type, size FROM attachments WHERE id = ? AND message_id IS NOT NULL'),
    attClaim: db.prepare(
      'UPDATE attachments SET message_id = ?, position = ? WHERE id = ? AND uploader_id = ? AND message_id IS NULL',
    ),
    /** Attachments of a JSON array of message ids, in display order. */
    attForMessages: db.prepare(
      `SELECT message_id AS messageId, ${attCols} FROM attachments
       WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY message_id, position`,
    ),
    attDeleteForMessage: db.prepare('DELETE FROM attachments WHERE message_id = ? RETURNING id'),
    attDeleteForChannel: db.prepare(
      'DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?) RETURNING id',
    ),
    attDeletePendingBefore: db.prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ? RETURNING id'),
    attAllIds: db.prepare('SELECT id FROM attachments'),
    /** Everything a user uploaded (pending or sent), plus the attachments of their messages. */
    attDeleteForUser: db.prepare(
      `DELETE FROM attachments WHERE uploader_id = ? OR message_id IN (SELECT id FROM messages WHERE user_id = ?)
       RETURNING id`,
    ),
    msgDeleteForUser: db.prepare('DELETE FROM messages WHERE user_id = ?'),
  }

  /** Runs `fn` in a transaction (rolled back if it throws). */
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  const ids = (rows: unknown[]) => (rows as { id: string }[]).map((r) => r.id)

  /** Fills `attachments` on message rows (one query for the whole page). */
  function withAttachments(rows: Omit<Message, 'attachments'>[]): Message[] {
    const msgs: Message[] = rows.map((r) => ({ ...r, attachments: [] }))
    if (msgs.length === 0) return msgs
    const byId = new Map(msgs.map((m) => [m.id, m]))
    const atts = q.attForMessages.all(JSON.stringify(msgs.map((m) => m.id))) as unknown as (Attachment & {
      messageId: string
    })[]
    for (const { messageId, ...a } of atts) byId.get(messageId)?.attachments.push({ ...a })
    return msgs
  }

  // History is paged by timestamp (`before` = createdAt of the oldest message the client has).
  // To make that exact, message timestamps are kept strictly increasing across the whole server,
  // so two messages never share a createdAt and a page boundary never splits a tie.
  let lastCreatedAt = (q.msgMaxCreated.get() as { t: number }).t
  const nextTimestamp = () => {
    lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1)
    return lastCreatedAt
  }

  const users = {
    all: (): User[] => q.usersAll.all() as unknown as User[],
    get: (id: string): User | undefined => q.userById.get(id) as User | undefined,
    /** The account a login (device token hash) belongs to. Looks only at user_tokens. */
    byTokenHash: (hash: string): User | undefined => q.userByToken.get(hash) as User | undefined,
    byName: (name: string): User | undefined => q.userByName.get(name) as User | undefined,
    owner: (): User | undefined => q.userOwner.get() as User | undefined,
    /**
     * Creates an account with its first login. The first account on a server becomes the owner, later ones
     * members. Throws a UNIQUE violation (see isUniqueViolation) if the name is taken.
     */
    create(name: string, color: string, tokenHash: string): User {
      const id = randomUUID()
      return transaction(() => {
        const now = Date.now()
        q.userInsert.run(id, name, color, tokenHash, now)
        q.tokenInsert.run(tokenHash, id, now, null)
        return users.get(id)!
      })
    },
    /** Adds another login to an account (claims, approved sign-in requests). */
    addToken(userId: string, tokenHash: string): void {
      q.tokenInsert.run(tokenHash, userId, Date.now(), null)
    },
    /** Records that a login was just used. */
    touchToken(tokenHash: string): void {
      q.tokenTouch.run(Date.now(), tokenHash)
    },
    setRole(id: string, role: Role): User | undefined {
      q.userSetRole.run(role, id)
      return users.get(id)
    },
    /**
     * Makes `id` the owner and the previous owner an admin (server CLI `nexo-server owner <name>`).
     * `previous` is the old owner, when there was one and it is another account. Undefined: no such account.
     */
    transferOwnership(id: string): { owner: User; previous?: User } | undefined {
      return transaction(() => {
        if (!users.get(id)) return undefined
        const old = users.owner()
        if (old && old.id !== id) q.userSetRole.run('admin', old.id)
        q.userSetRole.run('owner', id)
        const owner = users.get(id)!
        return old && old.id !== id ? { owner, previous: users.get(old.id) } : { owner }
      })
    },
    /**
     * Deletes an account: its messages (with their attachments), its pending uploads, logins, device links
     * and the row itself, in one transaction. Returns the ids of the deleted attachments (their files, and
     * the avatar file, are the caller's to delete), or undefined if there is no such account.
     */
    remove(id: string): { attachmentIds: string[]; messages: number } | undefined {
      return transaction(() => {
        if (!users.get(id)) return undefined
        const attachmentIds = ids(q.attDeleteForUser.all(id, id))
        const messages = Number(q.msgDeleteForUser.run(id).changes)
        q.tokenDeleteForUser.run(id)
        q.deviceDeleteForUser.run(id)
        q.userDelete.run(id)
        return { attachmentIds, messages }
      })
    },
    setColor(id: string, color: string): User | undefined {
      q.userSetColor.run(color, id)
      return users.get(id)
    },
    /** `avatar` is the picture's version token, or null to clear it. */
    setAvatar(id: string, avatar: string | null): User | undefined {
      q.userSetAvatar.run(avatar, id)
      return users.get(id)
    },
  }

  const channels = {
    all: (): Channel[] => q.chansAll.all() as unknown as Channel[],
    get: (id: string): Channel | undefined => q.chanById.get(id) as Channel | undefined,
    count: (): number => (q.chanCount.get() as { n: number }).n,
    create(name: string, type: ChannelType): Channel {
      const { next } = q.chanNextPos.get(type) as { next: number }
      const channel: Channel = { id: randomUUID(), name, type, position: next }
      q.chanInsert.run(channel.id, name, type, channel.position, Date.now())
      return channel
    },
    rename(id: string, name: string): Channel | undefined {
      q.chanRename.run(name, id)
      return channels.get(id)
    },
    /**
     * Deletes the channel and (via ON DELETE CASCADE) its messages.
     * Returns the ids of the attachments that went with them; their files are the caller's to delete.
     */
    delete(id: string): string[] {
      return transaction(() => {
        const removed = ids(q.attDeleteForChannel.all(id))
        q.chanDelete.run(id)
        return removed
      })
    },
  }

  const messages = {
    /**
     * Inserts a message and claims `attachmentIds` (pending uploads of `userId`, see attachments.pending)
     * in one transaction. Throws if any of them can't be claimed.
     */
    create(channelId: string, userId: string, content: string, attachmentIds: string[] = []): Message {
      const msg: Message = { id: randomUUID(), channelId, userId, content, createdAt: 0, attachments: [] }
      return transaction(() => {
        msg.createdAt = nextTimestamp()
        q.msgInsert.run(msg.id, channelId, userId, content, msg.createdAt)
        attachmentIds.forEach((attId, position) => {
          const att = q.attPending.get(attId, userId) as Attachment | undefined
          if (!att || q.attClaim.run(msg.id, position, attId, userId).changes !== 1) {
            throw new Error(`attachment ${attId} is not a pending upload of ${userId}`)
          }
          msg.attachments.push({ ...att })
        })
        return msg
      })
    },
    get(id: string): Message | undefined {
      const row = q.msgById.get(id) as Omit<Message, 'attachments'> | undefined
      return row && withAttachments([row])[0]
    },
    /** Deletes the message and returns the ids of its attachments (their files are the caller's to delete). */
    delete(id: string): string[] {
      return transaction(() => {
        const removed = ids(q.attDeleteForMessage.all(id))
        q.msgDelete.run(id)
        return removed
      })
    },
    /** channelId -> createdAt of the newest message not written by `userId` (for unread state). */
    lastByOthers(userId: string): Record<string, number> {
      const out: Record<string, number> = {}
      for (const r of q.msgLastByOthers.all(userId) as unknown as { channelId: string; t: number }[]) out[r.channelId] = r.t
      return out
    },
    /** Newest page strictly before `before`, returned oldest-first. */
    history(channelId: string, before = Number.MAX_SAFE_INTEGER): Message[] {
      const rows = q.msgHistory.all(channelId, before, MESSAGE_PAGE_SIZE) as unknown as Omit<Message, 'attachments'>[]
      return withAttachments(rows.reverse())
    },
  }

  const attachments = {
    /** Records a pending upload (the file must already be in place). */
    create(uploaderId: string, a: Omit<Attachment, 'id'>): Attachment {
      const att: Attachment = { id: randomUUID(), ...a }
      q.attInsert.run(att.id, uploaderId, att.type, att.width, att.height, att.size, Date.now())
      return att
    },
    /** The upload if it exists, is still pending and was made by `uploaderId`. */
    pending: (id: string, uploaderId: string): Attachment | undefined =>
      q.attPending.get(id, uploaderId) as Attachment | undefined,
    /** Type and size of an attachment that belongs to a message (pending ones aren't served). */
    servable: (id: string): Pick<Attachment, 'type' | 'size'> | undefined =>
      q.attServable.get(id) as Pick<Attachment, 'type' | 'size'> | undefined,
    /** Deletes pending uploads created before `cutoff` (ms) and returns their ids. */
    deletePendingBefore: (cutoff: number): string[] => ids(q.attDeletePendingBefore.all(cutoff)),
    allIds: (): Set<string> => new Set(ids(q.attAllIds.all())),
  }

  const devices = {
    /** Records (or refreshes) that `userId` connected from `address` (an unwrapped Tailscale address). */
    link(userId: string, address: string): void {
      q.deviceUpsert.run(userId, address, Date.now())
    },
    isLinked: (userId: string, address: string): boolean => q.deviceLinked.get(userId, address) !== undefined,
    /** Accounts linked to `address`, most recently seen first. */
    users: (address: string): User[] => q.deviceUsers.all(address) as unknown as User[],
  }

  const serverId = (q.metaGet.get('server_id') as { value: string }).value

  if (channels.count() === 0) {
    channels.create('general', 'text')
    channels.create('clips-and-memes', 'text')
    channels.create('Lounge', 'voice')
    channels.create('Gaming', 'voice')
  }

  return {
    /** Permanent random id of this server (meta.server_id); clients key saved logins by it. */
    serverId,
    users,
    devices,
    channels,
    messages,
    attachments,
    close(): void {
      if (db.isOpen) db.close()
    },
  }
}
