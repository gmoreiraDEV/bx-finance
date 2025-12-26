"use client";

import { authClient } from "@/lib/auth-client";

export default function HomePage() {
  const { data: session } = authClient.useSession();

  if (!session) return <a href="/login">Entrar</a>;

  return (
    <div className="p-6">
      <h1>Bem-vindo, {session.user.email}</h1>
      <button onClick={() => authClient.signOut()}>Sair</button>
    </div>
  );
}
