// Who paid, for what, and how much: one line the office can shout.
import type { MoneyEvent } from '../shared/types';
import type { PaymentDetails } from '../shared/payment-details';
import { gameCurrency } from './currency';

/** m•••@example.com: enough to recognise a regular, never the whole address. */
export function maskEmail(email: string) {
  const at = email.indexOf('@');
  if (at < 1) return '';
  return `${email[0]}•••${email.slice(at)}`;
}

/** "Mia (Canada) · Pro monthly · $29". Falls back through the pieces the provider gave. */
export function describeMoney(ev: MoneyEvent, detail?: PaymentDetails) {
  const parts: string[] = [];
  const field = (label: string) => detail?.fields.find(f => f.label === label)?.value?.trim() || '';
  const name = detail?.customer?.name?.trim() || (detail?.customer?.email ? maskEmail(detail.customer.email) : '');
  const country = field('Country');
  if (name) parts.push(country ? `${name} (${country})` : name);
  else if (country) parts.push(`Someone in ${country}`);
  const plan = ev.detail?.plan?.trim() || field('Plan') || field('Description') || ev.label?.replace(/^Preview only · /, '').trim();
  if (plan && !/^subscription update$/i.test(plan)) parts.push(plan);
  if (ev.amount) parts.push(gameCurrency.display(ev.amount, ev.currency));
  return parts.join(' · ');
}

/** The line a customer says at the counter. */
export function customerLine(ev: MoneyEvent) {
  if (ev.kind === 'subscribed' || ev.kind === 'subscription_started') return ['Sign me up!', 'Take my money!', 'Subscribed!'][Math.floor(Math.random() * 3)];
  return ev.amount >= 100 ? 'Shut up and take my money!' : ['Here you go!', 'Worth every penny.', 'Keep the change.'][Math.floor(Math.random() * 3)];
}
