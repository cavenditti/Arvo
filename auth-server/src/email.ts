import { env } from "./env.js";

type PasswordResetMessage = {
  email: string;
  name: string;
  url: string;
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] ?? character,
  );
}

export async function sendPasswordResetEmail({
  email,
  name,
  url,
}: PasswordResetMessage): Promise<void> {
  const safeName = escapeHtml(name || "Agricoltore");
  const safeUrl = escapeHtml(url);
  const response = await fetch(
    `https://api.scaleway.com/transactional-email/v1alpha1/regions/${env.temRegion}/emails`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": env.temApiKey,
      },
      body: JSON.stringify({
        from: { name: "Arvo", email: env.temSender },
        to: [{ name, email }],
        subject: "Reimposta la password di Arvo",
        text: [
          `Ciao ${name || "Agricoltore"},`,
          "",
          "Usa questo link per scegliere una nuova password:",
          url,
          "",
          "Il link scade tra un'ora. Se non hai richiesto tu il cambio, ignora questa email.",
        ].join("\n"),
        html: `<p>Ciao ${safeName},</p><p>Usa questo link per scegliere una nuova password:</p><p><a href="${safeUrl}">Reimposta la password</a></p><p>Il link scade tra un'ora. Se non hai richiesto tu il cambio, ignora questa email.</p>`,
        project_id: env.scalewayProjectId,
      }),
    },
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Scaleway Transactional Email failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }
}
