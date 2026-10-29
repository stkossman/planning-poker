import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { STANDARD_DECK } from '@planning-poker/shared';
import type { SessionState } from '@planning-poker/shared';
import { buildApp } from './app.ts';
import { hashToken, INVITATION_LIFETIME_MS } from './store.ts';

const create = async (app: FastifyInstance) => {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { title: 'Sprint planning', nickname: 'Alex' } });
  assert.equal(response.statusCode, 201);
  return { state: response.json<SessionState>(), cookie: response.cookies[0]!, response };
};
const joinSession = async (app: FastifyInstance, invitationPath: string, nickname = 'Morgan') => {
  const token = invitationPath.split('/').at(-1)!;
  return app.inject({ method: 'POST', url: `/api/invitations/${token}/join`, payload: { nickname } });
};

test('creation returns standard deck and distinct invitation and cookie management access', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie, response } = await create(app);
  assert.deepEqual(state.deck, [...STANDARD_DECK]);
  assert.equal(state.self.role, 'facilitator');
  assert.equal(state.participants.length, 1);
  assert.match(state.invitationPath!, /^\/join\/[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state.invitationPath!.split('/').at(-1), cookie.value);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Strict');
  assert.equal(cookie.path, `/api/sessions/${state.id}`);
  assert.equal(response.body.includes(cookie.value), false);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('invitation preview discloses title only; joining never grants management access', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  const token = state.invitationPath!.split('/').at(-1)!;
  const preview = await app.inject(`/api/invitations/${token}`);
  assert.deepEqual(preview.json(), { title: 'Sprint planning' });
  const joined = await joinSession(app, state.invitationPath!, '  Morgan  ');
  assert.equal(joined.statusCode, 201);
  const participant = joined.json<SessionState>();
  assert.equal(participant.self.role, 'participant');
  assert.equal(participant.self.nickname, 'Morgan');
  assert.equal(participant.invitationPath, undefined);
  assert.equal(participant.participants.length, 2);
  assert.equal(joined.body.includes(cookie.value), false);
  assert.equal(joined.body.includes(token), false);
  assert.equal(joined.body.includes('token_hash'), false);
});

test('participant and anonymous requests cannot end a session or alter its state', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  const joined = await joinSession(app, state.invitationPath!);
  const participantCookie = joined.cookies[0]!;
  const url = `/api/sessions/${state.id}/close`;
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
  const denied = await app.inject({ method: 'POST', url, cookies: { pp_access: participantCookie.value }, headers: { 'x-role': 'facilitator' } });
  assert.equal(denied.statusCode, 403);
  const unchanged = await app.inject({ url: `/api/sessions/${state.id}`, cookies: { pp_access: cookie.value } });
  assert.equal(unchanged.json<SessionState>().closedAt, null);
});

test('facilitator can end a session; ending is idempotent and invitations stop working', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  const url = `/api/sessions/${state.id}/close`;
  const ended = await app.inject({ method: 'POST', url, cookies: { pp_access: cookie.value } });
  assert.equal(ended.statusCode, 200);
  assert.ok(ended.json<SessionState>().closedAt);
  const again = await app.inject({ method: 'POST', url, cookies: { pp_access: cookie.value } });
  assert.equal(again.json<SessionState>().closedAt, ended.json<SessionState>().closedAt);
  assert.equal((await joinSession(app, state.invitationPath!)).statusCode, 404);
  const token = state.invitationPath!.split('/').at(-1)!;
  assert.equal((await app.inject(`/api/invitations/${token}`)).statusCode, 404);
});

test('unknown and malformed links reject access without session data', async t => {
  const app = await buildApp(); t.after(() => app.close());
  for (const token of ['x'.repeat(43), 'invalid']) {
    const response = await app.inject(`/api/invitations/${token}`);
    assert.ok([400, 404].includes(response.statusCode));
    assert.equal(response.body.includes('participants'), false);
    const joined = await app.inject({ method: 'POST', url: `/api/invitations/${token}/join`, payload: { nickname: 'Morgan' } });
    assert.ok([400, 404].includes(joined.statusCode));
  }
  assert.equal((await app.inject('/api/sessions/00000000-0000-4000-8000-000000000000')).statusCode, 404);
  assert.equal((await app.inject('/api/sessions/invalid')).statusCode, 400);
});

