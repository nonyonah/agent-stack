import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  TransactionSignature,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { GcpKmsEd25519Signer } from "./gcpKmsSigner";

export type SolanaNetwork = "devnet" | "testnet" | "mainnet-beta";
export type SignerMode = "local" | "kms";

export interface AgentWalletConfig {
  name: string;
  storageDir?: string;
  rpcUrl?: string;
  network?: SolanaNetwork;
  signerMode?: SignerMode;
  kmsKeyId?: string;
}

export interface TransactionRecord {
  id: string;
  timestamp: number;
  type: "transfer" | "airdrop" | "spl_transfer" | "swap" | "custom";
  signature?: string;
  amount?: number;
  to?: string;
  from?: string;
  status: "pending" | "confirmed" | "failed";
  note?: string;
}

export interface AgentState {
  id: string;
  name: string;
  publicKey: string;
  createdAt: number;
  transactions: TransactionRecord[];
  decisionLog: DecisionRecord[];
}

export interface DecisionRecord {
  id: string;
  timestamp: number;
  reasoning: string;
  action: string;
  executed: boolean;
}

const STORAGE_VERSION = 3;
const DEFAULT_LOG_MAX = 500;
const ROTATION_RESERVE_SOL = 0.01;

function generateId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function getRpcUrl(network: SolanaNetwork, override?: string): string {
  if (override) return override;
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  return clusterApiUrl(network);
}

