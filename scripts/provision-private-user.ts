import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { getPrivateUserEmail } from "../src/lib/auth-mode";

const db = new PrismaClient();
async function main() {
  const email = getPrivateUserEmail();
  const version = (await db.systemConfig.findUnique({ where: { key: "legal.version" } }))?.value ?? "1";
  const user = await db.user.upsert({
    where: { email },
    update: {},
    create: { email, termsVersion: version, termsAcceptedAt: new Date() },
  });
  if (user.deletedAt) throw new Error("该用户已被注销；请重新选择 AUTH_PRIVATE_USER");
  console.log(`Private account ready: ${user.email} (${user.id})`);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
