import { z } from 'zod';

const cleanString = (val: unknown): unknown =>
  typeof val === 'string' ? val.trim().replace(/^["']+|["']+$/g, '') : val;

export const envSchema = z.object({
  NODE_ENV: z.preprocess(
    (val) => {
      const cleaned =
        typeof val === 'string'
          ? val.trim().toLowerCase().replace(/^["']+|["']+$/g, '')
          : val;
      return cleaned || 'production';
    },
    z.enum(['development', 'production', 'test']).default('production'),
  ),
  PORT: z.preprocess(
    (val) => {
      const cleaned = cleanString(val);
      return cleaned !== undefined && cleaned !== '' ? Number(cleaned) : 3000;
    },
    z.number().default(3000),
  ),
  DATABASE_URL: z.preprocess(
    cleanString,
    z.string().min(1, 'DATABASE_URL is required'),
  ),
  DATABASE_URL_UNPOOLED: z.preprocess(cleanString, z.string().optional()),
  NEON_BRANCH: z.preprocess(cleanString, z.string().optional()),
  JWT_SECRET: z.preprocess(
    cleanString,
    z.string().min(8, 'JWT_SECRET must be at least 8 characters'),
  ),
  JWT_EXPIRATION: z.preprocess(cleanString, z.string().default('7d')),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const formattedErrors = JSON.stringify(result.error.format(), null, 2);
    throw new Error(`Config validation error:\n${formattedErrors}`);
  }

  return result.data;
}