function encryptKeypair(keypair: Keypair, password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const secretKeyBuffer = Buffer.from(keypair.secretKey);
  const encrypted = Buffer.concat([cipher.update(secretKeyBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    v: STORAGE_VERSION,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    data: encrypted.toString("hex"),
  });
}

function decryptKeypair(encryptedData: string, password: string): Keypair {
  const parsed = JSON.parse(encryptedData);
  const salt = Buffer.from(parsed.salt, "hex");
  const iv = Buffer.from(parsed.iv, "hex");
  const authTag = Buffer.from(parsed.authTag, "hex");
  const encrypted = Buffer.from(parsed.data, "hex");
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return Keypair.fromSecretKey(new Uint8Array(decrypted));
}

export class AgentWallet {
  private keypair: Keypair | null = null;
  private connection: Connection;
  private state: AgentState;
  private storageDir: string;
  private encryptionKey: string;
  private network: SolanaNetwork;
  private signerMode: SignerMode;
  private kmsKeyId?: string;
  private kmsSigner?: GcpKmsEd25519Signer;
  private maxLogRecords: number;

  constructor(config: AgentWalletConfig) {
    this.network = config.network || (process.env.SOLANA_NETWORK as SolanaNetwork) || "devnet";
    this.connection = new Connection(getRpcUrl(this.network, config.rpcUrl), "confirmed");
    this.storageDir = config.storageDir || path.join(process.cwd(), ".agent-wallets");
    this.signerMode = config.signerMode || (process.env.AGENT_SIGNER_MODE as SignerMode) || "local";
    this.kmsKeyId = config.kmsKeyId || process.env.AGENT_KMS_KEY_ID;
    this.maxLogRecords = Number(process.env.AGENT_LOG_MAX || DEFAULT_LOG_MAX);

    const envSecret = process.env.AGENT_WALLET_SECRET;
    if (!envSecret) {
      throw new Error("AGENT_WALLET_SECRET is required. Refusing to run with an insecure default key.");
    }
    this.encryptionKey = envSecret;

    if (this.signerMode === "kms") {
      if (!this.kmsKeyId) throw new Error("Signer mode is kms but AGENT_KMS_KEY_ID is not set.");
      this.kmsSigner = new GcpKmsEd25519Signer(this.kmsKeyId);
    }

    this.state = {
      id: generateId(),
      name: config.name,
      publicKey: "",
      createdAt: Date.now(),
      transactions: [],
      decisionLog: [],
    };
  }

  async create(): Promise<{ publicKey: string; id: string }> {
    if (this.signerMode === "kms") {
      const kmsPub = await this._requireKmsPublicKey();
      this.state.publicKey = kmsPub.toBase58();
      this.keypair = null;
      await this._persist();
      return { publicKey: this.state.publicKey, id: this.state.id };
    }

    this.keypair = Keypair.generate();
    this.state.publicKey = this.keypair.publicKey.toBase58();
    await this._persist();
    return { publicKey: this.state.publicKey, id: this.state.id };
  }

  async load(agentId: string): Promise<void> {
    const filePath = this._statePath(agentId);
    if (!fs.existsSync(filePath)) throw new Error(`Agent ${agentId} not found`);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    this.state = raw.state;

    if (this.signerMode === "kms") {
      const kmsPub = await this._requireKmsPublicKey();
      if (this.state.publicKey && this.state.publicKey !== kmsPub.toBase58()) {
        throw new Error(`Stored public key ${this.state.publicKey} does not match KMS key ${kmsPub.toBase58()}`);
      }
      this.state.publicKey = kmsPub.toBase58();
      this.keypair = null;
      return;
    }

    if (!raw.encryptedKeypair) {
      throw new Error("Wallet file does not contain encrypted keypair data.");
    }
    this.keypair = decryptKeypair(raw.encryptedKeypair, this.encryptionKey);
  }

  static listAgents(storageDir?: string): AgentState[] {
    const dir = storageDir || path.join(process.cwd(), ".agent-wallets");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        return raw.state as AgentState;
      });
  }

  async getBalance(): Promise<number> {
    const pubkey = this._requirePublicKey();
    const lamports = await this.connection.getBalance(pubkey);
    return lamports / LAMPORTS_PER_SOL;
  }

  async airdrop(solAmount: number = 1): Promise<TransactionSignature> {
    const pubkey = this._requirePublicKey();
    if (this.network === "mainnet-beta") {
      throw new Error("Airdrop is disabled on mainnet-beta.");
    }

    const lamports = solAmount * LAMPORTS_PER_SOL;
    const sig = await this.connection.requestAirdrop(pubkey, lamports);
    const latest = await this.connection.getLatestBlockhash("confirmed");
    await this.connection.confirmTransaction(
      { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );
    this._addTx({ type: "airdrop", amount: solAmount, status: "confirmed", signature: sig });
    await this._persist();
    return sig;
  }

  async transfer(toPublicKey: string, solAmount: number): Promise<TransactionSignature> {
    const fromPubkey = this._requirePublicKey();
    const toPubkey = new PublicKey(toPublicKey);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports: solAmount * LAMPORTS_PER_SOL,
      })
    );

    const sig = await this._sendTransaction(transaction, fromPubkey);
    this._addTx({ type: "transfer", amount: solAmount, to: toPublicKey, from: this.state.publicKey, status: "confirmed", signature: sig });
    await this._persist();
    return sig;
  }

  async transferSPL(mint: string, toOwner: string, amount: number, decimals: number): Promise<TransactionSignature> {
    const payerPub = this._requirePublicKey();
    const mintPk = new PublicKey(mint);
    const toOwnerPk = new PublicKey(toOwner);
    const fromAta = await getAssociatedTokenAddress(mintPk, payerPub);
    const toAta = await getAssociatedTokenAddress(mintPk, toOwnerPk);

    const tx = new Transaction();
    const toInfo = await this.connection.getAccountInfo(toAta);
    if (!toInfo) {
      tx.add(createAssociatedTokenAccountInstruction(payerPub, toAta, toOwnerPk, mintPk));
    }

    const units = BigInt(Math.round(amount * Math.pow(10, decimals)));
    tx.add(createTransferCheckedInstruction(fromAta, mintPk, toAta, payerPub, units, decimals));

    const sig = await this._sendTransaction(tx, payerPub);
    this._addTx({
      type: "spl_transfer",
      amount,
      to: toOwner,
      from: payerPub.toBase58(),
      status: "confirmed",
      signature: sig,
      note: `mint=${mint}`,
    });
    await this._persist();
    return sig;
  }

  async signAndSendRaw(transaction: Transaction): Promise<TransactionSignature> {
    const feePayer = this._requirePublicKey();
    const sig = await this._sendTransaction(transaction, feePayer);
    this._addTx({ type: "custom", status: "confirmed", signature: sig });
    await this._persist();
    return sig;
  }

  async rotateKeypair(): Promise<{ oldPublicKey: string; newPublicKey: string; transferSig?: string }> {
    if (this.signerMode === "kms") {
      throw new Error("Key rotation is managed in KMS. Rotate the CryptoKeyVersion in GCP and update AGENT_KMS_KEY_ID.");
    }

    const old = this._requireLocalKeypair();
    const oldPublicKey = old.publicKey.toBase58();
    const newKeypair = Keypair.generate();
    let transferSig: string | undefined;

    const balLamports = await this.connection.getBalance(old.publicKey);
    const reserveLamports = Math.floor(ROTATION_RESERVE_SOL * LAMPORTS_PER_SOL);
    const moveLamports = Math.max(0, balLamports - reserveLamports);

    if (moveLamports > 0) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: old.publicKey,
          toPubkey: newKeypair.publicKey,
          lamports: moveLamports,
        })
      );
      transferSig = await sendAndConfirmTransaction(this.connection, tx, [old]);
    }

    this.keypair = newKeypair;
    this.state.publicKey = newKeypair.publicKey.toBase58();
    this.logDecision(
      `Key rotation complete. old=${oldPublicKey.slice(0, 8)}..., new=${this.state.publicKey.slice(0, 8)}...`,
      "rotate_keypair",
      true
    );
    await this._persist();

    return { oldPublicKey, newPublicKey: this.state.publicKey, transferSig };
  }

  logDecision(reasoning: string, action: string, executed: boolean = false): DecisionRecord {
    const record: DecisionRecord = {
      id: generateId(),
      timestamp: Date.now(),
      reasoning,
      action,
      executed,
    };
    this.state.decisionLog.push(record);
    this._trimLogs();
    void this._persist();
    return record;
  }

  logSwapAttempt(note: string): void {
    this._addTx({ type: "swap", status: "failed", note });
    this._trimLogs();
    void this._persist();
  }

  get publicKey(): string { return this.state.publicKey; }
  get id(): string { return this.state.id; }
  get name(): string { return this.state.name; }
  getState(): AgentState { return { ...this.state }; }
  getTransactions(): TransactionRecord[] { return [...this.state.transactions]; }
  getDecisionLog(): DecisionRecord[] { return [...this.state.decisionLog]; }

  private async _sendTransaction(transaction: Transaction, feePayer: PublicKey): Promise<TransactionSignature> {
    if (this.signerMode === "local") {
      const signer = this._requireLocalKeypair();
      transaction.feePayer = signer.publicKey;
      return sendAndConfirmTransaction(this.connection, transaction, [signer]);
    }

    const kmsSigner = this._requireKmsSigner();
    transaction.feePayer = feePayer;
    const latest = await this.connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = latest.blockhash;

    const message = transaction.serializeMessage();
    const signature = await kmsSigner.signMessage(message);
    transaction.addSignature(feePayer, Buffer.from(signature));

    const wire = transaction.serialize();
    const sig = await this.connection.sendRawTransaction(wire, { skipPreflight: false, maxRetries: 3 });
    await this.connection.confirmTransaction(
      { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );
    return sig;
  }

  private _requirePublicKey(): PublicKey {
    if (!this.state.publicKey) throw new Error("Wallet has no public key. Call create() or load() first.");
    return new PublicKey(this.state.publicKey);
  }

  private _requireLocalKeypair(): Keypair {
    if (this.signerMode === "kms") {
      throw new Error("KMS signer mode is configured. Local private key operations are disabled.");
    }
    if (!this.keypair) throw new Error("Wallet not initialized. Call create() or load() first.");
    return this.keypair;
  }

  private _requireKmsSigner(): GcpKmsEd25519Signer {
    if (this.signerMode !== "kms" || !this.kmsSigner) {
      throw new Error("KMS signer is not configured.");
    }
    return this.kmsSigner;
  }

  private async _requireKmsPublicKey(): Promise<PublicKey> {
    return this._requireKmsSigner().getSolanaPublicKey();
  }

  private _addTx(partial: Omit<TransactionRecord, "id" | "timestamp">): TransactionRecord {
    const record: TransactionRecord = { id: generateId(), timestamp: Date.now(), ...partial };
    this.state.transactions.push(record);
    this._trimLogs();
    return record;
  }

  private _trimLogs() {
    if (this.state.transactions.length > this.maxLogRecords) {
      this.state.transactions = this.state.transactions.slice(-this.maxLogRecords);
    }
    if (this.state.decisionLog.length > this.maxLogRecords) {
      this.state.decisionLog = this.state.decisionLog.slice(-this.maxLogRecords);
    }
  }

  private _statePath(id?: string): string {
    return path.join(this.storageDir, `${id || this.state.id}.json`);
  }

  private async _persist(): Promise<void> {
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
    const payload = {
      state: this.state,
      encryptedKeypair: this.keypair ? encryptKeypair(this.keypair, this.encryptionKey) : null,
      signerMode: this.signerMode,
      network: this.network,
      kmsKeyId: this.kmsKeyId || null,
    };
    fs.writeFileSync(this._statePath(), JSON.stringify(payload, null, 2));
  }
}

export default AgentWallet;
