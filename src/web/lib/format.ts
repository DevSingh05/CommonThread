import type { ParticipantId, RunStatus, TaskStatus, TurnStatus } from '../contract';

export const participantLabel: Record<ParticipantId, string> = {
  human: 'You',
  claude: 'Claude',
  codex: 'Codex',
  system: 'System',
};

export const runStatusLabel: Record<RunStatus, string> = {
  running: 'Running',
  waiting_for_user: 'Waiting for you',
  paused: 'Paused',
  completed: 'Queue drained',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
};

export const taskStatusLabel: Record<TaskStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_for_agent: 'Waiting for agent',
  waiting_for_user: 'Waiting for you',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const turnStatusLabel: Record<TurnStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTokens(count: number): string {
  return new Intl.NumberFormat().format(Math.round(count));
}
