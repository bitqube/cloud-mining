"use server";

import { redirect } from "next/navigation";
import type { PaymentMethod } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { btqWalletFromEnv } from "@/lib/btq/wallet";
import { db } from "@/lib/db";
import { createOrderFromQuote, OrderError } from "@/lib/order-service";
import { createQuote, QuoteUnavailableError } from "@/lib/pricing-service";
import { getRouter } from "@/lib/router-instance";

export type BuyState = { error?: string } | undefined;

export async function quoteAction(_: BuyState, form: FormData): Promise<BuyState> {
  const user = await requireUser();
  const days = Number(form.get("days"));
  if (!Number.isInteger(days) || days < 1) return { error: "Choose how many days." };

  let quoteId: string;
  try {
    const quote = await createQuote(db, getRouter(), {
      userId: user.id,
      coinId: String(form.get("coin") ?? ""),
      planId: String(form.get("planId") ?? ""),
      days,
    });
    quoteId = quote.id;
  } catch (e) {
    if (e instanceof QuoteUnavailableError) return { error: `Not available right now: ${e.message}` };
    console.error("quote failed", e);
    return { error: "We could not reach the hashrate market. Please try again in a minute." };
  }
  redirect(`/buy/quote/${quoteId}`);
}

const REST_METHODS: PaymentMethod[] = ["STRIPE", "USDT"];

export async function placeOrderAction(_: BuyState, form: FormData): Promise<BuyState> {
  const user = await requireUser();
  const btqSharePct = Number(form.get("btqShare") ?? 0);
  const raw = String(form.get("method") ?? "");
  const method = REST_METHODS.includes(raw as PaymentMethod) ? (raw as PaymentMethod) : null;
  const ownPool =
    form.get("useOwnPool") === "on"
      ? {
          host: String(form.get("poolHost") ?? ""),
          port: String(form.get("poolPort") ?? ""),
          user: String(form.get("poolUser") ?? ""),
          pass: String(form.get("poolPass") ?? ""),
        }
      : undefined;

  let orderId: string;
  try {
    const order = await createOrderFromQuote(db, {
      quoteId: String(form.get("quoteId")),
      userId: user.id,
      payoutAddress: String(form.get("payoutAddress") ?? ""),
      ownPool,
      method,
      btqSharePct,
      btqWallet: btqSharePct > 0 ? btqWalletFromEnv() : null,
    });
    orderId = order.id;
  } catch (e) {
    if (e instanceof OrderError) return { error: e.message };
    throw e;
  }
  redirect(`/orders/${orderId}`);
}
