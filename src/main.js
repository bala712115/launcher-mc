const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { loginWithMicrosoft } = require("./microsoftAuth");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 680,
    minWidth: 900,
    minHeight: 560,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

function sendLog(message) {
  const text = String(message);
  console.log(text);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("minecraft-log", text);
  }
}

function sendFinished() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("minecraft-finished");
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

function getOsName() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "osx";
  return "linux";
}

function rulesAllow(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return true;

  let allowed = false;

  for (const rule of rules) {
    let matches = true;

    if (rule.os?.name && rule.os.name !== getOsName()) {
      matches = false;
    }

    if (matches) {
      allowed = rule.action === "allow";
    }
  }

  return allowed;
}

function mavenPathFromName(name) {
  const parts = name.split(":");

  if (parts.length < 3) {
    throw new Error(`Coordonnées Maven invalides : ${name}`);
  }

  const [group, artifact, version] = parts;
  const classifier = parts.length >= 4 ? `-${parts[3]}` : "";

  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}${classifier}.jar`;
}

function mavenUrl(baseUrl, name) {
  return `${baseUrl.replace(/\/$/, "")}/${mavenPathFromName(name)}`;
}

function walkJars(directory, result = []) {
  if (!fs.existsSync(directory)) return result;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      walkJars(fullPath, result);
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".jar") &&
      !entry.name.toLowerCase().endsWith("-sources.jar")
    ) {
      result.push(fullPath);
    }
  }

  return result;
}

async function fetchJson(url, label) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${label} : HTTP ${response.status}`);
  }

  return response.json();
}

async function downloadFile(url, destination, label) {
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    return destination;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  sendLog(`Téléchargement : ${label}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Échec téléchargement ${label} : HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);

  return destination;
}

async function downloadLibrary(gameDirectory, library) {
  if (!rulesAllow(library.rules)) return null;

  const baseUrl = library.url || "https://libraries.minecraft.net/";
  const relativePath = library.downloads?.artifact?.path || mavenPathFromName(library.name);
  const url = library.downloads?.artifact?.url || mavenUrl(baseUrl, library.name);
  const destination = path.join(gameDirectory, "libraries", relativePath);

  return downloadFile(url, destination, library.name || relativePath);
}

async function getVanillaProfile(gameDirectory, minecraftVersion) {
  const versionDirectory = path.join(gameDirectory, "versions", minecraftVersion);
  const profilePath = path.join(versionDirectory, `${minecraftVersion}.json`);

  if (fs.existsSync(profilePath)) {
    return JSON.parse(fs.readFileSync(profilePath, "utf8"));
  }

  const manifest = await fetchJson(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    "Impossible de récupérer le manifeste Minecraft"
  );

  const versionEntry = manifest.versions?.find((entry) => entry.id === minecraftVersion);

  if (!versionEntry?.url) {
    throw new Error(`Version Minecraft introuvable : ${minecraftVersion}`);
  }

  sendLog(`Téléchargement du profil Vanilla ${minecraftVersion}…`);

  const profile = await fetchJson(
    versionEntry.url,
    `Impossible de récupérer le profil Vanilla ${minecraftVersion}`
  );

  fs.mkdirSync(versionDirectory, { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf8");

  return profile;
}

async function downloadVanilla(gameDirectory, minecraftVersion, vanillaProfile) {
  for (const library of vanillaProfile.libraries || []) {
    await downloadLibrary(gameDirectory, library);
  }

  const client = vanillaProfile.downloads?.client;

  if (!client?.url) {
    throw new Error("Le profil Vanilla ne contient pas l'URL du client.");
  }

  const clientJar = path.join(
    gameDirectory,
    "versions",
    minecraftVersion,
    `${minecraftVersion}.jar`
  );

  await downloadFile(client.url, clientJar, `Client Vanilla ${minecraftVersion}`);

  return clientJar;
}

async function downloadMinecraftAssets(gameDirectory, vanillaProfile) {
  const assetIndex = vanillaProfile.assetIndex;

  if (!assetIndex?.id || !assetIndex?.url) {
    throw new Error("Le profil Vanilla ne contient pas d'assetIndex valide.");
  }

  const assetsDirectory = path.join(gameDirectory, "assets");
  const indexesDirectory = path.join(assetsDirectory, "indexes");
  const objectsDirectory = path.join(assetsDirectory, "objects");
  const indexPath = path.join(indexesDirectory, `${assetIndex.id}.json`);

  fs.mkdirSync(indexesDirectory, { recursive: true });
  fs.mkdirSync(objectsDirectory, { recursive: true });

  let index;

  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      sendLog(`Index d'assets déjà présent : ${assetIndex.id}`);
    } catch {
      fs.rmSync(indexPath, { force: true });
    }
  }

  if (!index) {
    sendLog(`Téléchargement de l'index d'assets : ${assetIndex.id}`);

    const response = await fetch(assetIndex.url);

    if (!response.ok) {
      throw new Error(`Échec téléchargement index assets : HTTP ${response.status}`);
    }

    index = await response.json();
    fs.writeFileSync(indexPath, JSON.stringify(index), "utf8");
  }

  const objects = Object.entries(index.objects || {});
  let downloaded = 0;
  let present = 0;

  sendLog(`Vérification de ${objects.length} assets Minecraft…`);

  for (const [assetName, asset] of objects) {
    const hash = asset?.hash;

    if (!hash || hash.length < 2) {
      continue;
    }

    const destination = path.join(
      objectsDirectory,
      hash.substring(0, 2),
      hash
    );

    if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
      present++;
      continue;
    }

    await downloadFile(
      `https://resources.download.minecraft.net/${hash.substring(0, 2)}/${hash}`,
      destination,
      `asset ${assetName}`
    );

    downloaded++;

    if (downloaded % 100 === 0) {
      sendLog(`Assets téléchargés : ${downloaded}/${objects.length}`);
    }
  }

  sendLog(`Assets prêts : ${downloaded} téléchargés, ${present} déjà présents.`);
}

