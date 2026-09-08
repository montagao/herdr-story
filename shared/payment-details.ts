/** Private, requested detail. Never included in broadcasts, journal rows, or demo exports. */
export interface PaymentDetails {
  source: 'stripe' | 'revenuecat'; eventId: string; eventType?: string; occurredAt?: number;
  amount?: number; currency?: string; status?: string; url?: string; note?: string;
  customer?: { id?: string; name?: string; email?: string; phone?: string; url?: string };
  fields: { label: string; value: string }[];
}
