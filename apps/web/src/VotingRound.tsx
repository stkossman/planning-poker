import type { RoundInput, SessionState, VoteInput } from '@planning-poker/shared';

interface Props {
  session: SessionState;
  busy: boolean;
  onAction: (action: 'votes' | 'reveal' | 'rounds/next', input: RoundInput | VoteInput) => void;
}

export function VotingRound({ session, busy, onAction }: Props) {
  const { round } = session;
  const revealed = round.revealedAt !== null;
  const ownVote = round.votes.find(vote => vote.memberId === session.self.id)?.card;
  const voted = round.votes.filter(vote => vote.hasVoted).length;
  const canManage = session.self.role === 'facilitator' && !session.closedAt;
  return <>
    <section className="deck" aria-labelledby="round-heading">
      <h2 id="round-heading">Round {round.number}</h2>
      <p role="status">{revealed ? 'Votes revealed.' : 'Votes hidden.'} {voted} of {session.participants.length} voted.</p>
      <fieldset disabled={busy || revealed || session.closedAt !== null}>
        <legend>{revealed ? 'Voting is closed for this round' : 'Choose your card'}</legend>
        <div className="vote-cards">
          {session.deck.map(card => <button key={card} type="button"
            aria-label={`Vote ${card}`} aria-pressed={ownVote === card}
            onClick={() => onAction('votes', { roundId: round.id, card })}>{card}</button>)}
        </div>
      </fieldset>
      {ownVote !== undefined ? <p className="vote-confirmation">Your card: {ownVote}</p> : null}
      {canManage ? <div className="round-actions">
        {revealed
          ? <button type="button" disabled={busy} onClick={() => onAction('rounds/next', { roundId: round.id })}>Start next round</button>
          : <button type="button" disabled={busy} onClick={() => onAction('reveal', { roundId: round.id })}>Reveal votes</button>}
      </div> : null}
      <p className="note">{revealed ? 'The next round keeps this story and starts with no votes.' : 'Only your card is visible to you until the facilitator reveals this round.'}</p>
    </section>
    <section className="participants" aria-labelledby="participants-heading">
      <h2 id="participants-heading">Participants</h2>
      <ul aria-label="Round votes">
        {session.participants.map(member => {
          const vote = round.votes.find(item => item.memberId === member.id);
          return <li key={member.id}>
            <span>{member.nickname} {member.id === session.self.id ? '(you)' : ''}</span>
            <span className="vote-status">
              <span className="role">{member.role === 'facilitator' ? 'Facilitator' : 'Participant'}</span>
              <span>{vote?.card !== undefined ? `Card: ${vote.card}` : vote?.hasVoted ? 'Voted' : 'Not voted'}</span>
            </span>
          </li>;
        })}
      </ul>
    </section>
  </>;
}
