// Written by `npm run messages` from messages/en.json. Do not edit it by hand.

/** The names of the values each message takes, from its `{placeholders}`. */
export const PLACEHOLDERS = {
  'upload.fileTooLarge': ['size'],
  'uploadZone.tooLarge': ['size'],
  'uploadZone.hint': ['size'],
  'vault.notice.extensions': ['example'],
  'vault.mismatch.detail': ['expected', 'actual'],
  'duration.daysHours': ['days', 'hours'],
  'duration.hoursMinutes': ['hours', 'minutes'],
  'duration.minutes': ['minutes'],
  'admin.lockedOut': ['seconds'],
  'admin.rateLimited': ['seconds'],
  'admin.backendUnavailable': ['status'],
  'admin.rateLimitedNotice': ['seconds'],
  'admin.updateAvailable': ['version'],
  'admin.runs': ['version'],
  'admin.runsReleased': ['version', 'date'],
  'admin.storageUsed': ['percent'],
  'admin.onlineFor': ['uptime'],
  'admin.updateCheckOff': ['setting'],
  'admin.vaultList': ['count'],
  'admin.vaultDetails': ['size', 'remaining', 'max', 'date'],
} as const;
