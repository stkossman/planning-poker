import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateSessionInput, Invitation, RoundInput, SessionState, VoteInput } from '@planning-poker/shared';
import { request } from './api';
import { VotingRound } from './VotingRound';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

function SessionForm({ invitationToken }: { invitationToken?: string }) {
  const [invitation, setInvitation] = useState<Invitation>();
  const [title, setTitle] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!invitationToken) return;
    const controller = new AbortController();
    request<Invitation>(`/invitations/${invitationToken}`, { signal: controller.signal })
      .then(setInvitation)
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [invitationToken]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const input: CreateSessionInput = { title, nickname };
      const session = invitationToken
        ? await request<SessionState>(`/invitations/${invitationToken}/join`, { method: 'POST', body: JSON.stringify({ nickname }) })
        : await request<SessionState>('/sessions', { method: 'POST', body: JSON.stringify(input) });
      window.location.assign(`/sessions/${session.id}`);
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }
  if (invitationToken && !invitation) {
    return <section><h1>{error ? 'Session unavailable' : 'Opening invitation…'}</h1>
      {error ? <p role="alert">{error}</p> : <p>Checking your invitation.</p>}
      <a href="/">Create a session</a></section>;
  }
  return <section className="form-section">
    <h1>{invitationToken ? 'Join the session' : 'Create a session'}</h1>
    <p className="intro">{invitation ? invitation.title : 'Invite your team with a link.'}</p>
    <form onSubmit={submit}>
      {!invitationToken ? <label>Session name<input name="title" required maxLength={80} value={title}
        onChange={event => setTitle(event.target.value)} placeholder="Sprint planning" autoComplete="off" /></label> : null}
      <label>Your nickname<input name="nickname" required maxLength={32} value={nickname}
        onChange={event => setNickname(event.target.value)} placeholder="Alex" autoComplete="nickname" /></label>
      {error ? <p role="alert" className="error">{error}</p> : null}
      <button disabled={busy} type="submit">{busy ? 'Please wait…' : invitationToken ? 'Join session' : 'Create session'}</button>
    </form>
    <p className="note">{invitationToken ? 'No account needed. Your nickname is visible to this session.' : 'Have an invitation? Open the link to join.'}</p>
  </section>;
}

function Session({ id }: { id: string }) {
  const [session, setSession] = useState<SessionState>();
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const mutationPending = useRef(false);
  const refreshEpoch = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const epoch = refreshEpoch.current;
      try {
        if (mutationPending.current) return;
        const next = await request<SessionState>(`/sessions/${id}`, { signal: controller.signal });
        if (!controller.signal.aborted && !mutationPending.current && epoch === refreshEpoch.current) { setSession(next); setError(''); }
      } catch (error) {
        if (!controller.signal.aborted && !mutationPending.current && epoch === refreshEpoch.current) setError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);
  async function updateSession(action: string, input?: RoundInput | VoteInput) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    refreshEpoch.current += 1;
    setBusy(true);
    setError('');
    try {
      setSession(await request<SessionState>(`/sessions/${id}/${action}`, {
        method: 'POST', ...(input ? { body: JSON.stringify(input) } : {}),
      }));
    } catch (error) { setError(errorMessage(error)); }
    finally { mutationPending.current = false; setBusy(false); }
  }
  function closeSession() {
    if (window.confirm('End this session? New participants will no longer be able to join.')) {
      void updateSession('close');
    }
  }
  const invitationUrl = session?.invitationPath ? new URL(session.invitationPath, window.location.origin).href : '';
  async function copyInvitation() {
    try { await navigator.clipboard.writeText(invitationUrl); setCopyStatus('Invitation copied.'); }
    catch { setCopyStatus('Select and copy the invitation link.'); }
  }
  if (!session) return <section><h1>{error ? 'Session unavailable' : 'Opening session…'}</h1>
    {error ? <p role="alert">{error}</p> : null}<a href="/">Create a session</a></section>;
  return <section>
    <h1>{session.title}</h1>
    <p className="intro">{session.self.role === 'facilitator' ? 'Facilitator access.' : `Joined as ${session.self.nickname}.`}</p>
    {error ? <p role="alert" className="error">{error}</p> : null}
    {session.closedAt ? <p role="status" className="notice">This session has ended. Invitations no longer work.</p> : null}
    {session.invitationPath && !session.closedAt ? <div className="invitation">
      <label htmlFor="invitation">Invitation link</label>
      <div className="invitation-row"><input id="invitation" readOnly value={invitationUrl} onFocus={event => event.target.select()} />
        <button type="button" onClick={copyInvitation}>Copy invitation</button></div>
      <p role="status" className="copy-status">{copyStatus}</p>
    </div> : null}
    <VotingRound session={session} busy={busy} onAction={updateSession} />
    {session.self.role === 'facilitator' && !session.closedAt ? <button type="button" className="danger" onClick={closeSession} disabled={busy}>End session</button> : null}
    <p className="note">Access is saved in this browser for 30 days. Invitations expire after 14 days.</p>
    <a href="/">Create another session</a>
  </section>;
}

export function App() {
  const path = window.location.pathname;
  const sessionId = /^\/sessions\/([a-f0-9-]{36})$/.exec(path)?.[1];
  const invitationToken = /^\/join\/([A-Za-z0-9_-]{43})$/.exec(path)?.[1];
  return <div className="shell"><header><a href="/">Planning Poker</a></header><main>
    {sessionId ? <Session id={sessionId} /> : invitationToken ? <SessionForm invitationToken={invitationToken} /> : path === '/'
      ? <SessionForm /> : <section><h1>Session unavailable</h1><p>This invitation is invalid.</p><a href="/">Create a session</a></section>}
  </main></div>;
}