test('expired invitation cannot be previewed or used, including at the expiry boundary', async t => {
  let clock = Date.parse('2026-10-29T12:00:00Z');
  const app = await buildApp({ now: () => clock }); t.after(() => app.close());
  const { state } = await create(app);
  clock += INVITATION_LIFETIME_MS;
  const token = state.invitationPath!.split('/').at(-1)!;
  assert.equal((await app.inject(`/api/invitations/${token}`)).statusCode, 404);
  assert.equal((await joinSession(app, state.invitationPath!)).statusCode, 404);
});

test('nickname validation rejects blanks, control characters, long values and non-strings', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state } = await create(app);
  const token = state.invitationPath!.split('/').at(-1)!;
  for (const nickname of ['', '   ', 'x'.repeat(33), 'a\nb', 'a\u0000b', 123, null]) {
    const response = await app.inject({ method: 'POST', url: `/api/invitations/${token}/join`, payload: { nickname } });
    assert.equal(response.statusCode, 400, JSON.stringify(nickname));
  }
});

test('session creation validates title and nickname and refuses injected roles', async t => {
  const app = await buildApp(); t.after(() => app.close());
  for (const payload of [
    { title: ' ', nickname: 'Alex' }, { title: 'x'.repeat(81), nickname: 'Alex' },
    { title: 'Valid', nickname: ' ' }, { title: 'Valid', nickname: 'Alex', role: 'facilitator' },
    { title: 123, nickname: 'Alex' },
  ]) assert.equal((await app.inject({ method: 'POST', url: '/api/sessions', payload })).statusCode, 400);
});

test('join rejects client-supplied role, even with an otherwise valid nickname', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state } = await create(app);
  const token = state.invitationPath!.split('/').at(-1)!;
  const response = await app.inject({ method: 'POST', url: `/api/invitations/${token}/join`, payload: { nickname: 'Morgan', role: 'facilitator' } });
  assert.equal(response.statusCode, 400);
});

test('duplicate nickname returns a conflict instead of adding a duplicate member', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state } = await create(app);
  assert.equal((await joinSession(app, state.invitationPath!, 'alex')).statusCode, 409);
  assert.equal((await joinSession(app, state.invitationPath!)).statusCode, 201);
  assert.equal((await joinSession(app, state.invitationPath!, 'morgan')).statusCode, 409);
});

test('session access is required and tokens do not authorize other sessions', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const first = await create(app);
  const second = await create(app);
  const url = `/api/sessions/${second.state.id}`;
  assert.equal((await app.inject(url)).statusCode, 401);
  assert.equal((await app.inject({ url, cookies: { pp_access: first.cookie.value } })).statusCode, 401);
  assert.equal((await app.inject({ url, cookies: { pp_access: second.state.invitationPath!.split('/').at(-1)! } })).statusCode, 401);
});

test('foreign origin mutations fail and production cookies are secure', async t => {
  const app = await buildApp({ secureCookies: true }); t.after(() => app.close());
  const { cookie } = await create(app);
  assert.equal(cookie.secure, true);
  const response = await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin: 'https://untrusted.example' }, payload: { title: 'Test', nickname: 'Alex' } });
  assert.equal(response.statusCode, 403);
});

