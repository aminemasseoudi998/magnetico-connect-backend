import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/**
 * Dev seed — demo resources only.
 *
 * Users are no longer seeded: they are created on their first Google sign-in
 * (Keycloak `sub` -> users row). After signing in once, give a user access and
 * credit with:  npm run grant -- <email> [topupAmount]
 *
 * Run: npm run prisma:seed  (requires DATABASE_URL + migrated portal-db)
 */
const prisma = new PrismaClient();

async function main() {
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

  console.log(`Seeded resources ${ssh.name}, ${rdp.name}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
