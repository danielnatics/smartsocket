import { SocketItem, STORAGE_KEY } from '../types';

export function loadSavedSockets(): SocketItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('Failed to load saved sockets from localStorage:', err);
  }
  return [];
}

export function saveSocketsToStorage(sockets: SocketItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sockets));
  } catch (err) {
    console.error('Failed to save sockets to localStorage:', err);
  }
}