test('SQLite restoration preserves members, credentials and closure after API restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'planning-poker-test-'));
  const databasePath = join(directory, 'sessions.sqlite');
  let app = await buildApp({ databasePath });
  try {
    const { state, cookie } = await create(app);
    const joined = await joinSession(app, state.invitationPath!);
    const participantCookie = joined.cookies[0]!;
    await app.close();
    const database = new DatabaseSync(databasePath);
    const hashes = database.prepare('SELECT token_hash FROM members').all();
    assert.ok(hashes.every(row => row.token_hash !== cookie.value && row.token_hash !== participantCookie.value));
    database.close();
    app = await buildApp({ databasePath });
    for (const access of [cookie, participantCookie]) {
      const restored = await app.inject({ url: `/api/sessions/${state.id}`, cookies: { pp_access: access.value } });
      assert.equal(restored.statusCode, 200);
      assert.equal(restored.json<SessionState>().participants.length, 2);
    }
    await app.inject({ method: 'POST', url: `/api/sessions/${state.id}/close`, cookies: { pp_access: cookie.value } });
    await app.close();
    app = await buildApp({ databasePath });
    assert.equal((await joinSession(app, state.invitationPath!, 'Another')).statusCode, 404);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('expired access tokens are rejected by the server even if the cookie is replayed', async t => {
  let clock = Date.parse('2026-10-29T12:00:00Z');
  const app = await buildApp({ now: () => clock }); t.after(() => app.close());
  const { state, cookie } = await create(app);
  clock += 30 * 24 * 60 * 60 * 1000;
  const cookies = { pp_access: cookie.value };
  assert.equal((await app.inject({ url: `/api/sessions/${state.id}`, cookies })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${state.id}/close`, cookies })).statusCode, 401);
});

const roundRequest = (app: FastifyInstance, session: SessionState, token: string, action: string, body: object = {}) =>
  app.inject({ method: 'POST', url: `/api/sessions/${session.id}/${action}`,
    cookies: { pp_access: token }, payload: { roundId: session.round.id, ...body } });
const readSession = async (app: FastifyInstance, id: string, token: string) => {
  const response = await app.inject({ url: `/api/sessions/${id}`, cookies: { pp_access: token } });
  assert.equal(response.statusCode, 200);
  return response.json<SessionState>();
};

test('hidden votes expose only the viewer card, including in vote and join responses', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  const joined = await joinSession(app, state.invitationPath!);
  const participant = joined.json<SessionState>();
  const participantToken = joined.cookies[0]!.value;
  await roundRequest(app, state, cookie.value, 'votes', { card: '13' });
  const submitted = await roundRequest(app, state, participantToken, 'votes', { card: '8' });
  assert.equal(submitted.statusCode, 200);
  assert.deepEqual(submitted.json<SessionState>().round.votes.find(v => v.memberId === state.self.id),
    { memberId: state.self.id, hasVoted: true });
  const host = await readSession(app, state.id, cookie.value);
  assert.deepEqual(host.round.votes.find(v => v.memberId === participant.self.id),
    { memberId: participant.self.id, hasVoted: true });
  assert.equal(host.round.votes.find(v => v.memberId === state.self.id)?.card, '13');
  const late = await joinSession(app, state.invitationPath!, 'Late');
  assert.equal(late.statusCode, 201);
  assert.ok(late.json<SessionState>().round.votes.every(v => v.card === undefined));
});

test('repeating a vote is idempotent; changing it replaces only that member vote', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  for (const card of ['3', '3', '?', '0']) {
    const result = await roundRequest(app, state, cookie.value, 'votes', { card });
    assert.equal(result.statusCode, 200);
    const votes = result.json<SessionState>().round.votes;
    assert.equal(votes.filter(v => v.hasVoted).length, 1);
    assert.equal(votes.find(v => v.memberId === state.self.id)?.card, card);
  }
});

test('invalid cards, malformed round IDs and injected member identities are rejected', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  for (const body of [{ card: 3 }, { card: '4' }, { card: '' }, { card: null },
    { card: '3', memberId: 'another-member' }, { card: '3', roundId: 'bad' }, {}]) {
    assert.equal((await roundRequest(app, state, cookie.value, 'votes', body)).statusCode, 400);
  }
  const current = await readSession(app, state.id, cookie.value);
  assert.equal(current.round.votes.some(v => v.hasVoted), false);
});

test('only facilitator can reveal or advance; forged role headers do not grant permission', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  const joined = await joinSession(app, state.invitationPath!);
  for (const action of ['reveal', 'rounds/next']) {
    const denied = await app.inject({
      method: 'POST', url: `/api/sessions/${state.id}/${action}`,
      cookies: { pp_access: joined.cookies[0]!.value },
      headers: { 'x-role': 'facilitator' }, payload: { roundId: state.round.id },
    });
    assert.equal(denied.statusCode, 403);
  }
  const current = await readSession(app, state.id, cookie.value);
  assert.equal(current.round.revealedAt, null);
  assert.equal(current.round.id, state.round.id);
  assert.equal((await roundRequest(app, state, cookie.value, 'rounds/next')).statusCode, 409);
});

test('reveal publishes identical votes to every viewer and rejects all later changes', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  const joined = await joinSession(app, state.invitationPath!);
  const participantToken = joined.cookies[0]!.value;
  await roundRequest(app, state, cookie.value, 'votes', { card: '?' });
  await roundRequest(app, state, participantToken, 'votes', { card: '21' });
  const reveal = await roundRequest(app, state, cookie.value, 'reveal');
  assert.equal(reveal.statusCode, 200);
  assert.ok(reveal.json<SessionState>().round.revealedAt);
  const host = await readSession(app, state.id, cookie.value);
  const participant = await readSession(app, state.id, participantToken);
  assert.deepEqual(host.round, participant.round);
  assert.equal((await roundRequest(app, state, cookie.value, 'reveal')).json<SessionState>().round.revealedAt, host.round.revealedAt);
  for (const token of [cookie.value, participantToken]) {
    assert.equal((await roundRequest(app, state, token, 'votes', { card: '1' })).statusCode, 409);
  }
  assert.deepEqual((await readSession(app, state.id, participantToken)).round, participant.round);
});

test('next round preserves story, increments number, clears votes and rejects stale retries', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  await roundRequest(app, state, cookie.value, 'votes', { card: '5' });
  await roundRequest(app, state, cookie.value, 'reveal');
  const next = await roundRequest(app, state, cookie.value, 'rounds/next');
  assert.equal(next.statusCode, 200);
  const current = next.json<SessionState>();
  assert.notEqual(current.round.id, state.round.id);
  assert.equal(current.round.storyId, state.round.storyId);
  assert.equal(current.round.number, 2);
  assert.equal(current.round.revealedAt, null);
  assert.ok(current.round.votes.every(v => !v.hasVoted && v.card === undefined));
  for (const action of ['votes', 'reveal', 'rounds/next']) {
    const body = action === 'votes' ? { card: '8' } : {};
    assert.equal((await roundRequest(app, state, cookie.value, action, body)).statusCode, 409);
  }
  assert.equal((await roundRequest(app, current, cookie.value, 'votes', { card: '8' })).statusCode, 200);
});

test('round mutations require unexpired access scoped to the same session and permitted origin', async t => {
  let clock = Date.parse('2026-10-29T12:00:00Z');
  const app = await buildApp({ now: () => clock }); t.after(() => app.close());
  const first = await create(app);
  const other = await create(app);
  for (const action of ['votes', 'reveal', 'rounds/next']) {
    const payload = { roundId: first.state.round.id, ...(action === 'votes' ? { card: '3' } : {}) };
    const url = `/api/sessions/${first.state.id}/${action}`;
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, payload, cookies: { pp_access: other.cookie.value } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, payload, cookies: { pp_access: first.cookie.value },
      headers: { origin: 'https://untrusted.example' } })).statusCode, 403);
  }
  clock += 30 * 24 * 60 * 60 * 1000;
  assert.equal((await roundRequest(app, first.state, first.cookie.value, 'votes', { card: '3' })).statusCode, 401);
  assert.equal((await roundRequest(app, first.state, first.cookie.value, 'reveal')).statusCode, 401);
  assert.equal((await roundRequest(app, first.state, first.cookie.value, 'rounds/next')).statusCode, 401);
});

test('closed sessions reject voting, revealing and next round without changing stored round', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  await app.inject({ method: 'POST', url: `/api/sessions/${state.id}/close`, cookies: { pp_access: cookie.value } });
  for (const action of ['votes', 'reveal', 'rounds/next']) {
    assert.equal((await roundRequest(app, state, cookie.value, action, action === 'votes' ? { card: '3' } : {})).statusCode, 409);
  }
  assert.equal((await readSession(app, state.id, cookie.value)).round.id, state.round.id);
});

test('votes and round state survive restarts; earlier round votes remain in SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'planning-poker-rounds-'));
  const databasePath = join(directory, 'sessions.sqlite');
  let app = await buildApp({ databasePath });
  try {
    const { state, cookie } = await create(app);
    const joined = await joinSession(app, state.invitationPath!);
    const participantToken = joined.cookies[0]!.value;
    await roundRequest(app, state, cookie.value, 'votes', { card: '8' });
    await roundRequest(app, state, participantToken, 'votes', { card: '5' });
    await app.close();
    app = await buildApp({ databasePath });
    const host = await readSession(app, state.id, cookie.value);
    assert.equal(host.round.id, state.round.id);
    assert.equal(host.round.votes.find(v => v.memberId === host.self.id)?.card, '8');
    assert.equal(host.round.votes.filter(v => v.card !== undefined).length, 1);
    await roundRequest(app, state, cookie.value, 'reveal');
    const revealed = (await readSession(app, state.id, participantToken)).round;
    await app.close();
    app = await buildApp({ databasePath });
    assert.deepEqual((await readSession(app, state.id, participantToken)).round, revealed);
    const next = await roundRequest(app, state, cookie.value, 'rounds/next');
    const nextState = next.json<SessionState>();
    await app.close();
    app = await buildApp({ databasePath });
    assert.deepEqual((await readSession(app, state.id, cookie.value)).round, nextState.round);
    const database = new DatabaseSync(databasePath);
    try {
      assert.equal(database.prepare('SELECT count(*) AS n FROM votes WHERE round_id = ?').get(state.round.id)?.n, 2);
      assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 1);
    } finally { database.close(); }
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration upgrades a legacy database without losing existing session or management access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'planning-poker-legacy-'));
  const databasePath = join(directory, 'sessions.sqlite');
  const database = new DatabaseSync(databasePath);
  const id = '00000000-0000-4000-8000-000000000001';
  const token = 'legacy-management-access';
  database.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, invitation TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, closed_at TEXT);
    CREATE TABLE members (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      nickname TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK(role IN ('facilitator','participant')),
      token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, UNIQUE(session_id,nickname));
  `);
  database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL)')
    .run(id, 'Legacy session', 'x'.repeat(43), new Date().toISOString(), Date.now() + INVITATION_LIFETIME_MS);
  database.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy-member', id, 'Alex', 'facilitator', hashToken(token), Date.now() + INVITATION_LIFETIME_MS);
  database.close();
  const app = await buildApp({ databasePath });
  try {
    const state = await readSession(app, id, token);
    assert.equal(state.title, 'Legacy session');
    assert.equal(state.self.role, 'facilitator');
    assert.equal(state.round.number, 1);
    assert.equal(state.round.votes[0]?.hasVoted, false);
    assert.equal((await roundRequest(app, state, token, 'votes', { card: '3' })).statusCode, 200);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('25 independently authenticated participants can vote privately and receive identical revealed results', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const { state, cookie } = await create(app);
  const joined = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    joinSession(app, state.invitationPath!, `Participant ${i + 1}`)));
  assert.ok(joined.every(response => response.statusCode === 201));
  const tokens = joined.map(response => response.cookies[0]!.value);
  await Promise.all(tokens.map((token, i) => roundRequest(app, state, token, 'votes', { card: STANDARD_DECK[i % STANDARD_DECK.length] })));
  for (const token of tokens) {
    const hidden = await readSession(app, state.id, token);
    assert.equal(hidden.round.votes.filter(v => v.hasVoted).length, 25);
    assert.equal(hidden.round.votes.filter(v => v.card !== undefined).length, 1);
  }
  await roundRequest(app, state, cookie.value, 'reveal');
  const expected = (await readSession(app, state.id, cookie.value)).round;
  for (const token of tokens) assert.deepEqual((await readSession(app, state.id, token)).round, expected);
});