async function getFabricProfile(minecraftVersion) {
  const loaderVersion = "0.16.14";

  sendLog(
    `Préparation de Fabric Loader ${loaderVersion} pour Minecraft ${minecraftVersion}…`
  );

  const profile = await fetchJson(
    `https://meta.fabricmc.net/v2/versions/loader/${minecraftVersion}/${loaderVersion}/profile/json`,
    "Impossible de récupérer le profil Fabric"
  );

  return { loaderVersion, profile };
}

async function installFabric(gameDirectory, minecraftVersion, loaderVersion, fabricProfile) {
  const fabricVersionId = `fabric-loader-${loaderVersion}-${minecraftVersion}`;
  const versionDirectory = path.join(gameDirectory, "versions", fabricVersionId);
  const profilePath = path.join(versionDirectory, `${fabricVersionId}.json`);

  fs.mkdirSync(versionDirectory, { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(fabricProfile, null, 2), "utf8");

  for (const library of fabricProfile.libraries || []) {
    await downloadLibrary(gameDirectory, library);
  }

  return fabricVersionId;
}

function resolveArguments(argumentsList, variables) {
  const resolved = [];

  for (const item of argumentsList || []) {
    if (typeof item === "string") {
      resolved.push(replaceVariables(item, variables));
      continue;
    }

    if (!item || typeof item !== "object" || !rulesAllow(item.rules)) {
      continue;
    }

    const values = Array.isArray(item.value) ? item.value : [item.value];

    for (const value of values) {
      if (typeof value === "string") {
        resolved.push(replaceVariables(value, variables));
      }
    }
  }

  return resolved;
}

function replaceVariables(value, variables) {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    return variables[key] ?? `\${${key}}`;
  });
}

