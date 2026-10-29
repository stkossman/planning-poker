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
import { INVITATION_LIFETIME_MS } from './store.ts';

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
