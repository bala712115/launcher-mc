const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("minecraft-launcher-core");
const { loginWithMicrosoft } = require("./microsoftAuth");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 680,
    minWidth: 900,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

function sendLog(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("minecraft-log", String(message));
  }
}

function sendFinished() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("minecraft-finished");
  }
}

function sendProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("minecraft-progress", progress);
  }
}

function offlineUuid(username) {
  const buffer = crypto
    .createHash("md5")
    .update(`OfflinePlayer:${username}`, "utf8")
    .digest();

  buffer[6] = (buffer[6] & 0x0f) | 0x30;
  buffer[8] = (buffer[8] & 0x3f) | 0x80;

  const hex = buffer.toString("hex");

  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
  ].join("-");
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

ipcMain.handle("get-minecraft-versions", async () => {
  const response = await fetch(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
  );

  if (!response.ok) {
    throw new Error(
      `Impossible de récupérer les versions : HTTP ${response.status}`
    );
  }

  const manifest = await response.json();

  return manifest.versions
    .filter((item) => item.type === "release")
    .slice(0, 30)
    .map((item) => ({
      id: item.id,
      type: item.type,
      releaseTime: item.releaseTime
    }));
});

ipcMain.handle("login-microsoft", async () => {
  sendLog("Démarrage de la connexion Microsoft…");

  const account = await loginWithMicrosoft((status) => {
    sendLog(`[MICROSOFT] ${status}`);
  });

  sendLog(`[MICROSOFT] Connecté : ${account.name}`);

  return account;
});

ipcMain.handle("launch-minecraft", async (_, settings) => {
  const version = settings?.version || "1.21.1";
  const requestedUsername = settings?.username?.trim() || "Joueur";
  const ram = Number(settings?.ram) || 4096;

  const mode = settings?.mode === "online" ? "online" : "offline";
  const account = settings?.account || null;

  let authorization;
  let username;

  if (mode === "online") {
    if (
      !account ||
      !account.accessToken ||
      !account.uuid ||
      !account.name
    ) {
      throw new Error(
        "Aucun compte Microsoft Minecraft valide n'est connecté."
      );
    }

    username = account.name;

    authorization = {
      access_token: account.accessToken,
      client_token: account.clientToken || "mon-launcher",
      uuid: account.uuid,
      name: account.name,
      user_properties: "{}",
      meta: {
        type: "msa"
      }
    };
  } else {
    username = requestedUsername;

    authorization = {
      access_token: "offline",
      client_token: "offline",
      uuid: offlineUuid(username),
      name: username,
      user_properties: "{}",
      meta: {
        type: "offline"
      }
    };
  }

  const gameDirectory = path.join(
    app.getPath("appData"),
    "MonLauncher",
    "minecraft"
  );

  fs.mkdirSync(gameDirectory, { recursive: true });

  const launcher = new Client();

  const options = {
    root: gameDirectory,

    authorization,

    version: {
      number: version,
      type: "release"
    },

    memory: {
      min: "1024M",
      max: `${ram}M`
    },

    javaPath: "javaw"
  };

  try {
    sendLog(`Préparation de Minecraft ${version}...`);
    sendLog(
      mode === "online"
        ? `Mode online : compte Microsoft ${username}.`
        : `Mode offline : pseudo ${username}.`
    );
    sendLog(`Dossier du jeu : ${gameDirectory}`);
    sendLog(`Mémoire maximale : ${ram} Mo`);

    launcher.on("debug", (message) => {
      sendLog(`[DEBUG] ${message}`);
      console.log("[MCLC DEBUG]", message);
    });

    launcher.on("data", (message) => {
      const text = message.toString().trim();

      if (text) {
        sendLog(`[MINECRAFT] ${text}`);
        console.log("[MINECRAFT]", text);
      }
    });

    launcher.on("download", (file) => {
      sendLog(`[FICHIER TÉLÉCHARGÉ] ${file}`);
    });

    launcher.on("download-status", (status) => {
      const current =
        status.current ??
        status.downloaded ??
        status.progress ??
        0;

      const total =
        status.total ??
        status.size ??
        0;

      if (total > 0) {
        sendLog(`[TÉLÉCHARGEMENT] ${current} / ${total}`);
      }
    });

    launcher.on("progress", (progress) => {
      sendProgress({
        type: progress.type || "fichiers",
        task: Number(progress.task ?? 0),
        total: Number(progress.total ?? 0)
      });
    });

    launcher.on("arguments", (args) => {
      sendLog("[JAVA] Commande de lancement générée.");
      console.log("[JAVA ARGUMENTS]", args);
    });

    launcher.on("close", (code) => {
      sendLog(`[FIN] Minecraft s'est fermé avec le code ${code}.`);
      sendFinished();
    });

    launcher.on("error", (error) => {
      const detail = error?.stack || error?.message || String(error);

      sendLog(`[ERREUR] ${detail}`);
      console.error("[MCLC ERROR]", error);
      sendFinished();
    });

    sendLog("Préparation des fichiers du jeu…");
    launcher.launch(options);

    return {
      success: true,
      message: "Le moteur démarre. Consulte les logs."
    };
  } catch (error) {
    const message = error?.stack || error?.message || String(error);

    sendLog(`[ERREUR] ${message}`);
    sendFinished();

    return {
      success: false,
      message
    };
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});