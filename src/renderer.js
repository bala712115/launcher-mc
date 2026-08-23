const playButton = document.getElementById("playButton");
const loginButton = document.getElementById("loginButton");

const logs = document.getElementById("logs");
const username = document.getElementById("username");
const ram = document.getElementById("ram");

const accountMode = document.getElementById("accountMode");
const accountStatus = document.getElementById("accountStatus");

// Éléments pour gérer l’affichage du compte Microsoft
const usernameGroup = document.getElementById("usernameGroup");
const microsoftGroup = document.getElementById("microsoftGroup");
const accountName = document.getElementById("accountName");

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
  const isOffline = accountMode.value === "offline";

  // Affiche / cache le champ pseudo
  usernameGroup.hidden = !isOffline;
  username.disabled = !isOffline;

  // Affiche / cache la zone compte Microsoft + bouton de login
  microsoftGroup.hidden = isOffline;
  loginButton.hidden = isOffline;

  // Gestion du texte de statut
  if (isOffline) {
    accountStatus.textContent = "Mode offline";
    accountName.textContent = "Compte non connecté";
    playButton.disabled = false;
    return;
  }

  // Mode online
  if (onlineAccount) {
    accountStatus.textContent = `Connecté avec Microsoft : ${onlineAccount.name}`;
    accountName.textContent = onlineAccount.name;
    playButton.disabled = false;
  } else {
    accountStatus.textContent = "Aucun compte Microsoft connecté.";
    accountName.textContent = "Compte non connecté";
    playButton.disabled = true;
  }
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

  progressLine.textContent = `[PROGRESSION] ${type} : ${task} / ${total}`;

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
  addLog(`Pseudo : ${launchUsername}`);
  addLog(`RAM attribuée : ${ram.value} Mo`);

  try {
    const result = await window.launcher.launchMinecraft({
      username: launchUsername,
      version: "1.21.1", // version fixe
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


// Initialisation
refreshAccountMode();