import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/**
 * Dev helper — entitle an existing user to every active resource and
 * optionally credit their wallet.
 *
 * The user row only exists after their first Google sign-in, so: sign in
 * once, then run
 *   npm run grant -- someone@example.com        # entitlements only
 *   npm run grant -- someone@example.com 500    # + 500.00 topup
 *
 * TODO(admin): replace with admin-console entitlement management.
 */
const prisma = new PrismaClient();

async function main() {
  const [email, topupArg] = process.argv.slice(2);
  if (email === undefined) {
    throw new Error("usage: npm run grant -- <email> [topupAmount]");
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (user === null) {
    throw new Error(`no user ${email} — sign in with Google once first`);
  }

  const resources = await prisma.resource.findMany({ where: { active: true } });
  for (const resource of resources) {
    await prisma.entitlement.upsert({
      where: { userId_resourceId: { userId: user.id, resourceId: resource.id } },
      update: {},
      create: { userId: user.id, resourceId: resource.id, grantedBy: "grant-script" },
    });
  }

  if (topupArg !== undefined) {
    const amount = Number(topupArg);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("topupAmount must be > 0");
    await prisma.ledgerEntry.create({
      data: { userId: user.id, type: "topup", amount: amount.toFixed(4) },
    });
  }

  console.log(
    `Granted ${email} ${resources.length} resource(s)` +
      (topupArg !== undefined ? ` + ${topupArg} topup` : ""),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
