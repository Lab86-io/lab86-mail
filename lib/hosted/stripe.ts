import Stripe from 'stripe';

let stripe: Stripe | null = null;

export function requireStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required for billing.');
  if (!stripe) stripe = new Stripe(secretKey);
  return stripe;
}
