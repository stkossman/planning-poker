export const STANDARD_DECK = ['0', '1', '2', '3', '5', '8', '13', '21', '?'] as const;

export type Card = typeof STANDARD_DECK[number];
export type Role = 'facilitator' | 'participant';
export interface Member {
  id: string;
  nickname: string;
  role: Role;
}
export interface RoundVote {
  memberId: string;
  hasVoted: boolean;
  card?: Card;
}
export interface RoundState {
  id: string;
  storyId: string;
  number: number;
  revealedAt: string | null;
  votes: RoundVote[];
}
export interface SessionState {
  id: string;
  title: string;
  createdAt: string;
  closedAt: string | null;
  deck: readonly Card[];
  self: Member;
  participants: Member[];
  round: RoundState;
  invitationPath?: string;
}
export interface CreateSessionInput {
  title: string;
  nickname: string;
}
export interface JoinSessionInput {
  nickname: string;
}
export interface RoundInput {
  roundId: string;
}
export interface VoteInput extends RoundInput {
  card: Card;
}
export interface Invitation {
  title: string;
}
