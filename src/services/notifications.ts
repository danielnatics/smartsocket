import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export async function requestNotificationPermissions(): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      const status = await LocalNotifications.requestPermissions();
      return status.display === 'granted';
    } else if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'granted') return true;
      if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission();
        return perm === 'granted';
      }
    }
  } catch (err) {
    console.warn('Failed to request notification permission:', err);
  }
  return false;
}

export async function sendAppNotification(title: string, body: string, id = Math.floor(Math.random() * 100000)) {
  try {
    if (Capacitor.isNativePlatform()) {
      await LocalNotifications.schedule({
        notifications: [
          {
            title,
            body,
            id,
            schedule: { at: new Date(Date.now() + 100) },
            sound: undefined,
          },
        ],
      });
      return;
    }

    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(title, {
        body,
        icon: '/icons/icon-192.png',
      });
    }
  } catch (err) {
    console.warn('Notification error:', err);
  }
}

// ── Notification IDs (stable so they deduplicate) ──────────────────────────
export const NOTIF_IDS = {
  HIGH_TEMP:    (socketId: string) => parseInt(socketId.replace(/\D/g, '') || '1') * 100 + 1,
  OUTAGE:       (socketId: string) => parseInt(socketId.replace(/\D/g, '') || '1') * 100 + 2,
  RESTORED:     (socketId: string) => parseInt(socketId.replace(/\D/g, '') || '1') * 100 + 3,
  VOLTAGE_TRIP: (socketId: string) => parseInt(socketId.replace(/\D/g, '') || '1') * 100 + 4,
  TIMER_DONE:   (socketId: string) => parseInt(socketId.replace(/\D/g, '') || '1') * 100 + 5,
};

