import { Logger } from "./logger";
import LighterConstant from "./constants";
import LighterRestClient from "./rest/client";
import { signChangePubKey, generateApiKey } from "./signer/core";
import { LighterVenue, LighterAccount, LighterSignerContext } from "./types";

export interface LighterOnboardingConfig {
    /** Perp venue: "zk" (default) or "robinhood". */
    venue?: LighterVenue;
    /** Default true (mainnet). */
    isMainnet?: boolean;
    /** Advanced/testing override for the underlying REST client. */
    restClient?: LighterRestClient;
}

/**
 * A generated-but-not-yet-registered API key. The caller must (1) have the account owner's EVM wallet
 * personal_sign `messageToSign`, then (2) submit via `submitApiKey`. STORE `apiPrivateKey` securely — it is
 * the credential you sign orders with and cannot be recovered.
 */
export interface PendingApiKeyRegistration {
    accountIndex: number;
    apiKeyIndex: number;
    /** The new API key's private key — persist this; it is your trading credential. */
    apiPrivateKey: string;
    /** The new API key's public key (being registered on-chain). */
    publicKey: string;
    /** tx_type 8 (ChangePubKey). */
    txType: number;
    /** L2-signed tx with an empty `L1Sig` placeholder to be filled by the account owner's L1 signature. */
    txInfo: string;
    /** The message the account owner's EVM wallet must personal_sign; its signature completes the tx. */
    messageToSign: string;
}

/**
 * Onboarding helper: associate a programmatic API key with a Lighter account so the SDK can sign trades.
 *
 * Prerequisite: the account must already exist (create one by depositing via Lighter's L1 bridge). This
 * helper does the API-key association (a ChangePubKey, tx_type 8), which is a two-signature handshake:
 *   1. the SDK generates a fresh API keypair and L2 self-signs the ChangePubKey (proving control of the new key);
 *   2. the account owner's EVM wallet personal_signs the returned `messageToSign` (proving account ownership);
 *   3. that L1 signature is spliced in and the tx submitted.
 *
 * Use {@link registerApiKey} for the full flow with an injected wallet signer, or the two-step
 * {@link prepareApiKey} / {@link submitApiKey} when the wallet signature happens elsewhere (e.g. a frontend).
 */
export default class LighterOnboarding {
    private readonly rest: LighterRestClient;
    private readonly baseUrl: string;
    private readonly chainId: number;

    constructor(config: LighterOnboardingConfig = {}) {
        const venue = config.venue || LighterConstant.VENUE.ZK;
        const isMainnet = config.isMainnet !== false;
        const resolved = LighterConstant.resolveVenue(venue, isMainnet);
        this.baseUrl = resolved.baseUrl;
        this.chainId = resolved.chainId;
        this.rest = config.restClient || new LighterRestClient({ venue, isMainnet });
    }

    /** All Lighter accounts (sub-accounts) owned by an L1 (EVM) wallet address. */
    public async getAccounts(l1Address: string): Promise<LighterAccount[]> {
        return this.rest.getAccountsByL1Address(l1Address);
    }

    /** Resolve the primary account index for an L1 wallet; throws if the wallet has no Lighter account yet. */
    public async resolveAccountIndex(l1Address: string): Promise<number> {
        const accounts = await this.getAccounts(l1Address);
        const acc = accounts[0] as (LighterAccount & { index?: number }) | undefined;
        const idx = acc?.account_index ?? acc?.index;
        if (idx == null) {
            throw new Error(
                `LighterOnboarding::no Lighter account found for ${l1Address}. Create one first by depositing via the Lighter bridge.`,
            );
        }
        return Number(idx);
    }

    /** Pick the lowest free programmatic api_key_index (>= 4; slots 0-3 are reserved for desktop/mobile). */
    public async findFreeApiKeyIndex(accountIndex: number): Promise<number> {
        const keys = await this.rest.getApiKeys(accountIndex);
        const used = new Set(keys.map((k) => Number(k.api_key_index)));
        let apiKeyIndex = LighterConstant.RESERVED_API_KEY_INDEX_MAX + 1;
        while (used.has(apiKeyIndex) && apiKeyIndex <= LighterConstant.MAX_API_KEY_INDEX) apiKeyIndex++;
        if (apiKeyIndex > LighterConstant.MAX_API_KEY_INDEX) {
            throw new Error("LighterOnboarding::no free API key slot available on this account");
        }
        return apiKeyIndex;
    }

