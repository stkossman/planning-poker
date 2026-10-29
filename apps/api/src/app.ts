import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import type { FastifyError, FastifyReply } from 'fastify';
import { STANDARD_DECK } from '@planning-poker/shared';
import type { CreateSessionInput, JoinSessionInput, Member, RoundInput, SessionState, VoteInput } from '@planning-poker/shared';
import { ACCESS_LIFETIME_SECONDS, openStore } from './store.ts';
import type { StoredSession } from './store.ts';

interface Options {
  databasePath?: string;
  webOrigin?: string;
  secureCookies?: boolean;
  now?: () => number;
  webRoot?: string;
}
const nicknameSchema = { type: 'string', minLength: 1, maxLength: 32, pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
const idSchema = {
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
};
const invitationSchema = {
  type: 'object', required: ['token'], additionalProperties: false,
  properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
};
const cookieName = 'pp_access';
const cookiePath = (id: string) => `/api/sessions/${id}`;

export async function buildApp(options: Options = {}) {
  const store = openStore(options.databasePath ?? ':memory:');
  const now = options.now ?? Date.now;
  const app = Fastify({
    logger: false,
    bodyLimit: 4096,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.addHook('onClose', async () => store.close());
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.origin &&
        request.headers.origin !== (options.webOrigin ?? 'http://localhost:5173')) {
      return reply.code(403).send({ message: 'This origin is not allowed.' });
    }
  });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error.validation) return reply.code(400).send({ message: 'Check the request fields, card, and link format.' });
    const status = error.statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ message: 'The request could not be processed.' });
    }
    return reply.code(500).send({ message: 'The session could not be updated. Please try again.' });
  });
  function setAccess(reply: FastifyReply, id: string, token: string) {
    reply.setCookie(cookieName, token, {
      path: cookiePath(id), httpOnly: true, sameSite: 'strict',
      secure: options.secureCookies ?? false, maxAge: ACCESS_LIFETIME_SECONDS,
    });
  }
  function state(session: StoredSession, self: Member): SessionState {
    const participants = store.members(session.id);
    const round = store.currentRound(session.id);
    const votes = new Map(store.votes(round.id).map(vote => [vote.member_id, vote.card]));
    return {
      id: session.id, title: session.title, createdAt: session.created_at,
      closedAt: session.closed_at, deck: STANDARD_DECK, self,
      participants,
      round: {
        id: round.id, storyId: round.story_id, number: round.number, revealedAt: round.revealed_at,
        votes: participants.map(member => {
          const card = votes.get(member.id);
          return {
            memberId: member.id, hasVoted: card !== undefined,
            ...(card !== undefined && (round.revealed_at || member.id === self.id) ? { card } : {}),
          };
        }),
      },
      ...(self.role === 'facilitator' ? { invitationPath: `/join/${session.invitation}` } : {}),
    };
  }
  const isAvailable = (session: StoredSession | undefined): session is StoredSession =>
    Boolean(session && !session.closed_at && session.expires_at > now());

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post<{ Body: CreateSessionInput }>('/api/sessions', {
    schema: { body: {
      type: 'object', required: ['title', 'nickname'], additionalProperties: false,
      properties: { title: { type: 'string', minLength: 1, maxLength: 80, pattern: nicknameSchema.pattern }, nickname: nicknameSchema },
    } },
  }, async (request, reply) => {
    const title = request.body.title.trim();
    const nickname = request.body.nickname.trim();
    if (!title || !nickname) return reply.code(400).send({ message: 'Session name and nickname cannot be blank.' });
    const created = store.create(title, nickname, now());
    setAccess(reply, created.id, created.token);
    return reply.code(201).send(state(store.session(created.id)!, created.member));
  });
  app.get<{ Params: { token: string } }>('/api/invitations/:token', {
    schema: { params: invitationSchema },
  }, async (request, reply) => {
    const session = store.invitation(request.params.token);
    if (!isAvailable(session)) return reply.code(404).send({ message: 'This session is unavailable.' });
    return { title: session.title };
  });
  app.post<{ Params: { token: string }; Body: JoinSessionInput }>('/api/invitations/:token/join', {
    schema: { params: invitationSchema, body: {
      type: 'object', required: ['nickname'], additionalProperties: false,
      properties: { nickname: nicknameSchema },
    } },
  }, async (request, reply) => {
    const session = store.invitation(request.params.token);
    if (!isAvailable(session)) return reply.code(404).send({ message: 'This session is unavailable.' });
    const nickname = request.body.nickname.trim();
    if (!nickname) return reply.code(400).send({ message: 'Enter a nickname.' });
    if (store.nicknameExists(session.id, nickname)) return reply.code(409).send({ message: 'This nickname is already in use. Choose another.' });
    const joined = store.addMember(session.id, nickname, 'participant', now());
    setAccess(reply, session.id, joined.token);
    return reply.code(201).send(state(session, joined.member));
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id', {
    schema: { params: idSchema },
  }, async (request, reply) => {
    const session = store.session(request.params.id);
    if (!session) return reply.code(404).send({ message: 'This session is unavailable.' });
    const self = store.member(session.id, request.cookies[cookieName] ?? '', now());
    if (!self) return reply.code(401).send({ message: 'Open your invitation to join this session.' });
    return state(session, self);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/close', {
    schema: { params: idSchema },
  }, async (request, reply) => {
    const session = store.session(request.params.id);
    if (!session) return reply.code(404).send({ message: 'This session is unavailable.' });
    const self = store.member(session.id, request.cookies[cookieName] ?? '', now());
    if (!self) return reply.code(401).send({ message: 'Session access is required.' });
    if (self.role !== 'facilitator') return reply.code(403).send({ message: 'Facilitator access is required.' });
    store.closeSession(session.id, now());
    return state(store.session(session.id)!, self);
  });

  function roundAccess(id: string, token: string | undefined, reply: FastifyReply, facilitatorOnly = false) {
    const session = store.session(id);
    if (!session) { reply.code(404).send({ message: 'This session is unavailable.' }); return; }
    const self = store.member(id, token ?? '', now());
    if (!self) { reply.code(401).send({ message: 'Session access is required.' }); return; }
    if (facilitatorOnly && self.role !== 'facilitator') {
      reply.code(403).send({ message: 'Facilitator access is required.' }); return;
    }
    if (session.closed_at) { reply.code(409).send({ message: 'This session has ended.' }); return; }
    return { session, self, round: store.currentRound(id) };
  }
  function checkRound(expectedId: string, currentId: string, reply: FastifyReply) {
    if (expectedId === currentId) return true;
    reply.code(409).send({ message: 'The round has changed. Refresh before trying again.' });
    return false;
  }
  const roundBody = {
    type: 'object', required: ['roundId'], additionalProperties: false,
    properties: { roundId: { type: 'string', format: 'uuid' } },
  };
  app.post<{ Params: { id: string }; Body: VoteInput }>('/api/sessions/:id/votes', {
    schema: { params: idSchema, body: {
      ...roundBody, required: ['roundId', 'card'],
      properties: { ...roundBody.properties, card: { type: 'string', enum: [...STANDARD_DECK] } },
    } },
  }, async (request, reply) => {
    const access = roundAccess(request.params.id, request.cookies[cookieName], reply);
    if (!access) return;
    const { session, self, round } = access;
    if (!checkRound(request.body.roundId, round.id, reply)) return;
    if (round.revealed_at) return reply.code(409).send({ message: 'Voting has closed for this round.' });
    store.saveVote(round.id, self.id, request.body.card);
    return state(session, self);
  });
  app.post<{ Params: { id: string }; Body: RoundInput }>('/api/sessions/:id/reveal', {
    schema: { params: idSchema, body: roundBody },
  }, async (request, reply) => {
    const access = roundAccess(request.params.id, request.cookies[cookieName], reply, true);
    if (!access) return;
    if (!checkRound(request.body.roundId, access.round.id, reply)) return;
    store.revealRound(access.round.id, now());
    return state(access.session, access.self);
  });
  app.post<{ Params: { id: string }; Body: RoundInput }>('/api/sessions/:id/rounds/next', {
    schema: { params: idSchema, body: roundBody },
  }, async (request, reply) => {
    const access = roundAccess(request.params.id, request.cookies[cookieName], reply, true);
    if (!access) return;
    if (!checkRound(request.body.roundId, access.round.id, reply)) return;
    if (!access.round.revealed_at) return reply.code(409).send({ message: 'Reveal this round before starting the next one.' });
    store.nextRound(access.round);
    return state(access.session, access.self);
  });

  if (options.webRoot) {
    await app.register(staticFiles, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ message: 'Not found.' });
    });
  }
  return app;
}
