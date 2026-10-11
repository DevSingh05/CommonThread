import type { ParticipantId } from '../contract';
import { participantLabel } from '../lib/format';

export function Avatar({ id }: { id: ParticipantId }) {
  return (
    <span className={`avatar avatar-${id}`} aria-hidden="true">
      {id === 'human' ? 'Y' : participantLabel[id].charAt(0)}
    </span>
  );
}

export function Name({ id }: { id: ParticipantId }) {
  return <span className={`name name-${id}`}>{participantLabel[id]}</span>;
}

export function SimulatedTag() {
  return (
    <span className="tag tag-simulated" title="Produced by a deterministic demo adapter, not a real provider">
      Simulated
    </span>
  );
}
