// Same application contract; the missing configuration declarations are repaired.
const databaseUrl = process.env.DATABASE_URL;
const stripeKey = process.env.STRIPE_SECRET_KEY;
const port = Number(process.env.PORT ?? 3000);
export const configuration = { databaseUrl, stripeKey, port };
