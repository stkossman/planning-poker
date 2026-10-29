export const STANDARD_DECK = ['0', '1', '2', '3', '5', '8', '13', '21', '?'] as const;

export type Role = 'facilitator' | 'participant';
export interface Member {
  id: string;
  nickname: string;
  role: Role;
}
export interface SessionState {
  id: string;
  title: string;
  createdAt: string;
  closedAt: string | null;
  deck: readonly string[];
  self: Member;
  participants: Member[];
  invitationPath?: string;
}
export interface CreateSessionInput {
  title: string;
  nickname: string;
}
export interface JoinSessionInput {
  nickname: string;
}
export interface Invitation {
  title: string;
}
