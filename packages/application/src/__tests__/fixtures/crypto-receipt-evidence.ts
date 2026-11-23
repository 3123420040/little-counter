import type { CryptoReceiptEvidence } from "../../contract-seams";

export interface PersistedReceiptReferences {
  paymentIntentRecord: {
    id: string;
    merchantId: string;
    storeId: string;
    provider: "nowpayments";
    providerConfigPurpose: "merchant_retail";
    providerConfigId: string;
  };
  providerEventRecord: {
    provider: "nowpayments";
    providerEventId: string;
    paymentIntentId: string;
    status: "matched";
  };
  paymentEntryRecord: {
    id: string;
    orderId: string;
    paymentIntentId: string;
    providerEventId: string;
  };
  orderRecord: {
    id: string;
    merchantId: string;
    storeId: string;
  };
}

export interface VerifiedReceiptFixture {
  evidence: CryptoReceiptEvidence;
  references: PersistedReceiptReferences;
}

export const verifiedReceiptFixtures: readonly VerifiedReceiptFixture[] = [
  {
    evidence: {
      evidenceId: "crypto_4f0c3c53d35ba3f43f9d159d16ad4120",
      businessPurpose: "retail_order",
      merchantId: "merchant_fixture_usdt",
      storeId: "store_fixture_usdt",
      paymentIntentId: "pi_fixture_usdttrc20",
      providerEventId: "np_fixture_payment_7001",
      asset: "USDTTRC20",
      transactionHash: "trc20_fixture_transaction_hash_7001",
      destinationWalletRef: "wallet_ref_fixture_usdt",
      grossQuantity: "10",
      providerFeeQuantity: "0.05",
      netQuantity: "9.95",
      grossVndValue: 250000,
      feeVndValue: 1250,
      valuationRateSource: "NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE",
      valuationTimestamp: "2026-06-21T01:00:00.000Z",
    },
    references: {
      paymentIntentRecord: {
        id: "pi_fixture_usdttrc20",
        merchantId: "merchant_fixture_usdt",
        storeId: "store_fixture_usdt",
        provider: "nowpayments",
        providerConfigPurpose: "merchant_retail",
        providerConfigId: "cfg_fixture_merchant_usdt",
      },
      providerEventRecord: {
        provider: "nowpayments",
        providerEventId: "np_fixture_payment_7001",
        paymentIntentId: "pi_fixture_usdttrc20",
        status: "matched",
      },
      paymentEntryRecord: {
        id: "00000000-0000-4000-8000-000000007001",
        orderId: "order_fixture_usdttrc20",
        paymentIntentId: "pi_fixture_usdttrc20",
        providerEventId: "np_fixture_payment_7001",
      },
      orderRecord: {
        id: "order_fixture_usdttrc20",
        merchantId: "merchant_fixture_usdt",
        storeId: "store_fixture_usdt",
      },
    },
  },
  {
    evidence: {
      evidenceId: "crypto_f7fc7dbe013df262c5063d96d17c3797",
      businessPurpose: "retail_order",
      merchantId: "merchant_fixture_usdc",
      storeId: "store_fixture_usdc",
      paymentIntentId: "pi_fixture_usdcmatic",
      providerEventId: "np_fixture_payment_7002",
      asset: "USDCMATIC",
      transactionHash: "polygon_fixture_transaction_hash_7002",
      destinationWalletRef: "wallet_ref_fixture_usdc",
      grossQuantity: "20",
      providerFeeQuantity: "0.02",
      netQuantity: "19.98",
      grossVndValue: 500000,
      feeVndValue: 500,
      valuationRateSource: "NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE",
      valuationTimestamp: "2026-06-21T01:05:00.000Z",
    },
    references: {
      paymentIntentRecord: {
        id: "pi_fixture_usdcmatic",
        merchantId: "merchant_fixture_usdc",
        storeId: "store_fixture_usdc",
        provider: "nowpayments",
        providerConfigPurpose: "merchant_retail",
        providerConfigId: "cfg_fixture_merchant_usdc",
      },
      providerEventRecord: {
        provider: "nowpayments",
        providerEventId: "np_fixture_payment_7002",
        paymentIntentId: "pi_fixture_usdcmatic",
        status: "matched",
      },
      paymentEntryRecord: {
        id: "00000000-0000-4000-8000-000000007002",
        orderId: "order_fixture_usdcmatic",
        paymentIntentId: "pi_fixture_usdcmatic",
        providerEventId: "np_fixture_payment_7002",
      },
      orderRecord: {
        id: "order_fixture_usdcmatic",
        merchantId: "merchant_fixture_usdc",
        storeId: "store_fixture_usdc",
      },
    },
  },
] as const;

export const missingFeeManualReviewFixture = {
  providerEventId: "np_fixture_missing_fee_7003",
  paymentIntentId: "pi_fixture_missing_fee",
  merchantId: "merchant_fixture_missing_fee",
  storeId: "store_fixture_missing_fee",
  status: "manual_review",
  manualReviewReason: "missing_provider_fee_evidence",
  cryptoReceiptEvidence: null,
} as const;
