const MAX_LENGTH = 250;

/**
 * Show the latest sync result on the app's Settings page (Sync status panel).
 * Never throws: a status that fails to save must not break the sync itself.
 */
export async function recordSyncStatus(swell: SwellAPI, appId: string, message: string): Promise<void> {
  const text = message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH - 1)}…` : message;
  try {
    await swell.put(`/settings/${appId}`, {
      status: { message: text, last_checked: new Date(Date.now()).toISOString() },
    });
  } catch {
    // Ignore: the sync history in Reporting still has the details.
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export const statusMessages = {
  notConnected: 'Not connected. Add your Senja API key in Senja connection to start syncing.',
  quickCheck: (created: number, updated: number) =>
    created || updated
      ? `Up to date. The last check found ${plural(created, 'new testimonial')} and ${plural(updated, 'change')}.`
      : 'Up to date.',
  quickCheckFailed: (error: string) => `Couldn't reach Senja: ${error} Trying again in 10 minutes.`,
  fullSyncRunning: (created: number, updated: number) =>
    `Full sync in progress: ${created} added and ${updated} updated so far.`,
  fullSyncCompleted: (created: number, updated: number, removed: number) =>
    `Up to date. The last full sync added ${created}, updated ${updated} and removed ${removed}.`,
  fullSyncFailed: (error: string) => `Sync failed: ${error}`,
};
