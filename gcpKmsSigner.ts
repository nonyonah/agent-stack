import { KeyManagementServiceClient } from "@google-cloud/kms";
import { PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";

const ED25519_SPKI_PREFIX_HEX = "302a300506032b6570032100";

function createKmsClientFromEnv(): KeyManagementServiceClient {
  const inlineJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!inlineJson) {
    return new KeyManagementServiceClient();
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(inlineJson);
  } catch {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is set but not valid JSON.");
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON must contain client_email and private_key.");
  }

  const privateKey = parsed.private_key.replace(/\\n/g, "\n");

  return new KeyManagementServiceClient({
    projectId: parsed.project_id,
    credentials: {
      client_email: parsed.client_email,
      private_key: privateKey,
    },
  });
}

function withAuthHint(err: unknown): Error {
  const msg = String(err);
  if (msg.includes("Could not load the default credentials")) {
    return new Error(
      "GCP auth failed: provide either GOOGLE_APPLICATION_CREDENTIALS (file path) or GOOGLE_APPLICATION_CREDENTIALS_JSON (full service account JSON) in runtime env."
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

export class GcpKmsEd25519Signer {
  private client: KeyManagementServiceClient;
  private cachedPublicKey: PublicKey | null = null;

  constructor(private keyVersionName: string) {
    this.client = createKmsClientFromEnv();
  }

  async getSolanaPublicKey(): Promise<PublicKey> {
    if (this.cachedPublicKey) return this.cachedPublicKey;

    let pub;
    try {
      [pub] = await this.client.getPublicKey({ name: this.keyVersionName });
    } catch (err) {
      throw withAuthHint(err);
    }

    if (!pub.pem) throw new Error("KMS did not return a public key PEM.");
    if (pub.algorithm && pub.algorithm !== "EC_SIGN_ED25519") {
      throw new Error(`KMS key algorithm must be EC_SIGN_ED25519, got ${pub.algorithm}`);
    }

    const der = crypto.createPublicKey(pub.pem).export({ type: "spki", format: "der" }) as Buffer;
    const prefix = der.subarray(0, 12).toString("hex");
    if (prefix !== ED25519_SPKI_PREFIX_HEX || der.length < 44) {
      throw new Error("Unexpected Ed25519 SPKI format from KMS public key.");
    }

    const raw32 = der.subarray(der.length - 32);
    this.cachedPublicKey = new PublicKey(raw32);
    return this.cachedPublicKey;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    let resp;
    try {
      [resp] = await this.client.asymmetricSign({
        name: this.keyVersionName,
        data: Buffer.from(message),
      });
    } catch (err) {
      throw withAuthHint(err);
    }

    if (!resp.signature) throw new Error("KMS returned an empty signature.");

    const rawSig = typeof resp.signature === "string"
      ? Buffer.from(resp.signature, "base64")
      : Buffer.from(resp.signature);

    const sig = new Uint8Array(rawSig);
    if (sig.length !== 64) throw new Error(`Unexpected Ed25519 signature length: ${sig.length}`);
    return sig;
  }
}

export default GcpKmsEd25519Signer;
