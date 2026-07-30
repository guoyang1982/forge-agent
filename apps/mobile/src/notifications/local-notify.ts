/**
 * Local notification stubs.
 * Remote/local push via expo-notifications was temporarily disabled because the
 * Android release pulled Firebase Messaging without google-services.json and
 * caused startup crash loops on device. Keep API stable for callers.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  return false;
}

export async function notifyLocal(_input: {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  onlyIfBackground?: boolean;
}): Promise<void> {
  // no-op until notifications are re-enabled with proper FCM setup
}

export async function ensureAndroidNotificationChannel(): Promise<void> {
  // no-op
}

export async function notifyRunFinished(_preview: string): Promise<void> {
  // no-op
}

export async function notifyPermissionNeeded(_summary: string): Promise<void> {
  // no-op
}
