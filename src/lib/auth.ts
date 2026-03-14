import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";

const baseURL = process.env.BETTER_AUTH_URL!;
// Allow both http and https so redirects or links using either protocol are accepted
const trustedOrigins = baseURL
  ? [baseURL, baseURL.replace(/^https:/, "http:"), baseURL.replace(/^http:/, "https:")].filter(
      (url, i, arr) => arr.indexOf(url) === i
    )
  : [];

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  trustedOrigins,
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET!,
  socialProviders: {
    discord: {
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
    },
  },
});

export type AuthType = {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
};
