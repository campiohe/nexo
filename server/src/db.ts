import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Sound, SoundType } from '../../shared/protocol.ts'
import type { Attachment, Channel, ChannelType, Message, Reaction, ReplyPreview, Role, User } from '../../shared/protocol.ts'
import { MAX_REACTIONS_PER_MESSAGE, MESSAGE_PAGE_SIZE, REPLY_PREVIEW_LENGTH } from '../../shared/protocol.ts'
import type { SearchResult } from '../../shared/protocol.ts'
import { MAX_PINS_PER_CHANNEL, MENTION_TOKEN_RE, SEARCH_PAGE_SIZE } from '../../shared/protocol.ts'

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
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    -- v0.7 (added by migrate() to older databases): custom status text (NULL = none), and whether the
    -- profile picture is an animated GIF.
    status_text     TEXT NULL,
    avatar_animated INTEGER NOT NULL DEFAULT 0
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
    created_at  INTEGER NOT NULL,
    -- v0.6 (added by migrate() to older databases): edits, replies, @everyone.
    edited_at         INTEGER NULL,
    -- The message replied to. No foreign key on purpose: when the original is deleted the reply keeps
    -- the id (and its author, cleared when that account is removed) and shows a "deleted" preview.
    reply_to_id       TEXT NULL,
    reply_to_user_id  TEXT NULL,
    mentions_everyone INTEGER NOT NULL DEFAULT 0,
    -- v0.8 (added by migrate() to older databases): pinned by whom ('' once that account is removed) and
    -- when; both NULL = not pinned.
    pinned_by         TEXT NULL,
    pinned_at         INTEGER NULL
  );
  CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (channel_id, created_at);
  -- v0.8: search by author (and account removal).
  CREATE INDEX IF NOT EXISTS messages_by_user ON messages (user_id, created_at);
  -- v0.8: search paging (a \`before\` timestamp → a search rowid bound, see messages.search).
  CREATE INDEX IF NOT EXISTS messages_by_time ON messages (created_at);

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

  -- v0.6: people a message notifies (<@userId> tokens plus the author of the replied message), in order.
  CREATE TABLE IF NOT EXISTS message_mentions (
    message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS message_mentions_by_user ON message_mentions (user_id);

  -- v0.6: reactions. emoji_position orders a message's emoji: given when an emoji is first added and shared
  -- by all its rows, so an emoji keeps its place while anyone still has it. rowid orders the users of an emoji.
  CREATE TABLE IF NOT EXISTS reactions (
    message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    emoji          TEXT NOT NULL,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at     INTEGER NOT NULL,
    emoji_position INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
  );
  CREATE INDEX IF NOT EXISTS reactions_by_user ON reactions (user_id);

  -- v0.8: full-text search (docs/SPEC.md §5.2). messages has a TEXT primary key, so its implicit rowid may be
  -- renumbered by VACUUM and can't key an external-content FTS table. message_search_ids gives every message a
  -- stable integer (INTEGER PRIMARY KEY), which is the rowid of its row in message_search: a contentless FTS5
  -- index (no second copy of the text) over the content without <@userId> mention tokens. Rows are written
  -- by messages.create / messages.edit (and reconciled by migrate()); the trigger drops them with the message,
  -- however it goes (message:delete, channel ON DELETE CASCADE, account removal).
  -- Ids are handed out in createdAt order (new messages are the newest; the backfill goes in createdAt
  -- order), so search pages in id order. indexed_edit is the message's edited_at when its text was indexed
  -- (NULL: never edited), so edits made by an older server after a downgrade are reindexed at the next start.
  CREATE TABLE IF NOT EXISTS message_search_ids (
    id           INTEGER PRIMARY KEY,
    message_id   TEXT NOT NULL UNIQUE,
    indexed_edit INTEGER NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5 (
    body, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS message_search_on_delete AFTER DELETE ON messages BEGIN
    DELETE FROM message_search WHERE rowid = (SELECT id FROM message_search_ids WHERE message_id = old.id);
    DELETE FROM message_search_ids WHERE message_id = old.id;
  END;
  -- v0.8: soundboard clips (audio in <dataDir>/sounds/<id>). Removing an account deletes its sounds
  -- (users.remove does it explicitly to report their ids; the cascade is a safety net).
  CREATE TABLE IF NOT EXISTS sounds (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    emoji       TEXT NULL,
    uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    duration_ms INTEGER NOT NULL,
    type        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sounds_by_uploader ON sounds (uploader_id);
`

export type Db = ReturnType<typeof openDb>

/** The new reaction list of a message (the payload of `message:reactions`). */
export interface ReactionsUpdate {
  messageId: string
  channelId: string
  reactions: Reaction[]
}

/** A row of the user query (userCols in openDb). */
interface UserRow extends Omit<User, 'avatarAnimated'> {
  avatarAnimated: number
}
const toUser = ({ avatarAnimated, ...u }: UserRow): User => ({ ...u, avatarAnimated: avatarAnimated === 1 })
const toUserOpt = (row: unknown): User | undefined => (row ? toUser(row as UserRow) : undefined)
const toUsers = (rows: unknown[]): User[] => (rows as UserRow[]).map(toUser)

/** A row of the message query (msgCols in openDb). */
interface MessageRow {
  id: string
  channelId: string
  userId: string
  content: string
  createdAt: number
  editedAt: number | null
  mentionsEveryone: number
  replyToId: string | null
  replyToUserId: string | null
  /** The replied message's id when it still exists, else null. */
  replyFoundId: string | null
  replyUserId: string | null
  replyContent: string | null
  replyHasAttachments: number
  pinnedBy: string | null
  pinnedAt: number | null
}

// ---------- pins / search / reorder ----------

/** Most words of a search query used (the rest are ignored). */
export const SEARCH_MAX_WORDS = 10

/** What the search index stores for a message: the content (NFC) without `<@userId>` tokens. */
const searchText = (content: string): string => content.normalize('NFC').replace(MENTION_TOKEN_RE, ' ')

/**
 * The words of a search query, as the index's tokenizer (unicode61) sees them: runs of letters, numbers and
 * private-use characters (NFC), at most SEARCH_MAX_WORDS. Never pass raw user input to MATCH: each word is
 * then quoted (searchMatch), so FTS5 syntax (`"`, `*`, `AND`, `col:`, parentheses) is just text.
 */
export function searchWords(query: string): string[] {
  return (query.normalize('NFC').match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []).slice(0, SEARCH_MAX_WORDS)
}

/** FTS5 MATCH expression: every word as a quoted prefix, all required. */
const searchMatch = (words: string[]): string => words.map((w) => `"${w.replaceAll('"', '""')}"*`).join(' AND ')

/**
 * Idempotent, additive migrations for databases created by older versions.
 * (New databases already get every column from SCHEMA.)
 */
function migrate(db: DatabaseSync): void {
  const columns = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
  const userCols = columns('users')
  const msgCols = columns('messages')
  db.exec('BEGIN')
  try {
    // v0.2: profile pictures. NULL = no picture; otherwise the picture's version token.
    if (!userCols.has('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT NULL')
    // v0.5: roles.
    if (!userCols.has('role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member'))")
    }
    // v0.7: custom status text and animated (GIF) profile pictures.
    if (!userCols.has('status_text')) db.exec('ALTER TABLE users ADD COLUMN status_text TEXT NULL')
    if (!userCols.has('avatar_animated')) {
      db.exec('ALTER TABLE users ADD COLUMN avatar_animated INTEGER NOT NULL DEFAULT 0')
    }
    // v0.6: edits, replies and @everyone (message_mentions and reactions are new tables, created by SCHEMA).
    if (!msgCols.has('edited_at')) db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER NULL')
    if (!msgCols.has('reply_to_id')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_id TEXT NULL')
    if (!msgCols.has('reply_to_user_id')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_user_id TEXT NULL')
    if (!msgCols.has('mentions_everyone')) {
      db.exec('ALTER TABLE messages ADD COLUMN mentions_everyone INTEGER NOT NULL DEFAULT 0')
    }
    // Here rather than in SCHEMA: the column may only exist after the ALTER above.
    db.exec(`CREATE INDEX IF NOT EXISTS messages_mentioning_everyone ON messages (channel_id, created_at)
             WHERE mentions_everyone = 1`)
    // v0.8: pins (the index lists a channel's pins; here for the same reason as the one above).
    if (!msgCols.has('pinned_by')) db.exec('ALTER TABLE messages ADD COLUMN pinned_by TEXT NULL')
    if (!msgCols.has('pinned_at')) db.exec('ALTER TABLE messages ADD COLUMN pinned_at INTEGER NULL')
    db.exec(`CREATE INDEX IF NOT EXISTS messages_pinned ON messages (channel_id, pinned_at)
             WHERE pinned_at IS NOT NULL`)
    // v0.8 betas created message_search_ids without indexed_edit: their edited messages get reindexed once.
    if (!columns('message_search_ids').has('indexed_edit')) {
      db.exec('ALTER TABLE message_search_ids ADD COLUMN indexed_edit INTEGER NULL')
    }
    // Edited messages only (few), for reconcileSearchIndex's check of stale entries.
    db.exec('CREATE INDEX IF NOT EXISTS messages_edited ON messages (edited_at) WHERE edited_at IS NOT NULL')
    reconcileSearchIndex(db)
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

/**
 * Brings the search index in line with the messages table (inside migrate()'s transaction): indexes every
 * message that has no entry (all of them, once, on a database from before v0.8; afterwards only messages
 * written by an older server after a downgrade) in createdAt order, reindexes messages edited since their
 * entry was written (by an older server after a downgrade), and drops entries of messages that no longer
 * exist. All are index-only lookups (the edited ones through the partial index messages_edited), so a no-op
 * on every later start costs a few milliseconds.
 *
 * New entries get ids above every existing one, so search's id order stays createdAt order: messages an
 * older server wrote after a downgrade are newer than everything indexed before it. (Only a clock that went
 * backwards under an older server, which didn't keep timestamps increasing, can break that; such a message
 * may then show up out of place in results, see messages.search.)
 */
function reconcileSearchIndex(db: DatabaseSync): void {
  const insertId = db.prepare('INSERT INTO message_search_ids (message_id, indexed_edit) VALUES (?, ?)')
  const insertText = db.prepare('INSERT INTO message_search (rowid, body) VALUES (?, ?)')
  const missing = db.prepare(
    `SELECT id, content, edited_at AS editedAt FROM messages m
     WHERE NOT EXISTS (SELECT 1 FROM message_search_ids s WHERE s.message_id = m.id) ORDER BY created_at, id`,
  )
  for (const row of missing.iterate() as Iterable<{ id: string; content: string; editedAt: number | null }>) {
    insertText.run(insertId.run(row.id, row.editedAt).lastInsertRowid, searchText(row.content))
  }
  const stale = db.prepare(
    `SELECT s.id, m.content, m.edited_at AS editedAt FROM messages m INDEXED BY messages_edited
       JOIN message_search_ids s ON s.message_id = m.id
     WHERE m.edited_at IS NOT NULL AND m.edited_at IS NOT s.indexed_edit`,
  )
  const replaceText = db.prepare('INSERT OR REPLACE INTO message_search (rowid, body) VALUES (?, ?)')
  const markIndexed = db.prepare('UPDATE message_search_ids SET indexed_edit = ? WHERE id = ?')
  for (const row of stale.all() as { id: number; content: string; editedAt: number }[]) {
    replaceText.run(row.id, searchText(row.content))
    markIndexed.run(row.editedAt, row.id)
  }
  const orphans = db
    .prepare(
      `SELECT id FROM message_search_ids s WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = s.message_id)`,
    )
    .all() as { id: number }[]
  const dropText = db.prepare('DELETE FROM message_search WHERE rowid = ?')
  const dropId = db.prepare('DELETE FROM message_search_ids WHERE id = ?')
  for (const { id } of orphans) {
    dropText.run(id)
    dropId.run(id)
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

  const userCols = 'id, name, color, avatar, role, status_text AS statusText, avatar_animated AS avatarAnimated'
  const userColsU =
    'u.id, u.name, u.color, u.avatar, u.role, u.status_text AS statusText, u.avatar_animated AS avatarAnimated'
  const chanCols = 'id, name, type, position'
  // A message row with its reply preview (r = the replied message, NULL when there is none or it was deleted).
  const msgCols = `m.id, m.channel_id AS channelId, m.user_id AS userId, m.content, m.created_at AS createdAt,
    m.edited_at AS editedAt, m.mentions_everyone AS mentionsEveryone, m.reply_to_id AS replyToId,
    m.reply_to_user_id AS replyToUserId, r.id AS replyFoundId, r.user_id AS replyUserId, r.content AS replyContent,
    (r.id IS NOT NULL AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = r.id)) AS replyHasAttachments,
    m.pinned_by AS pinnedBy, m.pinned_at AS pinnedAt`
  const msgFrom = 'messages m LEFT JOIN messages r ON r.id = m.reply_to_id'
  const attCols = 'id, type, width, height, size'
  const soundCols = 'id, name, emoji, uploader_id AS uploaderId, duration_ms AS durationMs, created_at AS createdAt'

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
    userSetStatusText: db.prepare('UPDATE users SET status_text = ? WHERE id = ?'),
    userSetAvatar: db.prepare('UPDATE users SET avatar = ?, avatar_animated = ? WHERE id = ?'),
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

    msgInsert: db.prepare(
      `INSERT INTO messages (id, channel_id, user_id, content, created_at, reply_to_id, reply_to_user_id, mentions_everyone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    msgById: db.prepare(`SELECT ${msgCols} FROM ${msgFrom} WHERE m.id = ?`),
    msgEdit: db.prepare('UPDATE messages SET content = ?, edited_at = ?, mentions_everyone = ? WHERE id = ?'),
    msgDelete: db.prepare('DELETE FROM messages WHERE id = ?'),
    msgMaxCreated: db.prepare('SELECT COALESCE(MAX(created_at), 0) AS t FROM messages'),
    msgLastByOthers: db.prepare(
      'SELECT channel_id AS channelId, MAX(created_at) AS t FROM messages WHERE user_id != ? GROUP BY channel_id',
    ),
    msgHistory: db.prepare(
      `SELECT ${msgCols} FROM ${msgFrom} WHERE m.channel_id = ? AND m.created_at < ?
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    ),
    /** channelId -> newest message by someone else that names `userId` or @everyone. */
    msgLastMention: db.prepare(
      `SELECT channelId, MAX(t) AS t FROM (
         SELECT m.channel_id AS channelId, m.created_at AS t FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
         WHERE mm.user_id = ? AND m.user_id != ?
         UNION ALL
         SELECT channel_id AS channelId, created_at AS t FROM messages WHERE mentions_everyone = 1 AND user_id != ?
       ) GROUP BY channelId`,
    ),
    msgChannels: db.prepare(
      'SELECT id, channel_id AS channelId FROM messages WHERE id IN (SELECT value FROM json_each(?))',
    ),
    msgForgetReplyAuthor: db.prepare('UPDATE messages SET reply_to_user_id = NULL WHERE reply_to_user_id = ?'),

    mentionInsert: db.prepare('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)'),
    mentionDeleteForMessage: db.prepare('DELETE FROM message_mentions WHERE message_id = ?'),
    mentionDeleteForUser: db.prepare('DELETE FROM message_mentions WHERE user_id = ?'),
    /** Mentions of a JSON array of message ids, in the order they were written. */
    mentionsForMessages: db.prepare(
      `SELECT message_id AS messageId, user_id AS userId FROM message_mentions
       WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
    ),

    /** The emoji's position if the message already has it, else after the last one. */
    reactionInsert: db.prepare(
      `INSERT OR IGNORE INTO reactions (message_id, emoji, user_id, created_at, emoji_position)
       VALUES (?1, ?2, ?3, ?4, COALESCE(
         (SELECT emoji_position FROM reactions WHERE message_id = ?1 AND emoji = ?2 LIMIT 1),
         (SELECT COALESCE(MAX(emoji_position), 0) + 1 FROM reactions WHERE message_id = ?1)))`,
    ),
    reactionDelete: db.prepare('DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?'),
    reactionHasEmoji: db.prepare('SELECT 1 AS found FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1'),
    reactionEmojiCount: db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?'),
    reactionDeleteForUser: db.prepare('DELETE FROM reactions WHERE user_id = ? RETURNING message_id AS messageId'),
    /** Reactions of a JSON array of message ids: by emoji position, then in the order they were added. */
    reactionsForMessages: db.prepare(
      `SELECT message_id AS messageId, emoji, user_id AS userId FROM reactions
       WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY emoji_position, rowid`,
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

    // ---------- pins / search / reorder ----------
    pinSet: db.prepare('UPDATE messages SET pinned_by = ?, pinned_at = ? WHERE id = ? AND pinned_at IS NULL'),
    pinClear: db.prepare('UPDATE messages SET pinned_by = NULL, pinned_at = NULL WHERE id = ? AND pinned_at IS NOT NULL'),
    pinCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL'),
    pinMaxAt: db.prepare('SELECT COALESCE(MAX(pinned_at), 0) AS t FROM messages WHERE pinned_at IS NOT NULL'),
    /** A channel's pins, most recently pinned first. */
    pinList: db.prepare(
      `SELECT ${msgCols} FROM ${msgFrom} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL
       ORDER BY m.pinned_at DESC, m.id DESC LIMIT ?`,
    ),
    /** Pins made by a removed account stay, by nobody (''). */
    pinForgetPinner: db.prepare("UPDATE messages SET pinned_by = '' WHERE pinned_by = ?"),
    searchIdGet: db.prepare('SELECT id FROM message_search_ids WHERE message_id = ?'),
    searchIdInsert: db.prepare('INSERT INTO message_search_ids (message_id, indexed_edit) VALUES (?, ?)'),
    searchIdMarkEdit: db.prepare('UPDATE message_search_ids SET indexed_edit = ? WHERE id = ?'),
    /** The search rowid bound for `before`: the id of the first message at or after it (see search). */
    searchBound: db.prepare(
      `SELECT s.id FROM messages m INDEXED BY messages_by_time JOIN message_search_ids s ON s.message_id = m.id
       WHERE m.created_at >= ? ORDER BY m.created_at LIMIT 1`,
    ),
    searchTextSet: db.prepare('INSERT OR REPLACE INTO message_search (rowid, body) VALUES (?, ?)'),
    /**
     * ?1 MATCH expression, ?2 channel id or NULL, ?3 author id or NULL, ?4 before, ?5 limit, ?6 rowid bound.
     * In rowid order (= createdAt order, see reconcileSearchIndex): FTS5 walks its matches newest first from
     * the bound and stops at the limit, instead of collecting and sorting every match (5 ms rather than
     * 150 ms for a one-letter query over 200k messages).
     */
    searchText: db.prepare(
      `SELECT ${msgCols} FROM message_search s
         JOIN message_search_ids i ON i.id = s.rowid
         JOIN messages m ON m.id = i.message_id
         LEFT JOIN messages r ON r.id = m.reply_to_id
       WHERE message_search MATCH ?1 AND s.rowid < ?6 AND (?2 IS NULL OR m.channel_id = ?2)
         AND (?3 IS NULL OR m.user_id = ?3) AND m.created_at < ?4
       ORDER BY s.rowid DESC LIMIT ?5`,
    ),
    /** ?1 author id, ?2 channel id or NULL, ?3 before, ?4 limit. */
    searchAuthor: db.prepare(
      `SELECT ${msgCols} FROM ${msgFrom} WHERE m.user_id = ?1 AND (?2 IS NULL OR m.channel_id = ?2) AND m.created_at < ?3
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?4`,
    ),
    chansOfType: db.prepare(`SELECT ${chanCols} FROM channels WHERE type = ? ORDER BY position, created_at`),
    chanSetPosition: db.prepare('UPDATE channels SET position = ? WHERE id = ?'),

    soundsAll: db.prepare(`SELECT ${soundCols} FROM sounds ORDER BY created_at, rowid`),
    soundById: db.prepare(`SELECT ${soundCols}, type FROM sounds WHERE id = ?`),
    soundCount: db.prepare('SELECT COUNT(*) AS n FROM sounds'),
    soundInsert: db.prepare(
      'INSERT INTO sounds (id, name, emoji, uploader_id, duration_ms, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    soundDelete: db.prepare('DELETE FROM sounds WHERE id = ?'),
    soundDeleteForUser: db.prepare('DELETE FROM sounds WHERE uploader_id = ? RETURNING id'),
    soundAllIds: db.prepare('SELECT id FROM sounds'),
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

  /** Groups reaction rows (in display order) by message and emoji. */
  function groupReactions(rows: { messageId: string; emoji: string; userId: string }[]): Map<string, Reaction[]> {
    const out = new Map<string, Map<string, string[]>>()
    for (const { messageId, emoji, userId } of rows) {
      let byEmoji = out.get(messageId)
      if (!byEmoji) out.set(messageId, (byEmoji = new Map()))
      const userIds = byEmoji.get(emoji)
      if (userIds) userIds.push(userId)
      else byEmoji.set(emoji, [userId])
    }
    return new Map([...out].map(([id, byEmoji]) => [id, [...byEmoji].map(([emoji, userIds]) => ({ emoji, userIds }))]))
  }

  /** Reaction lists of the given messages (one query); messages without reactions are absent. */
  function reactionsOf(messageIds: string[]): Map<string, Reaction[]> {
    if (messageIds.length === 0) return new Map()
    const rows = q.reactionsForMessages.all(JSON.stringify(messageIds)) as unknown as {
      messageId: string
      emoji: string
      userId: string
    }[]
    return groupReactions(rows)
  }

  /** `content` cut to REPLY_PREVIEW_LENGTH UTF-16 units, without splitting a surrogate pair. */
  function previewText(content: string): string {
    if (content.length <= REPLY_PREVIEW_LENGTH) return content
    const cut = content.slice(0, REPLY_PREVIEW_LENGTH)
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
  }

  /**
   * Turns message rows (msgCols) into complete Messages: reply preview, and attachments, reactions and
   * mentions with one query each for the whole page.
   */
  function hydrate(rows: MessageRow[]): Message[] {
    const msgs: Message[] = rows.map((r) => {
      let replyTo: ReplyPreview | null = null
      if (r.replyToId !== null) {
        replyTo =
          r.replyFoundId !== null
            ? {
                id: r.replyToId,
                userId: r.replyUserId ?? '',
                content: previewText(r.replyContent ?? ''),
                hasAttachments: r.replyHasAttachments === 1,
                deleted: false,
              }
            : { id: r.replyToId, userId: r.replyToUserId ?? '', content: '', hasAttachments: false, deleted: true }
      }
      return {
        id: r.id,
        channelId: r.channelId,
        userId: r.userId,
        content: r.content,
        createdAt: r.createdAt,
        attachments: [],
        editedAt: r.editedAt,
        replyTo,
        reactions: [],
        mentions: [],
        mentionsEveryone: r.mentionsEveryone === 1,
        pinned: r.pinnedAt !== null ? { by: r.pinnedBy ?? '', at: r.pinnedAt } : null,
      }
    })
    if (msgs.length === 0) return msgs
    const byId = new Map(msgs.map((m) => [m.id, m]))
    const idsJson = JSON.stringify(msgs.map((m) => m.id))
    const atts = q.attForMessages.all(idsJson) as unknown as (Attachment & { messageId: string })[]
    for (const { messageId, ...a } of atts) byId.get(messageId)?.attachments.push({ ...a })
    const mentions = q.mentionsForMessages.all(idsJson) as unknown as { messageId: string; userId: string }[]
    for (const { messageId, userId } of mentions) byId.get(messageId)?.mentions?.push(userId)
    for (const [id, reactions] of reactionsOf([...byId.keys()])) byId.get(id)!.reactions = reactions
    return msgs
  }

  // History is paged by timestamp (`before` = createdAt of the oldest message the client has).
  // To make that exact, message timestamps are kept strictly increasing across the whole server,
  // so two messages never share a createdAt and a page boundary never splits a tie.
  let lastCreatedAt = (q.msgMaxCreated.get() as { t: number }).t
  // Pin times are kept strictly increasing the same way, so "most recently pinned first" has no ties.
  let lastPinnedAt = (q.pinMaxAt.get() as { t: number }).t
  const nextPinTimestamp = () => {
    lastPinnedAt = Math.max(Date.now(), lastPinnedAt + 1)
    return lastPinnedAt
  }

  /** (Re)indexes a message's content for search (in the caller's transaction). `editedAt`: its edited_at. */
  function indexForSearch(messageId: string, content: string, editedAt: number | null) {
    const row = q.searchIdGet.get(messageId) as { id: number } | undefined
    let rowid: number | bigint
    if (row) {
      rowid = row.id
      q.searchIdMarkEdit.run(editedAt, rowid)
    } else {
      rowid = q.searchIdInsert.run(messageId, editedAt).lastInsertRowid
    }
    q.searchTextSet.run(rowid, searchText(content))
  }
  const nextTimestamp = () => {
    lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1)
    return lastCreatedAt
  }

  const users = {
    all: (): User[] => toUsers(q.usersAll.all()),
    get: (id: string): User | undefined => toUserOpt(q.userById.get(id)),
    /** The account a login (device token hash) belongs to. Looks only at user_tokens. */
    byTokenHash: (hash: string): User | undefined => toUserOpt(q.userByToken.get(hash)),
    byName: (name: string): User | undefined => toUserOpt(q.userByName.get(name)),
    owner: (): User | undefined => toUserOpt(q.userOwner.get()),
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
    remove(
      id: string,
    ): { attachmentIds: string[]; soundIds: string[]; messages: number; reactions: ReactionsUpdate[] } | undefined {
      return transaction(() => {
        if (!users.get(id)) return undefined
        const attachmentIds = ids(q.attDeleteForUser.all(id, id))
        // Their soundboard clips (files and `sound:deleted` are the caller's).
        const soundIds = ids(q.soundDeleteForUser.all(id))
        // (Cascades to the reactions on and mentions in these messages.)
        const messages = Number(q.msgDeleteForUser.run(id).changes)
        // Their reactions on other people's messages, whose new lists are returned to be broadcast.
        const reacted = [
          ...new Set((q.reactionDeleteForUser.all(id) as unknown as { messageId: string }[]).map((r) => r.messageId)),
        ]
        q.mentionDeleteForUser.run(id)
        // Replies to their (now deleted) messages forget who wrote the original.
        q.msgForgetReplyAuthor.run(id)
        // Pins they made on other people's messages stay, pinned by nobody ('').
        q.pinForgetPinner.run(id)
        q.tokenDeleteForUser.run(id)
        q.deviceDeleteForUser.run(id)
        q.userDelete.run(id)
        const lists = reactionsOf(reacted)
        const changed = q.msgChannels.all(JSON.stringify(reacted)) as unknown as { id: string; channelId: string }[]
        const reactions = changed.map((m) => ({ messageId: m.id, channelId: m.channelId, reactions: lists.get(m.id) ?? [] }))
        return { attachmentIds, soundIds, messages, reactions }
      })
    },
    /**
     * Changes the given profile fields in one transaction (`statusText` null clears it; the caller validates
     * and normalizes). Undefined if there's no such account.
     */
    updateProfile(id: string, patch: { color?: string; statusText?: string | null }): User | undefined {
      return transaction(() => {
        if (patch.color !== undefined) q.userSetColor.run(patch.color, id)
        if (patch.statusText !== undefined) q.userSetStatusText.run(patch.statusText, id)
        return users.get(id)
      })
    },
    setColor: (id: string, color: string): User | undefined => users.updateProfile(id, { color }),
    /** `avatar` is the picture's version token, or null to clear it (which also clears `animated`). */
    setAvatar(id: string, avatar: string | null, animated = false): User | undefined {
      q.userSetAvatar.run(avatar, avatar !== null && animated ? 1 : 0, id)
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
    /**
     * Sets the order of all channels of `type` (positions 0..n-1 in the order of `ids`) in one transaction.
     * Returns the channels whose position changed, or undefined when `ids` isn't exactly the set of channels
     * of that type (each once).
     */
    reorder(type: ChannelType, ids: string[]): Channel[] | undefined {
      return transaction(() => {
        const current = q.chansOfType.all(type) as unknown as Channel[]
        const byId = new Map(current.map((c) => [c.id, c]))
        if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
          return undefined
        }
        const changed: Channel[] = []
        ids.forEach((id, position) => {
          const channel = byId.get(id)!
          if (channel.position === position) return
          q.chanSetPosition.run(position, id)
          changed.push({ ...channel, position })
        })
        return changed
      })
    },
  }

  const messages = {
    /**
     * Inserts a message and claims `attachmentIds` (pending uploads of `userId`, see attachments.pending)
     * in one transaction. Throws if any of them can't be claimed. `extra.replyTo` must be an existing message
     * of the same channel and `extra.mentions` existing accounts other than `userId` (the caller checks).
     */
    create(
      channelId: string,
      userId: string,
      content: string,
      attachmentIds: string[] = [],
      extra: { replyTo?: { id: string; userId: string }; mentions?: string[]; mentionsEveryone?: boolean } = {},
    ): Message {
      const id = randomUUID()
      return transaction(() => {
        const { replyTo, mentions = [], mentionsEveryone = false } = extra
        q.msgInsert.run(id, channelId, userId, content, nextTimestamp(), replyTo?.id ?? null, replyTo?.userId ?? null, mentionsEveryone ? 1 : 0)
        attachmentIds.forEach((attId, position) => {
          if (!q.attPending.get(attId, userId) || q.attClaim.run(id, position, attId, userId).changes !== 1) {
            throw new Error(`attachment ${attId} is not a pending upload of ${userId}`)
          }
        })
        for (const mentioned of mentions) q.mentionInsert.run(id, mentioned)
        indexForSearch(id, content, null)
        return messages.get(id)!
      })
    },
    get(id: string): Message | undefined {
      const row = q.msgById.get(id) as MessageRow | undefined
      return row && hydrate([row])[0]
    },
    /** Replaces the content and mentions and sets editedAt to now. Undefined if there's no such message. */
    edit(id: string, content: string, mentions: string[], mentionsEveryone: boolean): Message | undefined {
      return transaction(() => {
        const editedAt = Date.now()
        if (q.msgEdit.run(content, editedAt, mentionsEveryone ? 1 : 0, id).changes !== 1) return undefined
        q.mentionDeleteForMessage.run(id)
        for (const mentioned of mentions) q.mentionInsert.run(id, mentioned)
        indexForSearch(id, content, editedAt)
        return messages.get(id)
      })
    },
    /**
     * Adds (`on`) or removes `userId`'s `emoji` reaction (the caller validates the emoji and that the message
     * exists). `changed: false` when it was already so; 'tooMany' when adding a new emoji to a message that
     * already has MAX_REACTIONS_PER_MESSAGE.
     */
    react(messageId: string, userId: string, emoji: string, on: boolean): { changed: boolean; reactions: Reaction[] } | 'tooMany' {
      return transaction(() => {
        let changed: boolean
        if (on) {
          const isNewEmoji = q.reactionHasEmoji.get(messageId, emoji) === undefined
          if (isNewEmoji && (q.reactionEmojiCount.get(messageId) as { n: number }).n >= MAX_REACTIONS_PER_MESSAGE) {
            return 'tooMany'
          }
          changed = q.reactionInsert.run(messageId, emoji, userId, Date.now()).changes === 1
        } else {
          changed = q.reactionDelete.run(messageId, emoji, userId).changes === 1
        }
        return { changed, reactions: reactionsOf([messageId]).get(messageId) ?? [] }
      })
    },
    /** channelId -> createdAt of the newest message by someone else that mentions `userId` or @everyone. */
    lastMentionAt(userId: string): Record<string, number> {
      const out: Record<string, number> = {}
      const rows = q.msgLastMention.all(userId, userId, userId) as unknown as { channelId: string; t: number }[]
      for (const r of rows) out[r.channelId] = r.t
      return out
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
      const rows = q.msgHistory.all(channelId, before, MESSAGE_PAGE_SIZE) as unknown as MessageRow[]
      return hydrate(rows.reverse())
    },

    // ---------- pins / search ----------

    /**
     * Pins (`on`) or unpins a message (the caller checks it exists and who may unpin). `changed: false` when it
     * already was so (nothing written); 'tooMany' when pinning in a channel that has MAX_PINS_PER_CHANNEL.
     */
    pin(messageId: string, userId: string, on: boolean): { changed: boolean; message: Message } | 'tooMany' | undefined {
      return transaction(() => {
        const msg = messages.get(messageId)
        if (!msg) return undefined
        if (on === (msg.pinned != null)) return { changed: false, message: msg }
        if (on) {
          if ((q.pinCount.get(msg.channelId) as { n: number }).n >= MAX_PINS_PER_CHANNEL) return 'tooMany'
          q.pinSet.run(userId, nextPinTimestamp(), messageId)
        } else {
          q.pinClear.run(messageId)
        }
        return { changed: true, message: messages.get(messageId)! }
      })
    },
    /** A channel's pinned messages, most recently pinned first (at most MAX_PINS_PER_CHANNEL). */
    pins(channelId: string): Message[] {
      return hydrate(q.pinList.all(channelId, MAX_PINS_PER_CHANNEL) as unknown as MessageRow[])
    },
    /**
     * One page of search results, newest first: messages containing every word of `words` (each as a prefix;
     * see searchWords), or with no words, every message of `authorId`. Optionally in one channel / by one
     * author, created before `before`.
     *
     * Word searches go in search-id order, which is createdAt order (reconcileSearchIndex), and `before` is
     * turned into an id bound (the first message at or after `before`) so a deep page starts where it
     * should rather than skipping every newer match. `m.created_at < before` stays as well, so a page never
     * holds anything at or after `before` even if the two orders disagree (only possible after an older
     * server ran with a clock that went backwards: such a message may then appear out of place, or be
     * skipped by paging). Filters that match few messages still cost a walk over the word's matches.
     */
    search(words: string[], filter: { channelId?: string; authorId?: string; before?: number } = {}): SearchResult {
      const channelId = filter.channelId ?? null
      const authorId = filter.authorId ?? null
      const before = filter.before ?? Number.MAX_SAFE_INTEGER
      const limit = SEARCH_PAGE_SIZE + 1
      let rows: MessageRow[]
      if (words.length > 0) {
        const bound = filter.before === undefined ? undefined : (q.searchBound.get(before) as { id: number } | undefined)
        const maxId = bound ? bound.id : Number.MAX_SAFE_INTEGER
        rows = q.searchText.all(searchMatch(words), channelId, authorId, before, limit, maxId) as unknown as MessageRow[]
      } else if (authorId !== null) {
        rows = q.searchAuthor.all(authorId, channelId, before, limit) as unknown as MessageRow[]
      } else {
        rows = []
      }
      const hasMore = rows.length > SEARCH_PAGE_SIZE
      return { messages: hydrate(rows.slice(0, SEARCH_PAGE_SIZE)), hasMore }
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

  const sounds = {
    /** The soundboard, oldest first. */
    all: (): Sound[] => q.soundsAll.all() as unknown as Sound[],
    /** A sound with its stored media type (for serving). */
    get: (id: string): (Sound & { type: SoundType }) | undefined => q.soundById.get(id) as (Sound & { type: SoundType }) | undefined,
    count: (): number => (q.soundCount.get() as { n: number }).n,
    /**
     * Records a sound (the file must already be in place) unless the board already has `max` sounds
     * (undefined then). Checked and inserted in one transaction. The caller validates the fields and that the
     * uploader exists.
     */
    create(s: Omit<Sound, 'id' | 'createdAt'> & { id: string; type: SoundType; size: number }, max: number): Sound | undefined {
      return transaction(() => {
        if (sounds.count() >= max) return undefined
        const createdAt = Date.now()
        q.soundInsert.run(s.id, s.name, s.emoji, s.uploaderId, s.durationMs, s.type, s.size, createdAt)
        return { id: s.id, name: s.name, emoji: s.emoji, uploaderId: s.uploaderId, durationMs: s.durationMs, createdAt }
      })
    },
    /** True if it existed. */
    delete: (id: string): boolean => q.soundDelete.run(id).changes === 1,
    allIds: (): Set<string> => new Set(ids(q.soundAllIds.all())),
  }

  const devices = {
    /** Records (or refreshes) that `userId` connected from `address` (an unwrapped Tailscale address). */
    link(userId: string, address: string): void {
      q.deviceUpsert.run(userId, address, Date.now())
    },
    isLinked: (userId: string, address: string): boolean => q.deviceLinked.get(userId, address) !== undefined,
    /** Accounts linked to `address`, most recently seen first. */
    users: (address: string): User[] => toUsers(q.deviceUsers.all(address)),
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
    sounds,
    close(): void {
      if (db.isOpen) db.close()
    },
  }
}
