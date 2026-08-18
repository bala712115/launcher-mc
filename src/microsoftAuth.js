const http = require("http");
const { URL } = require("url");
const { shell } = require("electron");
const {
  PublicClientApplication,
  CryptoProvider
} = require("@azure/msal-node");

const CLIENT_ID = "08f64d2d-4b18-4666-bb5f-9510a42e331f";
const AUTHORITY = "https://login.microsoftonline.com/consumers";
const REDIRECT_URI = "http://localhost:42813";
const CALLBACK_PORT = 42813;
const SCOPES = ["XboxLive.signin", "offline_access"];

const msalClient = new PublicClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: AUTHORITY
  }
});

const cryptoProvider = new CryptoProvider();

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.errorMessage ||
      data.error_description ||
      data.error ||
      `Erreur HTTP ${response.status}`
    );
  }

  return data;
}

function createCallbackServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      resolve(server);
    });

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(
          `Le port ${CALLBACK_PORT} est déjà utilisé. Ferme l'autre instance du launcher puis réessaie.`
        ));
        return;
      }

      reject(error);
    });
  });
}

function waitForAuthorizationCode(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("La connexion Microsoft a expiré. Réessaie."));
    }, 180000);

    server.on("request", (request, response) => {
      const callbackUrl = new URL(request.url, REDIRECT_URI);
      const code = callbackUrl.searchParams.get("code");
      const error = callbackUrl.searchParams.get("error");
      const errorDescription = callbackUrl.searchParams.get("error_description");

      if (error || !code) {
        clearTimeout(timeout);

        response.writeHead(400, {
          "Content-Type": "text/html; charset=utf-8"
        });

        response.end(`
          <!doctype html>
          <html lang="fr">
            <head>
              <meta charset="utf-8">
              <title>Connexion refusée</title>
            </head>
            <body>
              <h2>Connexion annulée ou refusée.</h2>
              <p>Tu peux fermer cette fenêtre et revenir au launcher.</p>
            </body>
          </html>
        `);

        reject(new Error(
          errorDescription ||
          error ||
          "Microsoft n'a pas fourni de code d'autorisation."
        ));
        return;
      }

      clearTimeout(timeout);

      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      response.end(`
        <!doctype html>
        <html lang="fr">
          <head>
            <meta charset="utf-8">
            <title>Connexion réussie</title>
          </head>
          <body>
            <h2>Connexion Microsoft réussie.</h2>
            <p>Tu peux fermer cette fenêtre et revenir au launcher.</p>
          </body>
        </html>
      `);

      resolve(code);
    });
  });
}

async function authenticateXbox(microsoftAccessToken, onStatus) {
  onStatus("Connexion à Xbox Live…");

  const xbl = await requestJson(
    "https://user.auth.xboxlive.com/user/authenticate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        Properties: {
          AuthMethod: "RPS",
          SiteName: "user.auth.xboxlive.com",
          RpsTicket: `d=${microsoftAccessToken}`
        },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType: "JWT"
      })
    }
  );

  const xblToken = xbl.Token;
  const userHash = xbl.DisplayClaims?.xui?.[0]?.uhs;

  if (!xblToken || !userHash) {
    throw new Error("Xbox Live a renvoyé une réponse incomplète.");
  }

  onStatus("Validation XSTS…");

  const xsts = await requestJson(
    "https://xsts.auth.xboxlive.com/xsts/authorize",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        Properties: {
          SandboxId: "RETAIL",
          UserTokens: [xblToken]
        },
        RelyingParty: "rp://api.minecraftservices.com/",
        TokenType: "JWT"
      })
    }
  );

  if (!xsts.Token) {
    throw new Error("Jeton XSTS introuvable.");
  }

  onStatus("Connexion aux services Minecraft…");

  const minecraftAuth = await requestJson(
    "https://api.minecraftservices.com/authentication/login_with_xbox",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        identityToken: `XBL3.0 x=${userHash};${xsts.Token}`
      })
    }
  );

  const minecraftAccessToken = minecraftAuth.access_token;

  if (!minecraftAccessToken) {
    throw new Error("Jeton Minecraft introuvable.");
  }

  onStatus("Récupération du profil Minecraft Java…");

  const profile = await requestJson(
    "https://api.minecraftservices.com/minecraft/profile",
    {
      headers: {
        Authorization: `Bearer ${minecraftAccessToken}`
      }
    }
  );

  if (!profile.id || !profile.name) {
    throw new Error(
      "Ce compte ne possède pas de profil Minecraft Java Edition."
    );
  }

  return {
    name: profile.name,
    uuid: profile.id,
    accessToken: minecraftAccessToken,
    clientToken: CLIENT_ID
  };
}

async function loginWithMicrosoft(onStatus = () => {}) {
  if (!CLIENT_ID || CLIENT_ID.trim().length < 30) {
    throw new Error(
      "CLIENT_ID invalide. Vérifie l'ID d'application (client) Microsoft Entra."
    );
  }

  let callbackServer;

  try {
    callbackServer = await createCallbackServer();

    const pkceCodes = await cryptoProvider.generatePkceCodes();

    const authorizationUrl = await msalClient.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
      prompt: "select_account",
      codeChallenge: pkceCodes.challenge,
      codeChallengeMethod: "S256"
    });

    onStatus("Ouverture du navigateur pour la connexion Microsoft…");

    const codePromise = waitForAuthorizationCode(callbackServer);

    await shell.openExternal(authorizationUrl);

    const authorizationCode = await codePromise;

    onStatus("Récupération du jeton Microsoft…");

    const microsoftResult = await msalClient.acquireTokenByCode({
      code: authorizationCode,
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
      codeVerifier: pkceCodes.verifier
    });

    if (!microsoftResult?.accessToken) {
      throw new Error("Jeton Microsoft introuvable.");
    }

    return await authenticateXbox(microsoftResult.accessToken, onStatus);
  } finally {
    if (callbackServer) {
      callbackServer.close();
    }
  }
}

module.exports = {
  loginWithMicrosoft
};
