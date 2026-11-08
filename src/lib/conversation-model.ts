

// A contact belongs in Requests while a request is pending and no active
// conversation exists; otherwise in General.
export function isPendingRequestContact(contact: { chat_id: string | null; request: { status: string } | null }) {
  return contact.request?.status === 'pending' && contact.chat_id === null;
}

// Mirrors remove_group_member: owner removes admins/members, admins remove members.
export function canRemoveGroupMember(actorRole: string, targetRole: string) {
  return targetRole !== 'owner' && (actorRole === 'owner' || (actorRole === 'admin' && targetRole === 'member'));
}
