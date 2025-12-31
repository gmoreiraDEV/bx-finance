import { prisma } from "@/lib/prisma";
import {
  createAsaasCustomer,
  createAsaasSubscription,
  extractAsaasPaymentLink,
  listAsaasSubscriptionPayments,
} from "@/lib/asaas";
import { NextResponse } from "next/server";

function mapStatus(status?: string) {
  if (!status) return "PENDING";
  if (["ACTIVE", "RECEIVED"].includes(status.toUpperCase())) return "ACTIVE";
  if (["PENDING", "AWAITING", "PENDING_PAYMENT"].includes(status.toUpperCase()))
    return "PENDING";
  if (["CANCELLED", "DELETED"].includes(status.toUpperCase()))
    return "CANCELLED";
  return "FAILED";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");
  const sync = searchParams.get("sync") === "true";

  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const billings = await prisma.billing.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  let latest = billings[0] || null;

  if (sync) {
    for (const billing of billings) {
      if (!billing.providerSubscriptionId) continue;
      try {
        const payments = await listAsaasSubscriptionPayments(
          billing.providerSubscriptionId
        );
        const firstPayment = payments[0];
        const link =
          payments.find((p) => p.paymentLink)?.paymentLink ||
          firstPayment?.invoiceUrl ||
          firstPayment?.bankSlipUrl ||
          firstPayment?.boletoUrl ||
          firstPayment?.pixQrCodeUrl ||
          firstPayment?.pix?.qrCodeUrl ||
          billing.providerPaymentLink;
        const status = mapStatus(firstPayment?.status || billing.status);

        await prisma.billing.update({
          where: { id: billing.id },
          data: {
            providerPaymentLink: link,
            status,
            metadata: payments || billing.metadata,
          },
        });
      } catch {
        // ignore individual sync errors
      }
    }
    // Reload after sync
    const refreshed = await prisma.billing.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    latest = refreshed[0] || null;
    return NextResponse.json({ billing: latest, billings: refreshed });
  }

  // Try to fetch payment link from Asaas using subscription ID if missing.
  if (latest?.providerSubscriptionId && !latest.providerPaymentLink) {
    try {
      const payments = await listAsaasSubscriptionPayments(
        latest.providerSubscriptionId
      );
      const link =
        payments.find((p) => p.paymentLink)?.paymentLink ||
        payments[0]?.invoiceUrl ||
        payments[0]?.bankSlipUrl ||
        payments[0]?.boletoUrl ||
        payments[0]?.pixQrCodeUrl ||
        payments[0]?.pix?.qrCodeUrl;
      if (link) {
        latest = await prisma.billing.update({
          where: { id: latest.id },
          data: { providerPaymentLink: link },
        });
      }
    } catch {
      // ignore fetch errors, return cached billing
    }
  }

  return NextResponse.json({ billing: latest, billings });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { userId, planId, billingCycle, amountCents } = body ?? {};

  if (!userId || !planId || !billingCycle) {
    return NextResponse.json(
      { error: "userId, planId e billingCycle são obrigatórios" },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });
  }

  const previousBilling = await prisma.billing.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  // If there is a pending billing with a link, reuse it to avoid duplicating charges.
  if (
    previousBilling &&
    previousBilling.status === "PENDING" &&
    previousBilling.providerPaymentLink
  ) {
    return NextResponse.json(
      { billing: previousBilling, paymentLink: previousBilling.providerPaymentLink },
      { status: 200 }
    );
  }

  let providerCustomerId = previousBilling?.providerCustomerId;

  try {
    if (!providerCustomerId) {
      const customer = await createAsaasCustomer({
        name: user.name,
        email: user.email,
      });
      providerCustomerId = customer.id;
    }

    const subscription = await createAsaasSubscription({
      customerId: providerCustomerId,
      planId,
      amountCents: Number(amountCents || 0),
      cycle: billingCycle === "yearly" ? "YEARLY" : "MONTHLY",
    });
    let paymentLink =
      subscription.paymentLink || extractAsaasPaymentLink(subscription);
    let paymentsMetadata: any = subscription;

    // If Asaas didn't return a link, fetch the first payment from the subscription.
    if (!paymentLink && subscription.id) {
      try {
        const payments = await listAsaasSubscriptionPayments(subscription.id);
        paymentsMetadata = payments;
        const first = payments[0];
        paymentLink =
          payments.find((p) => p.paymentLink)?.paymentLink ||
          first?.invoiceUrl ||
          first?.bankSlipUrl ||
          first?.boletoUrl ||
          first?.pixQrCodeUrl ||
          first?.pix?.qrCodeUrl ||
          null;
      } catch {
        // ignore and proceed with null link
      }
    }

    const billing = await prisma.billing.create({
      data: {
        userId,
        planId,
        cycle: billingCycle === "yearly" ? "YEARLY" : "MONTHLY",
        status: mapStatus(subscription.status),
        providerCustomerId,
        providerSubscriptionId: subscription.id,
        providerPaymentLink: paymentLink,
        priceCents: amountCents ? Number(amountCents) : null,
        metadata: paymentsMetadata,
      },
    });

    return NextResponse.json(
      { billing, subscription, paymentLink: paymentLink || null },
      { status: 201 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Erro ao criar cobrança" },
      { status: 500 }
    );
  }
}
