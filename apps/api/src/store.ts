import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Card, Member, Role } from '@planning-poker/shared';

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

export interface StoredRound {
  id: string;
  session_id: string;
  story_id: string;
  number: number;
  revealed_at: string | null;
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

  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > 1) {
    db.close();
    throw new Error('This database requires a newer version of Planning Poker.');
  }
  if (version === 0) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE rounds (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          story_id TEXT NOT NULL,
          number INTEGER NOT NULL CHECK (number > 0),
          revealed_at TEXT,
          UNIQUE(session_id, number)
        );
        CREATE TABLE votes (
          round_id TEXT NOT NULL REFERENCES rounds(id),
          member_id TEXT NOT NULL REFERENCES members(id),
          card TEXT NOT NULL CHECK (card IN ('0', '1', '2', '3', '5', '8', '13', '21', '?')),
          PRIMARY KEY(round_id, member_id)
        );
      `);
      const existing = db.prepare('SELECT id FROM sessions').all() as { id: string }[];
      for (const row of existing) {
        db.prepare('INSERT INTO rounds (id, session_id, story_id, number) VALUES (?, ?, ?, 1)')
          .run(randomUUID(), row.id, randomUUID());
      }
      db.exec('PRAGMA user_version = 1; COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }

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
      db.prepare('INSERT INTO rounds (id, session_id, story_id, number) VALUES (?, ?, ?, 1)')
        .run(randomUUID(), id, randomUUID());
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

  function currentRound(sessionId: string) {
    return db.prepare('SELECT * FROM rounds WHERE session_id = ? ORDER BY number DESC LIMIT 1')
      .get(sessionId) as unknown as StoredRound;
  }
  function votes(roundId: string) {
    return db.prepare('SELECT member_id, card FROM votes WHERE round_id = ?')
      .all(roundId) as unknown as { member_id: string; card: Card }[];
  }
  function saveVote(roundId: string, memberId: string, card: Card) {
    db.prepare(`
      INSERT INTO votes (round_id, member_id, card) VALUES (?, ?, ?)
      ON CONFLICT(round_id, member_id) DO UPDATE SET card = excluded.card
    `).run(roundId, memberId, card);
  }
  function revealRound(roundId: string, now: number) {
    db.prepare('UPDATE rounds SET revealed_at = ? WHERE id = ? AND revealed_at IS NULL')
      .run(new Date(now).toISOString(), roundId);
  }
  function nextRound(round: StoredRound) {
    db.prepare('INSERT INTO rounds (id, session_id, story_id, number) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), round.session_id, round.story_id, round.number + 1);
  }

  return { currentRound, votes, saveVote, revealRound, nextRound, create, session, invitation, addMember, member, members, nicknameExists, closeSession, close: () => db.close() };
}
