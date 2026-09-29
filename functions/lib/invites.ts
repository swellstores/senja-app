export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DELAY_DAYS = 7;

export interface InviteSettings {
  enabled: boolean;
  formId: string | null;
  delayDays: number;
  onlyOptedIn: boolean;
  apiKey: string | null;
}

export function readInviteSettings(settings: Record<string, any> | null | undefined): InviteSettings {
  const invites = settings?.invites ?? {};
  const delay = Number(invites.delay_days);
  return {
    enabled: invites.enabled === true,
    formId: invites.form_id?.trim() || null,
    delayDays: Number.isFinite(delay) && delay >= 0 ? Math.min(90, Math.floor(delay)) : DEFAULT_DELAY_DAYS,
    onlyOptedIn: invites.only_opted_in === true,
    apiKey: settings?.connection?.api_key?.trim() || null,
  };
}

export function scheduledDate(from: number, delayDays: number): string {
  return new Date(from + delayDays * DAY_MS).toISOString();
}

export interface InviteRecord {
  id: string;
  order_id: string;
  email: string;
  name?: string | null;
  form_id?: string | null;
  status: 'scheduled' | 'sent' | 'skipped' | 'failed';
  date_scheduled: string;
}
