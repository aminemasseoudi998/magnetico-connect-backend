import { PrismaClient } from "@prisma/client";

/**
 * Dev seed — creates the stub user from Step 4 plus two demo resources and
 * entitlements so the Step 5 endpoints have something to return immediately.
 *
 * Run: npm run prisma:seed  (requires DATABASE_URL + migrated portal-db)
 *
 * The stub identity MUST match STUB_* in backend/.env:
 *   STUB_USER_ID / STUB_KEYCLOAK_SUB / STUB_EMAIL
 */
const prisma = new PrismaClient();

async function main() {
  const userId = process.env["STUB_USER_ID"] ?? "00000000-0000-0000-0000-000000000001";

  const user = await prisma.user.upsert({
    where: { email: process.env["STUB_EMAIL"] ?? "dev@magnetico.local" },
    update: {},
    create: {
      id: userId,
      keycloakSub: process.env["STUB_KEYCLOAK_SUB"] ?? "stub-sub-dev-only",
      email: process.env["STUB_EMAIL"] ?? "dev@magnetico.local",
      displayName: process.env["STUB_DISPLAY_NAME"] ?? "Dev User",
      status: "active",
    },
  });

  // TODO(tariffs): replace these demo rates with the real tariff table.
  const ssh = await prisma.resource.upsert({
    where: { name: "demo-ssh-01" },
    update: {},
    create: {
      name: "demo-ssh-01",
      protocol: "ssh",
      tier: "standard",
      guacConnectionId: "1",
      ratePerMinute: "0.80",
      active: true,
    },
  });

  const rdp = await prisma.resource.upsert({
    where: { name: "demo-rdp-01" },
    update: {},
    create: {
      name: "demo-rdp-01",
      protocol: "rdp",
      tier: "accelerated",
      guacConnectionId: "2",
      ratePerMinute: "2.40",
      active: true,
    },
  });

  for (const resource of [ssh, rdp]) {
    await prisma.entitlement.upsert({
      where: { userId_resourceId: { userId: user.id, resourceId: resource.id } },
      update: {},
      create: {
        userId: user.id,
        resourceId: resource.id,
        grantedBy: "seed",
      },
    });
  }

  await prisma.ledgerEntry.create({
    data: { userId: user.id, type: "topup", amount: "500.00" },
  });

  console.log(`Seeded stub user ${user.email} with 2 resources + 500.00 topup`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
