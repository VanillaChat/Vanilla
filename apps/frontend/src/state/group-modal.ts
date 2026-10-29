import { createSignal } from 'solid-js';

export type GroupModal = { mode: 'create' } | { mode: 'add'; channelId: string };

const [groupModal, setGroupModal] = createSignal<GroupModal | null>(null);

export { groupModal };
export const openGroupModal = (m: GroupModal) => setGroupModal(m);
export const closeGroupModal = () => setGroupModal(null);
