const listeners = new Set<(skillId: string) => void>();

export function selectSkillForNextRequest(skillId: string): boolean {
  const id = skillId.trim();
  if (!/^skill_[A-Za-z0-9_-]{8,}$/u.test(id)) return false;
  for (const listener of listeners) listener(id);
  return true;
}

export function subscribeComposerSkillSelection(listener: (skillId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
