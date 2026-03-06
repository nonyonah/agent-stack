import { KeyManagementServiceClient } from "@google-cloud/kms";
import { PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";

const ED25519_SPKI_PREFIX_HEX = "302a300506032b6570032100";

export class GcpKmsEd25519Signer {
  private client: KeyManagementServiceClient;
  private cachedPublicKey: PublicKey | null = null;

  constructor(private keyVersionName: string) {
    this.client = new KeyManagementServiceClient();
  }

  async getSolanaPublicKey(): Promise<PublicKey> {
    if (this.cachedPublicKey) return this.cachedPublicKey;

    const [pub] = await this.client.getPublicKey({ name: this.keyVersionName });
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
    const [resp] = await this.client.asymmetricSign({
      name: this.keyVersionName,
      data: Buffer.from(message),
    });

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
