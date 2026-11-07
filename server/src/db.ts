import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Channel, ChannelType, Message, User } from '../../shared/protocol.ts'
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
    created_at  INTEGER NOT NULL
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
`

export type Db = ReturnType<typeof openDb>

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

  const userCols = 'id, name, color'
  const chanCols = 'id, name, type, position'
  const msgCols = 'id, channel_id AS channelId, user_id AS userId, content, created_at AS createdAt'

  const q = {
    usersAll: db.prepare(`SELECT ${userCols} FROM users ORDER BY name`),
    userById: db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`),
    userByToken: db.prepare(`SELECT ${userCols} FROM users WHERE token_hash = ?`),
    userByName: db.prepare(`SELECT ${userCols} FROM users WHERE name = ?`),
    userInsert: db.prepare('INSERT INTO users (id, name, color, token_hash, created_at) VALUES (?, ?, ?, ?, ?)'),
    userSetColor: db.prepare('UPDATE users SET color = ? WHERE id = ?'),

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
    msgHistory: db.prepare(
      `SELECT ${msgCols} FROM messages WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ),
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
    byTokenHash: (hash: string): User | undefined => q.userByToken.get(hash) as User | undefined,
    byName: (name: string): User | undefined => q.userByName.get(name) as User | undefined,
    /** Throws a UNIQUE violation (see isUniqueViolation) if the name is taken. */
    create(name: string, color: string, tokenHash: string): User {
      const user: User = { id: randomUUID(), name, color }
      q.userInsert.run(user.id, name, color, tokenHash, Date.now())
      return user
    },
    setColor(id: string, color: string): User | undefined {
      q.userSetColor.run(color, id)
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
    /** Deletes the channel and (via ON DELETE CASCADE) its messages. */
    delete(id: string): void {
      q.chanDelete.run(id)
    },
  }

  const messages = {
    create(channelId: string, userId: string, content: string): Message {
      const msg: Message = { id: randomUUID(), channelId, userId, content, createdAt: nextTimestamp() }
      q.msgInsert.run(msg.id, channelId, userId, content, msg.createdAt)
      return msg
    },
    get: (id: string): Message | undefined => q.msgById.get(id) as Message | undefined,
    delete(id: string): void {
      q.msgDelete.run(id)
    },
    /** Newest page strictly before `before`, returned oldest-first. */
    history(channelId: string, before = Number.MAX_SAFE_INTEGER): Message[] {
      const rows = q.msgHistory.all(channelId, before, MESSAGE_PAGE_SIZE) as unknown as Message[]
      return rows.reverse()
    },
  }

  if (channels.count() === 0) {
    channels.create('general', 'text')
    channels.create('clips-and-memes', 'text')
    channels.create('Lounge', 'voice')
    channels.create('Gaming', 'voice')
  }

  return {
    users,
    channels,
    messages,
    close(): void {
      if (db.isOpen) db.close()
    },
  }
}
