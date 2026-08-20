import type { AiGateway } from "./ai-port.ts";
import { parseHostedObjectBucketSupplies } from "./hosted-object-bucket-supplies.ts";
import { createCloudflareS3CredentialIssuer } from "./providers/cloudflare-s3.ts";
import {
  type CloudflareWorkersAiBinding,
  createCloudflareWorkersAiGateway,
} from "./providers/cloudflare-workers-ai.ts";
import { parseOpenAiModelConfig } from "./providers/openai.ts";
import { createWasabiS3CredentialIssuer } from "./providers/wasabi-s3.ts";
import {
  createS3CredentialIssuerRouter,
  type S3CredentialIssuerRoute,
} from "./s3-issuer-router.ts";
import type { S3CredentialIssuer } from "./s3-port.ts";

export interface WorkerDataServiceEnv {
  readonly AI?: CloudflareWorkersAiBinding;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly TAKOSERVER_AI_MODELS?: string;
  readonly TAKOSERVER_R2_PARENT_ACCESS_KEY_ID?: string;
  readonly TAKOSERVER_R2_PARENT_TOKEN?: string;
  readonly TAKOSERVER_OBJECT_BUCKET_SUPPLIES?: string;
  readonly TAKOSERVER_WASABI_ACCESS_KEY_ID?: string;
  readonly TAKOSERVER_WASABI_SECRET_ACCESS_KEY?: string;
}

export interface WorkerDataServices {
  readonly ai?: AiGateway;
  readonly s3?: S3CredentialIssuer;
}

/**
 * Optional standard data planes for the hosted Takoserver installation.
 *
 * Model mappings, prices, account identity, and credentials are realized
 * deployment configuration. The product owns only the ports and adapters.
 */
export function createWorkerDataServices(env: WorkerDataServiceEnv): WorkerDataServices {
  const aiConfigured = env.TAKOSERVER_AI_MODELS !== undefined;
  const s3Configured =
    env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES !== undefined ||
    env.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID !== undefined ||
    env.TAKOSERVER_R2_PARENT_TOKEN !== undefined ||
    env.TAKOSERVER_WASABI_ACCESS_KEY_ID !== undefined ||
    env.TAKOSERVER_WASABI_SECRET_ACCESS_KEY !== undefined;

  if (!aiConfigured && !s3Configured) return {};

  const ai = aiConfigured
    ? (() => {
        if (!env.AI) throw new TypeError("AI binding is not configured");
        return createCloudflareWorkersAiGateway({
          binding: env.AI,
          models: parseOpenAiModelConfig(env.TAKOSERVER_AI_MODELS as string),
        });
      })()
    : undefined;

  const s3 = s3Configured
    ? (() => {
        if (!env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES) {
          throw new TypeError("S3 credential issuer requires hosted ObjectBucket supplies");
        }
        const supplies = parseHostedObjectBucketSupplies(env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES);
        const routes: S3CredentialIssuerRoute[] = [];
        for (const supply of supplies.supplies) {
          if (supply.provider.kind === "cloudflare") {
            if (
              !env.CLOUDFLARE_ACCOUNT_ID ||
              !env.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID ||
              !env.TAKOSERVER_R2_PARENT_TOKEN
            ) {
              throw new TypeError("Cloudflare S3 credential issuer is not fully configured");
            }
            routes.push({
              providerPackRef: "cloudflare",
              providerInstallationRef: supply.providerInstallation.id,
              issuer: createCloudflareS3CredentialIssuer({
                accountId: env.CLOUDFLARE_ACCOUNT_ID,
                providerInstallationRef: supply.providerInstallation.id,
                parentAccessKeyId: env.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID,
                parentSecretAccessKey: env.TAKOSERVER_R2_PARENT_TOKEN,
              }),
            });
          } else {
            if (!env.TAKOSERVER_WASABI_ACCESS_KEY_ID || !env.TAKOSERVER_WASABI_SECRET_ACCESS_KEY) {
              throw new TypeError("Wasabi S3 credential issuer is not fully configured");
            }
            routes.push({
              providerPackRef: "wasabi",
              providerInstallationRef: supply.providerInstallation.id,
              issuer: createWasabiS3CredentialIssuer({
                providerInstallationRef: supply.providerInstallation.id,
                roleArn: supply.provider.roleArn,
                accessKeyId: env.TAKOSERVER_WASABI_ACCESS_KEY_ID,
                secretAccessKey: env.TAKOSERVER_WASABI_SECRET_ACCESS_KEY,
              }),
            });
          }
        }
        if (routes.length === 0) throw new TypeError("no S3 credential issuer is configured");
        return createS3CredentialIssuerRouter(routes);
      })()
    : undefined;

  return { ...(ai ? { ai } : {}), ...(s3 ? { s3 } : {}) };
}
