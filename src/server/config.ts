/** Configuration from the environment (see .env.example). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    s3: {
      endpoint: required(env, "S3_ENDPOINT"),
      region: env.S3_REGION || "us-east-1",
      bucket: required(env, "S3_BUCKET"),
      accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
    },
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
