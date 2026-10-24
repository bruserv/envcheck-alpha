// This fixture is inspected, never executed. It contains no real credentials.
const databaseUrl = process.env.DATABASE_URL;
const stripeKey = process.env.STRIPE_SECRET_KEY;
const port = Number(process.env.PORT ?? 3000);
export const configuration = { databaseUrl, stripeKey, port };
