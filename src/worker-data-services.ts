import type { AiGateway } from "./ai-port.ts";
import { createCloudflareAiGateway } from "./providers/cloudflare-ai.ts";
import { createCloudflareS3CredentialIssuer } from "./providers/cloudflare-s3.ts";
import { parseOpenAiModelConfig } from "./providers/openai.ts";
import type { S3CredentialIssuer } from "./s3-port.ts";

export interface WorkerDataServiceEnv {
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly CLOUDFLARE_API_TOKEN?: string;
  readonly TAKOSERVER_AI_MODELS?: string;
  readonly TAKOSERVER_R2_PARENT_ACCESS_KEY_ID?: string;
  readonly TAKOSERVER_R2_PARENT_TOKEN?: string;
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
    env.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID !== undefined ||
    env.TAKOSERVER_R2_PARENT_TOKEN !== undefined;

  if (!aiConfigured && !s3Configured) return {};
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new TypeError("Cloudflare account is not configured");

  const ai = aiConfigured
    ? (() => {
        if (!env.CLOUDFLARE_API_TOKEN) throw new TypeError("AI credential is not configured");
        return createCloudflareAiGateway({
          accountId: env.CLOUDFLARE_ACCOUNT_ID,
          models: parseOpenAiModelConfig(env.TAKOSERVER_AI_MODELS as string),
          authorize: () => `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        });
      })()
    : undefined;

  const s3 = s3Configured
    ? (() => {
        if (!env.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID || !env.TAKOSERVER_R2_PARENT_TOKEN) {
          throw new TypeError("S3 credential issuer is not fully configured");
        }
        return createCloudflareS3CredentialIssuer({
          accountId: env.CLOUDFLARE_ACCOUNT_ID,
          providerInstallationRef: "cloudflare.primary",
          parentAccessKeyId: env.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID,
          authorize: () => `Bearer ${env.TAKOSERVER_R2_PARENT_TOKEN}`,
        });
      })()
    : undefined;

  return { ...(ai ? { ai } : {}), ...(s3 ? { s3 } : {}) };
}