function installMods(gameDirectory) {
  const assetsDirectory = path.join(__dirname, "..", "assets");
  const modsDirectory = path.join(gameDirectory, "mods");

  if (!fs.existsSync(assetsDirectory)) {
    sendLog("Dossier assets absent : aucun mod à installer.");
    return;
  }

  fs.mkdirSync(modsDirectory, { recursive: true });

  const mods = fs.readdirSync(assetsDirectory)
    .filter((file) => file.toLowerCase().endsWith(".jar"))
    .filter((file) => !file.toLowerCase().endsWith("-sources.jar"));

  for (const mod of mods) {
    fs.copyFileSync(
      path.join(assetsDirectory, mod),
      path.join(modsDirectory, mod)
    );

    sendLog(`Mod installé/vérifié : ${mod}`);
  }
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
  const manifest = await fetchJson(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    "Impossible de récupérer les versions Minecraft"
  );

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
  const minecraftVersion = settings?.version || "1.21.1";
  const requestedUsername = settings?.username?.trim() || "Joueur";
  const ram = Math.max(1024, Number(settings?.ram) || 4096);
  const mode = settings?.mode === "online" ? "online" : "offline";
  const account = settings?.account || null;

  let username;
  let auth;

  if (mode === "online") {
    if (!account?.accessToken || !account?.uuid || !account?.name) {
      throw new Error("Aucun compte Microsoft Minecraft valide n'est connecté.");
    }

    username = account.name;
    auth = {
      accessToken: account.accessToken,
      uuid: account.uuid,
      clientId: account.clientToken || "mon-launcher"
    };
  } else {
    username = requestedUsername;
    auth = {
      accessToken: "offline",
      uuid: offlineUuid(username),
      clientId: "offline"
    };
  }

  const gameDirectory = path.join(
    app.getPath("appData"),
    "MonLauncher",
    "minecraft"
  );

  try {
    fs.mkdirSync(gameDirectory, { recursive: true });

    sendLog(`Préparation de Minecraft ${minecraftVersion} avec Fabric…`);
    sendLog(`Dossier du jeu : ${gameDirectory}`);
    sendLog(`Mémoire maximale : ${ram} Mo`);

    const vanillaProfile = await getVanillaProfile(gameDirectory, minecraftVersion);
    const clientJar = await downloadVanilla(gameDirectory, minecraftVersion, vanillaProfile);

    await downloadMinecraftAssets(gameDirectory, vanillaProfile);

    const { loaderVersion, profile: fabricProfile } = await getFabricProfile(minecraftVersion);
    const fabricVersionId = await installFabric(
      gameDirectory,
      minecraftVersion,
      loaderVersion,
      fabricProfile
    );

    installMods(gameDirectory);

    const libraryJars = walkJars(path.join(gameDirectory, "libraries"));
    const classpathParts = [...new Set([...libraryJars, clientJar])];
    const classpath = classpathParts.join(path.delimiter);

    const intermediaryJar = classpathParts.find((jarPath) =>
      jarPath.includes(`${path.sep}net${path.sep}fabricmc${path.sep}intermediary${path.sep}${minecraftVersion}${path.sep}`)
    );

    if (!intermediaryJar) {
      throw new Error("Le JAR intermediary est absent du classpath.");
    }

    if (!vanillaProfile.assetIndex?.id) {
      throw new Error("Asset index Vanilla introuvable.");
    }

    sendLog(`JARs dans le classpath : ${classpathParts.length}`);
    sendLog(`Intermediary téléchargé : ${intermediaryJar}`);

    const nativesDirectory = path.join(gameDirectory, "natives", minecraftVersion);
    fs.mkdirSync(nativesDirectory, { recursive: true });

    const variables = {
      auth_player_name: username,
      version_name: fabricVersionId,
      game_directory: gameDirectory,
      assets_root: path.join(gameDirectory, "assets"),
      assets_index_name: vanillaProfile.assetIndex.id,
      auth_uuid: auth.uuid,
      auth_access_token: auth.accessToken,
      clientid: auth.clientId,
      auth_xuid: auth.uuid,
      user_type: mode === "online" ? "msa" : "legacy",
      version_type: "release",
      natives_directory: nativesDirectory,
      launcher_name: "MonLauncher",
      launcher_version: "1.0.0",
      classpath,
      classpath_separator: path.delimiter,
      library_directory: path.join(gameDirectory, "libraries")
    };

    const profileJvmArgs = resolveArguments(fabricProfile.arguments?.jvm, variables);
    const profileGameArgs = resolveArguments(fabricProfile.arguments?.game, variables);

    const javaPath = process.platform === "win32" ? "javaw" : "java";
    const javaArgs = [
      `-Xmx${ram}M`,
      "-Xms1024M",
      ...profileJvmArgs,
      "-cp",
      classpath,
      fabricProfile.mainClass || "net.fabricmc.loader.impl.launch.knot.KnotClient",
      ...profileGameArgs,
      "--username",
      username,
      "--version",
      fabricVersionId,
      "--gameDir",
      gameDirectory,
      "--assetsDir",
      path.join(gameDirectory, "assets"),
      "--assetIndex",
      vanillaProfile.assetIndex.id,
      "--uuid",
      auth.uuid,
      "--accessToken",
      auth.accessToken,
      "--clientId",
      auth.clientId,
      "--xuid",
      auth.uuid,
      "--userType",
      mode === "online" ? "msa" : "legacy",
      "--versionType",
      "release"
    ];

    sendLog(`Lancement Java : ${javaPath}`);

    const child = spawn(javaPath, javaArgs, {
      cwd: gameDirectory,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) sendLog(`[MINECRAFT] ${text}`);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) sendLog(`[MINECRAFT] ${text}`);
    });

    child.on("close", (code) => {
      sendLog(`[FIN] Minecraft s'est fermé avec le code ${code}.`);
      sendFinished();
    });

    child.on("error", (error) => {
      sendLog(`[ERREUR JAVA] ${error.stack || error.message || error}`);
      sendFinished();
    });

    return { success: true, message: "Minecraft est en cours de lancement." };
  } catch (error) {
    const message = error?.stack || error?.message || String(error);
    sendLog(`[ERREUR] ${message}`);
    sendFinished();

    return { success: false, message };
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
