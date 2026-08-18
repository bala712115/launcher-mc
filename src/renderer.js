const playButton = document.getElementById("playButton");
const loginButton = document.getElementById("loginButton");

const logs = document.getElementById("logs");
const username = document.getElementById("username");
const version = document.getElementById("version");
const ram = document.getElementById("ram");

const accountMode = document.getElementById("accountMode");
const accountStatus = document.getElementById("accountStatus");

let onlineAccount = null;

function addLog(message) {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement("div");

  line.textContent = `[${time}] ${message}`;

  const progressLine = document.getElementById("progressLine");

  if (progressLine) {
    logs.insertBefore(line, progressLine);
  } else {
    logs.appendChild(line);
  }

  logs.scrollTop = logs.scrollHeight;
}

function clearLogs() {
  logs.innerHTML = "";
}

function refreshAccountMode() {
  const offline = accountMode.value === "offline";

  username.disabled = !offline;
  loginButton.hidden = offline;

  if (offline) {
    accountStatus.textContent =
      "Mode offline : utilisable uniquement sur un serveur de test configuré en offline.";
    return;
  }

  if (onlineAccount) {
    accountStatus.textContent =
      `Connecté avec Microsoft : ${onlineAccount.name}`;
    return;
  }

  accountStatus.textContent =
    "Aucun compte Microsoft connecté.";
}

window.launcher.onMinecraftLog((message) => {
  addLog(message);
});

window.launcher.onMinecraftProgress((progress) => {
  const type = progress.type || "fichiers";
  const task = Number(progress.task ?? 0);
  const total = Number(progress.total ?? 0);

  let progressLine = document.getElementById("progressLine");

  if (!progressLine) {
    progressLine = document.createElement("div");
    progressLine.id = "progressLine";
    logs.appendChild(progressLine);
  }

  progressLine.textContent =
    `[PROGRESSION] ${type} : ${task} / ${total}`;

  logs.scrollTop = logs.scrollHeight;
});

window.launcher.onMinecraftFinished(() => {
  playButton.disabled = false;
  addLog("Le bouton Jouer est de nouveau disponible.");
});

accountMode.addEventListener("change", () => {
  refreshAccountMode();

  if (accountMode.value === "offline") {
    addLog("Mode offline sélectionné.");
  } else {
    addLog("Mode online sélectionné.");
  }
});

loginButton.addEventListener("click", async () => {
  loginButton.disabled = true;
  addLog("Ouverture de la connexion Microsoft…");

  try {
    onlineAccount = await window.launcher.loginMicrosoft();

    addLog(`Connexion réussie : ${onlineAccount.name}`);
    refreshAccountMode();
  } catch (error) {
    addLog(`[ERREUR MICROSOFT] ${error.message}`);
  } finally {
    loginButton.disabled = false;
  }
});

playButton.addEventListener("click", async () => {
  const mode = accountMode.value;
  const playerName = username.value.trim();

  if (mode === "offline") {
    if (playerName.length < 3 || playerName.length > 16) {
      clearLogs();
      addLog("ERREUR : le pseudo doit contenir entre 3 et 16 caractères.");
      return;
    }
  }

  if (mode === "online" && !onlineAccount) {
    clearLogs();
    addLog("ERREUR : aucun compte Microsoft n'est connecté.");
    addLog("Clique sur « Se connecter avec Microsoft ».");
    return;
  }

  const launchUsername =
    mode === "online"
      ? onlineAccount.name
      : playerName;

  playButton.disabled = true;
  clearLogs();

  addLog("Préparation du lancement…");
  addLog(`Mode : ${mode === "online" ? "online (Microsoft)" : "offline"}`);
  addLog(`Version sélectionnée : ${version.value}`);
  addLog(`Pseudo : ${launchUsername}`);
  addLog(`RAM attribuée : ${ram.value} Mo`);

  try {
    const result = await window.launcher.launchMinecraft({
      username: launchUsername,
      version: version.value,
      ram: Number(ram.value),
      mode,
      account: mode === "online" ? onlineAccount : null
    });

    if (result?.message) {
      addLog(result.message);
    }
  } catch (error) {
    addLog(`[ERREUR INTERFACE] ${error.message}`);
    playButton.disabled = false;
  }
});

refreshAccountMode();