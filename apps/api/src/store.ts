import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Member, Role } from '@planning-poker/shared';

export const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
export const ACCESS_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

export interface StoredSession {
  id: string;
  title: string;
  invitation: string;
  created_at: string;
  expires_at: number;
  closed_at: string | null;
}

export function openStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      invitation TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      nickname TEXT NOT NULL COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('facilitator', 'participant')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      UNIQUE(session_id, nickname)
    );
    CREATE INDEX IF NOT EXISTS members_session ON members(session_id);
  `);

  function session(id: string) {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as StoredSession | undefined;
  }
  function invitation(token: string) {
    return db.prepare('SELECT * FROM sessions WHERE invitation = ?').get(token) as unknown as StoredSession | undefined;
  }
  function addMember(sessionId: string, nickname: string, role: Role, now: number) {
    const member: Member = { id: randomUUID(), nickname, role };
    const token = newToken();
    db.prepare('INSERT INTO members (id, session_id, nickname, role, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(member.id, sessionId, nickname, role, hashToken(token), now + ACCESS_LIFETIME_SECONDS * 1000);
    return { member, token };
  }
  function create(title: string, nickname: string, now: number) {
    const id = randomUUID();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO sessions (id, title, invitation, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, title, newToken(), new Date(now).toISOString(), now + INVITATION_LIFETIME_MS);
      const access = addMember(id, nickname, 'facilitator', now);
      db.exec('COMMIT');
      return { id, ...access };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function member(sessionId: string, token: string, now: number) {
    return db.prepare('SELECT id, nickname, role FROM members WHERE session_id = ? AND token_hash = ? AND expires_at > ?')
      .get(sessionId, hashToken(token), now) as unknown as Member | undefined;
  }
  function members(sessionId: string) {
    return db.prepare('SELECT id, nickname, role FROM members WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as unknown as Member[];
  }
  function nicknameExists(sessionId: string, nickname: string) {
    return Boolean(db.prepare('SELECT 1 FROM members WHERE session_id = ? AND nickname = ?')
      .get(sessionId, nickname));
  }
  function closeSession(id: string, now: number) {
    db.prepare('UPDATE sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL')
      .run(new Date(now).toISOString(), id);
  }
  return { create, session, invitation, addMember, member, members, nicknameExists, closeSession, close: () => db.close() };
}
