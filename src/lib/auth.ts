import { prisma } from "@/lib/prisma";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  providers: [
    {
      type: "email",
      async sendVerificationRequest({
        identifier,
        url,
      }: {
        identifier: string;
        url: string;
      }) {
        await resend.emails.send({
          from: "no-reply@seusite.com",
          to: identifier,
          subject: "Confirme seu login",
          html: `
            <h2>Bem-vindo!</h2>
            <p>Clique no link abaixo para entrar:</p>
            <a href="${url}">${url}</a>
          `,
        });
      },
    },
  ],

  pages: {
    signIn: "/login",
    signOut: "/logout",
  },
});
