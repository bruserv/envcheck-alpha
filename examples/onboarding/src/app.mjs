// Analysis fixture: EnvCheck inspects this file without executing validators.
import { cleanEnv, port, str } from 'envalid';
import { z } from 'zod';

// The schema property is deliberately different from its environment name.
const metadataSchema = z.object({ label: z.string().default('EnvCheck') });
metadataSchema.parse({ label: process.env.APP_LABEL });

export const env = cleanEnv(process.env, {
  PORT: port({ default: 3000 }),
  WEBHOOK_SECRET: str(),
});
