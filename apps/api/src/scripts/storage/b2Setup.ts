import { GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { env, requireEnv } from '../../config/env.js';
import { makeS3Client } from '../../services/storage/b2.js';

// One-time bucket set-up for browser uploads: allow the web app's origins to PUT (upload), GET and
// HEAD (play) with the headers a browser sends. Origins come from CORS_ORIGINS (the same list the API
// allows) plus localhost for development. Run once after creating the bucket; safe to repeat.
//   npm run storage:b2-setup -w @meetingid/api
async function main(): Promise<void> {
  const origins = [
    ...new Set([
      ...env()
        .CORS_ORIGINS.map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),
      'http://localhost:5173',
    ]),
  ];
  const client = makeS3Client({
    endpoint: requireEnv('B2_ENDPOINT'),
    ...(env().B2_REGION ? { region: env().B2_REGION as string } : {}),
    keyId: requireEnv('B2_KEY_ID'),
    applicationKey: requireEnv('B2_APPLICATION_KEY'),
  });
  const Bucket = requireEnv('B2_BUCKET');
  await client.send(
    new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
  const back = await client.send(new GetBucketCorsCommand({ Bucket }));
  console.log(`CORS set on bucket ${Bucket} for: ${origins.join(', ')}`);
  console.log(`rules now on the bucket: ${back.CORSRules?.length ?? 0}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