    /**
     * Step 1: generate a fresh API keypair and L2 self-sign a ChangePubKey for `accountIndex`. Returns the
     * pending registration, including `messageToSign` for the account owner's wallet and `apiPrivateKey`
     * (STORE IT). A fresh slot has never been used, so the nonce bootstraps at 0 (skipNonce).
     */
    public async prepareApiKey(params: { accountIndex: number; apiKeyIndex?: number }): Promise<PendingApiKeyRegistration> {
        const apiKeyIndex = params.apiKeyIndex ?? (await this.findFreeApiKeyIndex(params.accountIndex));
        const keyPair = await generateApiKey();
        const signed = await signChangePubKey(
            { url: this.baseUrl, chainId: this.chainId, apiPrivateKey: keyPair.privateKey, apiKeyIndex, accountIndex: params.accountIndex },
            { publicKey: keyPair.publicKey, nonce: 0, skipNonce: true },
        );
        if (!signed.txInfo.includes('"L1Sig":""')) {
            throw new Error("LighterOnboarding::signed ChangePubKey is missing the L1Sig placeholder (signer mismatch)");
        }
        Logger.debug(`LighterOnboarding::prepareApiKey::account=${params.accountIndex}, apiKeyIndex=${apiKeyIndex}`);
        return {
            accountIndex: params.accountIndex,
            apiKeyIndex,
            apiPrivateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
            txType: signed.txType,
            txInfo: signed.txInfo,
            messageToSign: signed.messageToSign,
        };
    }

    /**
     * Step 2: splice the account owner's L1 (EVM) `personal_sign` of `pending.messageToSign` into the tx and
     * submit it (tx_type 8). Returns the ready-to-use signer context on success.
     */
    public async submitApiKey(
        pending: PendingApiKeyRegistration,
        l1Signature: string,
    ): Promise<{ txHash?: string; signer: LighterSignerContext }> {
        if (!l1Signature) throw new Error("LighterOnboarding::l1Signature is required to submit the ChangePubKey");
        if (!pending.txInfo.includes('"L1Sig":""')) {
            throw new Error("LighterOnboarding::pending ChangePubKey is malformed (missing L1Sig placeholder)");
        }
        // Byte-exact splice of the empty placeholder preserves the signed payload the signer produced.
        const mergedTxInfo = pending.txInfo.replace('"L1Sig":""', `"L1Sig":${JSON.stringify(l1Signature)}`);
        const res = await this.rest.sendChangePubKey(pending.txType, mergedTxInfo);
        return {
            txHash: res.tx_hash,
            signer: { apiPrivateKey: pending.apiPrivateKey, accountIndex: pending.accountIndex, apiKeyIndex: pending.apiKeyIndex },
        };
    }

    /**
     * Full onboarding in one call: resolve the account (from `accountIndex` or `l1Address`), generate + L2-sign
     * the key, obtain the L1 signature via your wallet callback, submit, and return the trading signer.
     *
     * @example
     * const { signer, apiPrivateKey } = await onboarding.registerApiKey({
     *   l1Address: wallet.address,
     *   l1Sign: (msg) => wallet.signMessage(msg), // ethers/viem personal_sign
     * });
     * const client = new LighterClient({ signer });
     */
    public async registerApiKey(params: {
        accountIndex?: number;
        l1Address?: string;
        apiKeyIndex?: number;
        /** Account owner's EVM wallet personal_sign of the returned message (e.g. ethers `signMessage`). */
        l1Sign: (message: string) => string | Promise<string>;
    }): Promise<{ apiPrivateKey: string; accountIndex: number; apiKeyIndex: number; txHash?: string; signer: LighterSignerContext }> {
        let accountIndex = params.accountIndex;
        if (accountIndex == null) {
            if (!params.l1Address) throw new Error("LighterOnboarding::registerApiKey requires accountIndex or l1Address");
            accountIndex = await this.resolveAccountIndex(params.l1Address);
        }
        const pending = await this.prepareApiKey({ accountIndex, apiKeyIndex: params.apiKeyIndex });
        const l1Signature = await params.l1Sign(pending.messageToSign);
        const { txHash, signer } = await this.submitApiKey(pending, l1Signature);
        return { apiPrivateKey: pending.apiPrivateKey, accountIndex: pending.accountIndex, apiKeyIndex: pending.apiKeyIndex, txHash, signer };
    }

    /** Confirm a signer's API key is bound on-chain: an authed read succeeds only after the ChangePubKey applies. */
    public async verifyApiKey(signer: LighterSignerContext): Promise<boolean> {
        try {
            await this.rest.getActiveOrders(signer);
            return true;
        } catch (err: any) {
            Logger.debug(`LighterOnboarding::verifyApiKey::not yet bound: ${err?.message}`);
            return false;
        }
    }
}
