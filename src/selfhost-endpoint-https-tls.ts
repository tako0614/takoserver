import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { connect as tlsConnect } from "node:tls";

const LOCAL_TLS_TIMEOUT_MS = 2_000;

export interface WildcardCertificateErrors {
  readonly certificateInvalid: string;
  readonly privateKeyInvalid: string;
  readonly keyMismatch: string;
  readonly certificateNotCurrent: string;
  readonly wildcardRequired: string;
}

export function validateWildcardEndpointCertificate(input: {
  readonly certificateChain: string;
  readonly privateKey: string;
  readonly suffix: string;
  readonly specimenHostname: string;
  readonly errors: WildcardCertificateErrors;
}): X509Certificate {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(input.certificateChain);
  } catch {
    throw new TypeError(input.errors.certificateInvalid);
  }
  let keyPublic: string;
  try {
    keyPublic = createPublicKey(createPrivateKey(input.privateKey))
      .export({ type: "spki", format: "der" })
      .toString("base64");
  } catch {
    throw new TypeError(input.errors.privateKeyInvalid);
  }
  const certificatePublic = certificate.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  if (certificatePublic !== keyPublic) throw new TypeError(input.errors.keyMismatch);

  const now = Date.now();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    now < validFrom ||
    now > validTo
  ) {
    throw new TypeError(input.errors.certificateNotCurrent);
  }
  const wildcardSan = certificate.subjectAltName
    ?.split(/,\s*/u)
    .some((entry) => entry.toLowerCase() === `dns:*.${input.suffix}`);
  if (!wildcardSan || !certificate.checkHost(input.specimenHostname)) {
    throw new TypeError(input.errors.wildcardRequired);
  }
  return certificate;
}

export interface LocalSniErrors {
  readonly invalidCertificate: string;
  readonly certificateMismatch: string;
  readonly handshakeFailed: (cause: string) => string;
}

/**
 * Verify the exact SNI hostname against the configured certificate leaf.
 * `rejectUnauthorized: false` is deliberate: this is local listener
 * readback, not a claim about public CA trust or external reachability.
 */
export function verifyLocalEndpointHttpsSni(input: {
  readonly host: string;
  readonly port: number;
  readonly hostname: string;
  readonly certificateChain: string;
  readonly errors: LocalSniErrors;
}): Promise<void> {
  let expectedFingerprint: string;
  try {
    expectedFingerprint = new X509Certificate(input.certificateChain).fingerprint256;
  } catch {
    return Promise.reject(new TypeError(input.errors.invalidCertificate));
  }
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: input.host,
      port: input.port,
      servername: input.hostname,
      rejectUnauthorized: false,
    });
    socket.setTimeout(LOCAL_TLS_TIMEOUT_MS, () =>
      socket.destroy(new Error("local TLS handshake timed out")),
    );
    socket.once("secureConnect", () => {
      let fingerprint: string | undefined;
      try {
        const peer = socket.getPeerCertificate(true).raw;
        fingerprint = peer ? new X509Certificate(peer).fingerprint256 : undefined;
      } catch {
        fingerprint = undefined;
      }
      socket.destroy();
      if (fingerprint !== expectedFingerprint) {
        reject(new TypeError(input.errors.certificateMismatch));
      } else {
        resolve();
      }
    });
    socket.once("error", (error) =>
      reject(new TypeError(input.errors.handshakeFailed(error.message))),
    );
  });
}
