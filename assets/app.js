/* =========================================================
   ACADÉMIE ÉTOILE — logique partagée entre toutes les pages
   ========================================================= */

const STORAGE_KEY = "etoileAcademyCharacter_v1";

let currentUser = null;
let lastCoinSyncStatus = "unknown"; // "ok" | "error" | "offline" | "unknown" — visible dans la minibar

/* ---------- Connexion & synchronisation (Firebase Auth + Firestore) ----------
   Une fois connecté avec Google sur un appareil, Firebase garde la session
   ouverte automatiquement (comme n'importe quelle appli) : rien à retaper,
   rien à copier. Se connecter avec le même compte Google sur un autre
   appareil retrouve automatiquement la même progression. */

function isCloudConfigured(){
  return typeof firebase !== "undefined" && typeof db !== "undefined" && !!db;
}

function waitForAuthReady(){
  return new Promise(resolve => {
    if(!isCloudConfigured()){ resolve(null); return; }
    const unsubscribe = firebase.auth().onAuthStateChanged(user => {
      unsubscribe();
      resolve(user);
    });
  });
}

async function signInWithProvider(providerName){
  if(!isCloudConfigured()){
    alert("La synchronisation n'est pas encore configurée (assets/firebase-config.js).");
    return;
  }
  try{
    let provider;
    if(providerName === "google"){
      provider = new firebase.auth.GoogleAuthProvider();
    } else if(providerName === "microsoft"){
      provider = new firebase.auth.OAuthProvider("microsoft.com");
    } else {
      return;
    }
    await firebase.auth().signInWithPopup(provider);
    location.reload();
  }catch(e){
    console.error("Connexion impossible :", e);
    alert("La connexion a échoué. Réessaie, ou vérifie que le domaine du site est bien autorisé dans Firebase (Authentication > Settings > Authorized domains).");
  }
}

function signInWithGoogle(){ return signInWithProvider("google"); }
function signInWithMicrosoft(){ return signInWithProvider("microsoft"); }

async function signOutUser(){
  if(confirm("Se déconnecter ? Ta progression reste sauvegardée en ligne, tu pourras te reconnecter avec le même compte à tout moment.")){
    await firebase.auth().signOut();
    location.reload();
  }
}

/* ---------- Synchronisation cloud (Firestore) ----------
   Chaque sauvegarde locale est aussi poussée en ligne, sous le document
   characters/{uid}, où uid est l'identifiant unique du compte Google
   connecté. Sans connexion (ou sans configuration Firebase), le site
   continue de fonctionner uniquement en local (IndexedDB), de façon
   transparente. */

async function cloudGet(uid){
  if(!isCloudConfigured()) return null;
  try{
    const snap = await db.collection("etoile_characters").doc(uid).get();
    return snap.exists ? snap.data().state : null;
  }catch(e){
    console.warn("Synchronisation cloud indisponible (lecture) :", e);
    return null;
  }
}

async function cloudSet(uid, stateObj){
  if(!isCloudConfigured()) return false;
  try{
    await db.collection("etoile_characters").doc(uid).set({
      state: stateObj,
      updatedAt: new Date().toISOString()
    });
    return true;
  }catch(e){
    console.warn("Synchronisation cloud indisponible (écriture) :", e);
    return false;
  }
}

/* ---------- Pièces communes (Le Trésor Commun) ----------
   1 pièce tous les 300 XP cumulés. C'est une monnaie PARTAGÉE : une fois
   gagnée ici, elle peut être dépensée depuis "Le Trésor Commun" (le site
   compagnon des deux jeux). On ne garde donc localement qu'un cache
   d'affichage (coinsCache) + le compteur de pièces déjà accordées depuis
   l'XP (coinsGranted) ; le vrai solde vit dans Firestore, INCRÉMENTÉ
   (jamais réécrit en dur) pour ne jamais effacer une dépense faite ailleurs. */
const COINS_PER_XP = 300;
const SHARED_COIN_DOC = "kawaii";

async function cloudGetSharedCoins(){
  if(!isCloudConfigured()){
    lastCoinSyncStatus = "offline";
    return null;
  }
  try{
    const snap = await db.collection("sharedCoins").doc(SHARED_COIN_DOC).get();
    lastCoinSyncStatus = "ok";
    return snap.exists ? snap.data() : null;
  }catch(e){
    console.warn("Lecture des pièces partagées indisponible :", e);
    lastCoinSyncStatus = "error";
    return null;
  }
}

async function refreshCoinsCache(){
  const shared = await cloudGetSharedCoins();
  if(shared && typeof shared.coins === "number"){
    state.coinsCache = shared.coins;
    saveState();
  }
  return state.coinsCache;
}

/* Convertit l'XP cumulé en pièces, une seule fois par palier de 300 XP.
   Appelée à chaque gain d'XP ET une fois au chargement (pour convertir
   d'un coup l'XP déjà accumulé avant l'existence de ce système). */
function grantCoinsFromXP(){
  const totalCoinsEver = Math.floor(state.totalXPEarned / COINS_PER_XP);
  if(totalCoinsEver > state.coinsGranted){
    state.coinsGranted = totalCoinsEver;
    // Valeur d'affichage optimiste en attendant confirmation du serveur.
    if(state.coinsCache === undefined || state.coinsCache === null || state.coinsCache < state.coinsGranted){
      state.coinsCache = state.coinsGranted;
    }
  }
  trySendPendingCoins();
}

/* Envoie à Firestore la différence entre les pièces "gagnées" localement
   (coinsGranted) et celles dont l'envoi a été RÉELLEMENT confirmé par le
   serveur (coinsConfirmedSent). Si un envoi précédent avait échoué (panne,
   règles non publiées...), cette différence reste positive et la fonction
   réessaie automatiquement à chaque chargement et à chaque gain d'XP —
   aucune pièce n'est donc jamais perdue en silence. */
function trySendPendingCoins(){
  const pending = state.coinsGranted - (state.coinsConfirmedSent || 0);
  if(pending <= 0) return;
  if(!isCloudConfigured()){
    console.warn(`${pending} pièce(s) en attente d'envoi à Firestore, mais Firebase n'est pas connecté.`);
    lastCoinSyncStatus = "offline";
    return;
  }
  db.collection("sharedCoins").doc(SHARED_COIN_DOC).set({
    coins: firebase.firestore.FieldValue.increment(pending),
    name: "Scream Gym",
    updatedAt: new Date().toISOString()
  }, { merge: true }).then(() => {
    state.coinsConfirmedSent = (state.coinsConfirmedSent || 0) + pending;
    lastCoinSyncStatus = "ok";
    saveState();
    refreshCoinsCache();
  }).catch(e => {
    console.warn(`Envoi de ${pending} pièce(s) indisponible (nouvelle tentative au prochain chargement) :`, e);
    lastCoinSyncStatus = "error";
  });
}

const DB_NAME = "etoileAcademyDB";
const DB_STORE = "kv";
const DB_VERSION = 1;

/* ---------- Couche de stockage persistant (IndexedDB) ----------
   Remplace le localStorage brut par IndexedDB : plus de capacité,
   plus robuste, et strictement transparent pour le reste du code —
   loadState()/saveState() gardent la même fonction, juste en asynchrone. */

let _dbPromise = null;
function openDB(){
  if(_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if(!("indexedDB" in window)){ reject(new Error("IndexedDB indisponible")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return _dbPromise;
}

async function idbGet(key){
  try{
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }catch(e){
    return undefined;
  }
}

async function idbSet(key, value){
  try{
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      const req = tx.objectStore(DB_STORE).put(value, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }catch(e){
    console.error("Impossible d'enregistrer la progression :", e);
    return false;
  }
}

/* ---------- Programme d'entraînement ---------- */
const PROGRAM = {
  push: {
    title: "Haut du Corps I",
    exos: [
      ["Chest Press (développé assis guidé)", "3", "10-12", "Assis dans la machine, dossier réglé à hauteur de poitrine, tu pousses les poignées devant toi. Raffermit la poitrine et le haut du buste en toute sécurité.", "chest-press", ["pecs","epaules","triceps"]],
      ["Shoulder Press (développé épaules guidé)", "3", "10-12", "Assis, dos calé contre le dossier, tu pousses les poignées au-dessus de la tête. Dessine des épaules toniques et légèrement arrondies.", "shoulder-press", ["epaules"]],
      ["Pec Fly / Écarté (pec deck)", "3", "12-15", "Assis, coudes légèrement fléchis posés sur les appuis, tu rapproches les bras devant toi en arc de cercle. Raffermit la poitrine sans faire gonfler les bras.", "pec-fly", ["pecs"]],
      ["Élévations latérales (haltères)", "3", "15-20", "Haltères légers le long du corps, tu lèves les bras sur les côtés jusqu'à l'horizontale. Dessine joliment le contour de l'épaule.", "dumbbell", ["epaules"]],
      ["Extension triceps à la poulie haute", "3", "15-20", "Face au Cable Crossover (poulie haute), coudes fixes au corps, tu pousses la barre ou la corde vers le bas. Raffermit l'arrière du bras.", "cable-pulley", ["triceps"]],
    ]
  },
  push2: {
    title: "Haut du Corps II",
    exos: [
      ["Développé incliné haltères (banc inclinable)", "3", "10-12", "Sur un banc réglé à 30-45°, tu pousses les haltères vers le haut. Cible le haut de la poitrine pour un buste bien soutenu.", "dumbbell", ["pecs","epaules"]],
      ["Développé serré à la Smith Machine", "3", "10-12", "Sur la Smith Machine, prise resserrée sur la barre guidée, tu pousses au-dessus de la poitrine. Tonifie pectoraux et triceps avec un mouvement guidé et sécurisé.", "smith-machine", ["pecs","triceps"]],
      ["Élévations latérales + frontales (haltères)", "3", "12-15", "Alterne élévations sur le côté et devant toi pour sculpter l'ensemble de l'épaule sous tous les angles.", "dumbbell", ["epaules"]],
      ["Développé Arnold (haltères)", "3", "10-12", "Variante du développé épaules où tu tournes les paumes vers l'avant en poussant. Sollicite l'épaule sous plusieurs angles pour un rendu bien dessiné.", "dumbbell", ["epaules"]],
      ["Extension triceps nuque (haltère)", "3", "15-20", "Haltère tenu à deux mains derrière la tête, tu tends les bras vers le haut. Cible le dessous du bras, souvent négligé.", "dumbbell", ["triceps"]],
    ]
  },
  pull: {
    title: "Dos & Bras I",
    exos: [
      ["Lat Pulldown (tirage vertical poulie haute)", "3", "10-12", "Assis, cuisses calées sous les appuis, tu tires la barre vers le haut de la poitrine. Dessine la largeur du dos et affine la taille par contraste.", "lat-pulldown", ["dos","biceps"]],
      ["Seated Row (tirage horizontal assis)", "3", "10-12", "Assis, pieds calés sur les appuis, buste droit, tu tires les poignées vers le nombril. Construit un dos bien dessiné, visible même en tenue légère.", "seated-row", ["dos","biceps"]],
      ["Tirage poulie basse prise serrée", "3", "12-15", "Assis face à la poulie basse, tu tires la poignée triangle vers le buste en gardant le dos droit. Complète le travail du milieu du dos.", "cable-pulley", ["dos"]],
      ["Face pull (poulie double)", "3", "15-20", "Tu tires une corde à hauteur du visage en écartant les mains vers l'extérieur. Corrige la posture et dessine l'arrière d'épaule.", "cable-pulley", ["epaules","dos"]],
      ["Biceps Curl (machine pupitre)", "3", "12-15", "Coudes calés sur le pupitre incliné, tu fléchis les avant-bras pour remonter la barre ou les poignées. Tonifie le bras sans le faire gonfler.", "dumbbell", ["biceps"]],
    ]
  },
  pull2: {
    title: "Dos & Bras II",
    exos: [
      ["Rowing unilatéral à la poulie basse", "3", "10-12", "Debout ou un genou au sol, tu tires la poignée d'un seul côté vers la hanche. Corrige les déséquilibres gauche-droite et affine le dos.", "cable-pulley", ["dos","biceps"]],
      ["Lat Pulldown prise large", "3", "12-15", "Barre tirée devant la poitrine avec une prise large sur le Lat Pulldown. Accentue le dessin en V du dos.", "lat-pulldown", ["dos"]],
      ["Pull-over à la poulie haute", "3", "12-15", "Bras tendus, tu descends puis remontes la barre depuis la poulie haute au-dessus de la tête. Étire le dos et engage aussi les abdominaux.", "cable-pulley", ["dos","pecs"]],
      ["Curl marteau (haltères)", "3", "12-15", "Curl réalisé paumes face à face (prise neutre). Tonifie le bras et l'avant-bras différemment du curl classique.", "dumbbell", ["biceps"]],
      ["Superman (gainage dos)", "3", "12-15", "Allongée sur le ventre, tu soulèves bras et jambes en même temps. Renforce le bas du dos et améliore la posture.", "bench", ["dos"]],
    ]
  },
  legs: {
    title: "Fessiers & Jambes",
    exos: [
      ["Hip Thrust (Smith Machine ou barre)", "4", "12-15", "Dos appuyé sur un banc, barre guidée sur la Smith Machine ou libre posée sur les hanches, tu pousses le bassin vers le haut. L'exercice le plus efficace pour arrondir et raffermir les fessiers.", "smith-machine", ["fessiersischios"]],
      ["Squat (Cage à squat / Smith Machine)", "3", "10-12", "Barre sur les épaules dans la cage à squat, ou guidée sur la Smith Machine, tu descends les hanches vers l'arrière puis remontes. Le mouvement de base pour jambes et fessiers.", "smith-machine", ["quadriceps","fessiersischios"]],
      ["Leg Press (presse à cuisses)", "3", "12-15", "Assis, dos calé, tu pousses la plateforme avec les jambes jusqu'à extension sans verrouiller les genoux. Cible quadriceps et fessiers en ménageant le bas du dos.", "leg-press", ["quadriceps","fessiersischios"]],
      ["Fentes bulgares (banc + haltères)", "3", "10-12", "Une jambe surélevée derrière toi sur un banc, tu descends en fente avec des haltères. Cible fessiers et quadriceps avec un bel effet galbant.", "dumbbell", ["quadriceps","fessiersischios"]],
      ["Seated Leg Curl (ischios, machine)", "3", "12-15", "Assis ou allongé, tu fléchis les genoux contre la résistance du rouleau. Cible l'arrière de cuisse pour un galbe harmonieux.", "leg-curl", ["fessiersischios"]],
      ["Abduction de hanche (machine)", "3", "15-20", "Assise dans la machine, tu écartes les cuisses contre une résistance réglable. Cible le côté du fessier pour un galbe bien dessiné.", "leg-extension", ["fessiersischios"]],
      ["Mollets debout (machine ou Smith Machine)", "3", "15-20", "Debout, tu montes sur la pointe des pieds contre une charge légère. Affine et tonifie le mollet.", "smith-machine", ["mollets"]],
    ]
  },
  cardio: {
    title: "Cardio & Abdos",
    exos: [
      ["Tapis de course / Marche rapide", "1", "temps + distance", "Marche rapide ou course sur tapis (ou en extérieur), à intensité modérée et continue. Le principal levier pour affiner la silhouette et révéler les abdominaux.", "treadmill", [], "distance"],
      ["Vélo (spinning / droit ou assis)", "1", "temps + difficulté", "Vélo classique ou avec dossier, résistance réglée selon ta difficulté. Cardio sans impact articulaire, idéal en complément ou en récupération active.", "bike", [], "difficulty"],
      ["Rameur", "1", "temps + difficulté", "Sollicite l'ensemble du corps en un seul mouvement. Règle la résistance de la machine selon ta difficulté du jour.", "bike", [], "difficulty"],
      ["Escaliers (StairMaster / ClimbMill)", "1", "temps + difficulté", "Simulateur d'escaliers, excellent aussi pour les fessiers. Règle le niveau/vitesse de la machine selon ta difficulté du jour.", "stairmaster", [], "difficulty"],
      ["Abdominal Crunch (machine guidée)", "3", "15-20", "Assise dans la machine, tu enroules le buste vers les genoux contre la résistance en contractant les abdominaux. La base pour dessiner le ventre.", "abdominal-crunch", ["abdos"]],
      ["Relevé de jambes suspendu ou au sol", "3", "12-15", "Tu remontes les jambes tendues ou fléchies vers la poitrine. Cible surtout le bas du ventre.", "cable-pulley", ["abdos"]],
      ["Back Extension (machine)", "3", "12-15", "Allongée face contre le support incliné, chevilles calées, tu remontes le buste jusqu'à l'alignement du corps. Renforce le bas du dos et les lombaires.", "back-extension", ["dos"]],
      ["Gainage planche + Mountain climbers", "3", "40s", "En appui sur les avant-bras et les pieds, tu maintiens le corps aligné, puis ramènes rapidement les genoux vers la poitrine en alternance. Raffermit toute la ceinture abdominale et combine avec du cardio.", "bench", ["abdos"]],
    ]
  },
  mobility: {
    title: "Repos actif / Mobilité",
    exos: [
      ["Marche légère (20-30 min)", "1", "20-30 min", "Une marche à allure tranquille sur tapis ou en extérieur pour favoriser la récupération et continuer à brûler des calories sans fatiguer davantage le corps.", "walk", []],
      ["Étirements complets", "1", "10-15 min", "Étire les principaux groupes musculaires sollicités dans la semaine (pecs, dos, jambes) pour préserver la souplesse et réduire les tensions.", "stretch", ["pecs","dos","quadriceps"]],
      ["Mobilité hanches / épaules", "1", "10 min", "Mouvements circulaires et amplitudes contrôlées pour entretenir la mobilité des hanches et des épaules, essentielles pour bien exécuter Hip Thrust, Squat et Chest Press.", "mobility", ["epaules","fessiersischios"]],
      ["Respiration / relâchement", "1", "5 min", "Quelques minutes de respiration profonde et de relâchement musculaire pour faire baisser le stress, le cortisol et améliorer la récupération.", "breathing", []],
    ]
  },
  forearms: {
    title: "Avant-bras",
    exos: [
      ["Curl de poignet (haltères sur banc)", "3", "15-20", "Assise, avant-bras posés sur les cuisses ou un banc, paumes vers le haut, tu fléchis les poignets pour lever les haltères. Cible les fléchisseurs de l'avant-bras.", "dumbbell", ["avantbras"]],
      ["Curl de poignet inversé (haltères sur banc)", "3", "15-20", "Même position, mais paumes vers le bas : tu relèves les poignets vers toi. Cible les extenseurs de l'avant-bras, souvent négligés alors qu'ils équilibrent la poigne.", "dumbbell", ["avantbras"]],
      ["Enroulement de poignet à la poulie basse", "3", "15-20", "Face à la poulie basse, barre tenue en pronation, tu enroules le poignet vers le haut contre la résistance. Version guidée et progressive du curl de poignet.", "cable-pulley", ["avantbras"]],
      ["Portée lourde (Farmer's walk, haltères)", "3", "30-40m", "Un haltère lourd dans chaque main, tu marches sur une distance donnée en gardant le dos droit et les épaules basses. Renforce la force de préhension et l'ensemble de l'avant-bras.", "dumbbell", ["avantbras"]],
    ]
  }
};

const CATEGORY_META = {
  push:      { label: "Poussée",         stat: "force",      page: "corps.html" },
  push2:     { label: "Poussée",         stat: "force",      page: "corps.html" },
  pull:      { label: "Tirage",          stat: "force",      page: "corps.html" },
  pull2:     { label: "Tirage",          stat: "force",      page: "corps.html" },
  legs:      { label: "Jambes",          stat: "force",      page: "corps.html" },
  cardio:    { label: "Cardio & Abdos",  stat: "endurance",  page: "corps.html" },
  mobility:  { label: "Mobilité",        stat: "vitalite",   page: "corps.html" },
  forearms:  { label: "Avant-bras",      stat: "force",      page: "corps.html" },
  corps:     { label: "Entraînement ciblé", stat: "force",   page: "corps.html" },
  libre:     { label: "Séance libre",    stat: "discipline", page: "custom.html" },
  nutrition: { label: "Provisions",      stat: "vitalite",   page: "nutrition.html" },
  suivi:     { label: "Suivi",           stat: "discipline", page: "suivi.html" }
};

const DASHBOARD_CARDS = [
  { key: "corps",      label: "Entraînement",    page: "corps.html",    tag: "Choisis ta zone · toutes les machines" },
  { key: "libre",      label: "Séance libre",    page: "custom.html",    tag: "Improvise ta quête" },
  { key: "nutrition",  label: "Provisions",      page: "nutrition.html", tag: "Nutrition" },
  { key: "suivi",      label: "Suivi",           page: "suivi.html",     tag: "Calculateur · Journal" }
];

const NAV_PAGES = [
  { key: "index",     label: "Tableau",     page: "index.html" },
  { key: "corps",     label: "Entraînement",page: "corps.html" },
  { key: "custom",    label: "Séance libre",page: "custom.html" },
  { key: "nutrition", label: "Provisions",  page: "nutrition.html" },
  { key: "suivi",     label: "Suivi",       page: "suivi.html" }
];

/* Zones sélectionnables sur la page Entraînement : les zones musculaires
   (ZONE_EXERCISES) + deux catégories transversales Cardio et Mobilité qui
   n'ont pas de zone musculaire propre. */
function trainingZoneList(){
  const zones = Object.entries(ZONE_EXERCISES).map(([key, z]) => ({ key, label: z.label }));
  zones.push({ key: "cardio", label: "Cardio" });
  zones.push({ key: "mobility", label: "Mobilité" });
  return zones;
}

function exosForTrainingZone(zoneKey){
  if(zoneKey === "cardio"){
    return PROGRAM.cardio.exos.filter(e => (e[5] || []).length === 0).map(e => ({ ...exoToObj(e), catKey: "cardio" }));
  }
  if(zoneKey === "mobility"){
    return PROGRAM.mobility.exos.map(e => ({ ...exoToObj(e), catKey: "mobility" }));
  }
  const names = ZONE_EXERCISES[zoneKey] ? ZONE_EXERCISES[zoneKey].exos : [];
  return names.map(name => {
    const found = findExerciseByNameGlobal(name);
    return found;
  }).filter(Boolean);
}

function exoToObj(e){
  return { name: e[0], sets: e[1], reps: e[2], desc: e[3], machine: e[4], zones: e[5] || [], metricType: e[6] || null };
}

function findExerciseByNameGlobal(name){
  for(const catKey of Object.keys(PROGRAM)){
    const found = PROGRAM[catKey].exos.find(e => e[0] === name);
    if(found) return { catKey, ...exoToObj(found) };
  }
  return null;
}

/* ---------- État du personnage ---------- */
let state = null;

function defaultState(){
  return {
    level: 1,
    xp: 0,
    stats: { force: 0, endurance: 0, vitalite: 0, discipline: 0 },
    totalSessions: 0,
    streak: 0,
    lastSessionDate: null,
    firstLogDate: null,
    totalXPEarned: 0,
    records: {},
    groceryList: [],
    stock: {},
    supplements: defaultSupplementsState(),
    savedMeals: [],
    coinsGranted: 0,
    coinsConfirmedSent: 0,
    coinsCache: 0,
    dailyLog: defaultDailyLogState(),
    dailyBurn: defaultDailyBurnState(),
    profile: { poids: null, taille: null, age: null, activite: 1.45, deficit: 500, sexe: "femme" },
    weightGoal: { poidsAPerdre: null },
    burnGoal: { kcalPerDay: null },
    log: [],
    updatedAt: new Date().toISOString()
  };
}

async function loadState(){
  try{
    currentUser = await waitForAuthReady();

    const local = await idbGet(STORAGE_KEY);
    let cloud = null;
    if(currentUser){
      cloud = await cloudGet(currentUser.uid);
    }

    let saved = null;
    if(cloud && local){
      // Ni l'un ni l'autre n'est automatiquement prioritaire : on garde la
      // version la plus récente pour éviter qu'une écriture cloud en échec
      // silencieux (ex: juste après une réinitialisation) n'écrase une
      // version locale plus fraîche.
      const cloudTime = cloud.updatedAt ? new Date(cloud.updatedAt).getTime() : 0;
      const localTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
      saved = cloudTime >= localTime ? cloud : local;
    } else if(cloud){
      saved = cloud;
    } else if(local){
      saved = local;
    }

    if(!saved){
      // Migration silencieuse d'une éventuelle ancienne sauvegarde localStorage —
      // totalement transparente pour la personne : sa progression n'est pas perdue.
      const legacyRaw = window.localStorage.getItem(STORAGE_KEY);
      if(legacyRaw){
        try{ saved = JSON.parse(legacyRaw); }catch(e){ saved = null; }
      }
    }

    state = saved || defaultState();
    if(!state.records) state.records = {};
    if(!state.groceryList) state.groceryList = [];
    if(!state.stock) state.stock = {};
    if(!state.supplements) state.supplements = defaultSupplementsState();
    if(!state.savedMeals) state.savedMeals = [];
    if(!state.dailyLog) state.dailyLog = defaultDailyLogState();
    if(!state.dailyBurn) state.dailyBurn = defaultDailyBurnState();
    if(!state.profile) state.profile = { poids: null, taille: null, age: null, activite: 1.45, deficit: 500, sexe: "femme" };
    if(!state.profile.sexe) state.profile.sexe = "femme";
    if(!state.weightGoal) state.weightGoal = { poidsAPerdre: null };
    if(!state.burnGoal) state.burnGoal = { kcalPerDay: null };
    if(state.firstLogDate === undefined) state.firstLogDate = null;
    if(state.totalXPEarned === undefined) state.totalXPEarned = 0;
    if(state.coinsGranted === undefined) state.coinsGranted = 0;
    if(state.coinsConfirmedSent === undefined) state.coinsConfirmedSent = 0;
    if(state.coinsCache === undefined) state.coinsCache = 0;
    if(!state.updatedAt) state.updatedAt = new Date().toISOString();

    // Convertit d'un coup l'XP déjà accumulé en pièces si ce n'est pas déjà fait
    // (première ouverture après l'ajout du système de pièces), puis se resynchronise
    // avec le vrai solde partagé (qui peut avoir baissé si des pièces ont été
    // dépensées depuis "Le Trésor Commun").
    grantCoinsFromXP();
    await refreshCoinsCache();

    // Garde le cache local et le cloud alignés l'un sur l'autre, quelle que
    // soit la source retenue ci-dessus.
    await idbSet(STORAGE_KEY, state);
    if(currentUser) cloudSet(currentUser.uid, state);
  }catch(e){
    state = defaultState();
  }
}

async function saveState(){
  state.updatedAt = new Date().toISOString();
  await idbSet(STORAGE_KEY, state);
  if(currentUser) cloudSet(currentUser.uid, state); // en arrière-plan, transparent pour l'utilisateur
}

function xpNeededFor(level){ return 100 + (level - 1) * 60; }

function rankFor(level){
  if(level >= 20) return "LÉGENDE DU SLASHER";
  if(level >= 15) return "OMBRE SANGLANTE";
  if(level >= 10) return "REINE DU MASSACRE";
  if(level >= 6) return "CHASSEUSE DE FRISSONS";
  if(level >= 3) return "SURVIVANTE — ça commence à saigner";
  return "VICTIME — encore fraîche";
}

function statCap(){ return 100; }

function slugify(str){
  return str.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeCategory(key){ return key.replace(/2$/, ""); }

function statGainsFor(categoryKey){
  const base = normalizeCategory(categoryKey);
  switch(base){
    case "push": return { force: 3, endurance: 1, vitalite: 0, discipline: 1 };
    case "pull": return { force: 3, endurance: 1, vitalite: 0, discipline: 1 };
    case "legs": return { force: 4, endurance: 2, vitalite: 0, discipline: 1 };
    case "cardio": return { force: 0, endurance: 4, vitalite: 1, discipline: 1 };
    case "mobility": return { force: 0, endurance: 1, vitalite: 2, discipline: 1 };
    case "forearms": return { force: 2, endurance: 1, vitalite: 0, discipline: 1 };
    case "nutrition": return { force: 0, endurance: 0, vitalite: 3, discipline: 2 };
    default: return { force: 1, endurance: 1, vitalite: 1, discipline: 1 };
  }
}

function daysBetween(d1, d2){
  const oneDay = 24 * 60 * 60 * 1000;
  const a = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate());
  const b = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate());
  return Math.round((b - a) / oneDay);
}

function updateStreak(){
  const today = new Date();
  if(state.lastSessionDate){
    const last = new Date(state.lastSessionDate);
    const diff = daysBetween(last, today);
    if(diff === 0){ /* déjà loggé aujourd'hui, streak inchangée */ }
    else if(diff === 1){ state.streak += 1; }
    else { state.streak = 1; }
  } else {
    state.streak = 1;
  }
  state.lastSessionDate = today.toISOString();
}

function applyXP(xp){
  if(!state.firstLogDate) state.firstLogDate = new Date().toISOString();
  state.totalXPEarned += xp;
  state.xp += xp;
  let leveledUp = false;
  let needed = xpNeededFor(state.level);
  while(state.xp >= needed){
    state.xp -= needed;
    state.level += 1;
    leveledUp = true;
    needed = xpNeededFor(state.level);
  }
  grantCoinsFromXP();
  return leveledUp;
}

/* ---------- Cardio : XP basé sur le temps + la distance/difficulté ----------
   Utilise une estimation calorique (formule MET standard ACSM) à partir du
   poids réellement enregistré dans le profil — plus tu es rapide/loin/dur,
   plus l'effort (et donc l'XP) grimpe. */
function metForSpeed(speedKmh){
  if(speedKmh <= 4) return 3;
  if(speedKmh <= 6) return 6;
  if(speedKmh <= 8) return 8;
  if(speedKmh <= 10) return 9.8;
  if(speedKmh <= 12) return 11;
  return 12.5;
}

function metForDifficulty(difficulty){
  const d = Math.max(1, Math.min(10, difficulty || 1));
  return 3 + d;
}

function profileWeightKg(){
  return (state.profile && state.profile.poids) ? state.profile.poids : 65;
}

function caloriesFromMET(met, timeMin){
  return met * 3.5 * profileWeightKg() / 200 * (timeMin || 0);
}

// MET approximatifs par catégorie et par intensité ressentie (1=légère, 2=modérée, 3=intense).
function metForTraining(categoryKey, effort){
  const base = normalizeCategory(categoryKey);
  const idx = effort === 3 ? 2 : effort === 2 ? 1 : 0;
  const tables = {
    push: [3.5, 5, 6],
    pull: [3.5, 5, 6],
    legs: [4, 5.5, 7],
    mobility: [2, 2.5, 3],
    libre: [3.5, 5, 6],
  };
  return (tables[base] || tables.libre)[idx];
}

/* ---------- Calories réellement brûlées PAR EXERCICE (musculation) ----------
   Estime le temps réel passé sur l'exercice à partir des séries/répétitions
   effectivement réalisées (≈3.5s par répétition + ≈75s de repos entre séries),
   puis calcule les calories via la formule MET, avec un bonus d'intensité si
   la charge est lourde par rapport à ton poids de corps (charge relative). */
function caloriesForStrengthExercise(categoryKey, weightKg, reps, sets, effort){
  if(!weightKg || !reps) return 0;
  const setsCount = sets || 3;
  const secPerRep = 3.5;
  const restSec = 75;
  const timeMin = (setsCount * reps * secPerRep + Math.max(0, setsCount - 1) * restSec) / 60;

  const baseMet = metForTraining(categoryKey, effort);
  const bodyWeight = profileWeightKg();
  const relativeLoad = bodyWeight > 0 ? weightKg / bodyWeight : 0;
  const loadBonus = Math.min(0.4, relativeLoad * 0.5);
  const met = baseMet * (1 + loadBonus);

  return caloriesFromMET(met, timeMin);
}

/* ---------- Calories brûlées du jour (entraînement) ----------
   Journal séparé du journal des calories consommées, avec la même
   remise à zéro quotidienne automatique. */
function defaultDailyBurnState(){
  return { date: todayStr(), entries: [] };
}

function ensureDailyBurnToday(){
  if(!state.dailyBurn) state.dailyBurn = defaultDailyBurnState();
  if(state.dailyBurn.date !== todayStr()){
    state.dailyBurn = defaultDailyBurnState();
  }
}

function logBurnedCalories(label, kcal){
  ensureDailyBurnToday();
  if(!kcal || kcal <= 0) return;
  state.dailyBurn.entries.push({ label, kcal: Math.round(kcal), time: new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }) });
  saveState();
}

function removeDailyBurnEntry(index){
  ensureDailyBurnToday();
  state.dailyBurn.entries.splice(index, 1);
  saveState();
}

function dailyBurnTotals(){
  ensureDailyBurnToday();
  const kcalTotal = state.dailyBurn.entries.reduce((sum, e) => sum + e.kcal, 0);
  return { entries: state.dailyBurn.entries, kcalTotal };
}

function cardioDistanceXP(timeMin, distanceKm){
  timeMin = Math.max(0, timeMin || 0);
  distanceKm = Math.max(0, distanceKm || 0);
  const speedKmh = timeMin > 0 ? distanceKm / (timeMin / 60) : 0;
  const kcal = caloriesFromMET(metForSpeed(speedKmh), timeMin);
  return Math.max(0, Math.round(kcal / 3.5));
}

function cardioDifficultyXP(timeMin, difficulty){
  timeMin = Math.max(0, timeMin || 0);
  const kcal = caloriesFromMET(metForDifficulty(difficulty), timeMin);
  return Math.max(0, Math.round(kcal / 3.5));
}

/* ---------- Log générique d'une quête d'exercices ---------- */
// exerciseEntries: [{ slug, name, weight (kg|null), reps (int|null), done (bool) }]
function logCategorySession(categoryKey, exerciseEntries, effort, durationMin){
  const total = exerciseEntries.length;
  const doneCount = exerciseEntries.filter(e => e.done).length;
  const completionRatio = total ? doneCount / total : 0;
  const meta = CATEGORY_META[categoryKey];

  let prCount = 0;
  let cardioBonusXP = 0;
  let burnedKcal = 0;
  exerciseEntries.forEach(e => {
    if(!e.done) return;
    if(e.metricType === "distance"){
      if(!e.time || !e.distance) return;
      const speedKmh = e.time > 0 ? e.distance / (e.time / 60) : 0;
      burnedKcal += caloriesFromMET(metForSpeed(speedKmh), e.time);
      cardioBonusXP += cardioDistanceXP(e.time, e.distance);
      const rec = state.records[e.slug];
      if(!rec || e.distance > rec.distance){
        state.records[e.slug] = { name: e.name, distance: e.distance, time: e.time, date: new Date().toISOString() };
        prCount++;
      }
    } else if(e.metricType === "difficulty"){
      if(!e.time || !e.difficulty) return;
      burnedKcal += caloriesFromMET(metForDifficulty(e.difficulty), e.time);
      cardioBonusXP += cardioDifficultyXP(e.time, e.difficulty);
      const rec = state.records[e.slug];
      const score = e.time * e.difficulty;
      if(!rec || score > (rec.time * rec.difficulty)){
        state.records[e.slug] = { name: e.name, time: e.time, difficulty: e.difficulty, date: new Date().toISOString() };
        prCount++;
      }
    } else {
      if(e.weight && e.reps){
        burnedKcal += caloriesForStrengthExercise(categoryKey, e.weight, e.reps, e.sets, effort);
      }
      if(!e.weight) return;
      const rec = state.records[e.slug];
      if(!rec || e.weight > rec.weight){
        state.records[e.slug] = { name: e.name, weight: e.weight, reps: e.reps || null, date: new Date().toISOString() };
        prCount++;
      }
    }
  });

  // Mobilité : pas de poids/reps significatifs, on estime sur la durée globale de la séance si fournie.
  if(normalizeCategory(categoryKey) === "mobility" && durationMin){
    burnedKcal += caloriesFromMET(metForTraining(categoryKey, effort), durationMin);
  }
  if(burnedKcal > 0){
    logBurnedCalories(`${meta.label} — ${doneCount}/${total} exercices`, burnedKcal);
  }

  const baseXP = 20;
  const complMult = completionRatio >= 0.9 ? 1.5 : completionRatio >= 0.5 ? 1.15 : 0.7;
  const effortMult = effort === 3 ? 1.3 : effort === 2 ? 1.1 : 1;
  const xpGain = Math.round(baseXP * complMult * effortMult) + prCount * 8 + cardioBonusXP;

  const gains = statGainsFor(categoryKey);
  Object.keys(gains).forEach(k => {
    state.stats[k] = Math.min(statCap(), state.stats[k] + Math.round(gains[k] * complMult));
  });
  if(prCount > 0){
    state.stats.force = Math.min(statCap(), state.stats.force + prCount * 2);
  }

  updateStreak();
  const leveledUp = applyXP(xpGain);
  state.totalSessions += 1;

  const prNote = prCount > 0 ? ` · ${prCount} nouveau${prCount>1?"x":""} record${prCount>1?"s":""} !` : "";
  state.log.push({
    category: categoryKey,
    label: `${meta.label} — ${doneCount}/${total} exercices${prNote}`,
    date: new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'short', year:'numeric' }),
    xp: xpGain
  });

  saveState();
  return { xpGain, prCount, leveledUp, doneCount, total, burnedKcal: Math.round(burnedKcal) };
}

/* Quête d'entraînement composée depuis la page Corps (sélection de zone(s)) :
   les exercices peuvent venir de catégories différentes (ex: Épaules + Dos),
   chacun garde sa propre catégorie d'origine pour les PR et les gains de stats. */
function logZoneWorkout(exerciseEntries, effort, durationMin, zoneLabel){
  const total = exerciseEntries.length;
  const doneEntries = exerciseEntries.filter(e => e.done);
  const doneCount = doneEntries.length;
  const completionRatio = total ? doneCount / total : 0;

  let prCount = 0;
  let cardioBonusXP = 0;
  let burnedKcal = 0;
  const categoryCounts = {};

  doneEntries.forEach(e => {
    categoryCounts[e.catKey] = (categoryCounts[e.catKey] || 0) + 1;
    const slug = e.catKey + "__" + slugify(e.name);

    if(e.metricType === "distance"){
      if(!e.time || !e.distance) return;
      const speedKmh = e.time > 0 ? e.distance / (e.time / 60) : 0;
      burnedKcal += caloriesFromMET(metForSpeed(speedKmh), e.time);
      cardioBonusXP += cardioDistanceXP(e.time, e.distance);
      const rec = state.records[slug];
      if(!rec || e.distance > rec.distance){
        state.records[slug] = { name: e.name, distance: e.distance, time: e.time, date: new Date().toISOString() };
        prCount++;
      }
    } else if(e.metricType === "difficulty"){
      if(!e.time || !e.difficulty) return;
      burnedKcal += caloriesFromMET(metForDifficulty(e.difficulty), e.time);
      cardioBonusXP += cardioDifficultyXP(e.time, e.difficulty);
      const rec = state.records[slug];
      const score = e.time * e.difficulty;
      if(!rec || score > (rec.time * rec.difficulty)){
        state.records[slug] = { name: e.name, time: e.time, difficulty: e.difficulty, date: new Date().toISOString() };
        prCount++;
      }
    } else {
      if(e.weight && e.reps){
        burnedKcal += caloriesForStrengthExercise(e.catKey, e.weight, e.reps, e.sets, effort);
      }
      if(!e.weight) return;
      const rec = state.records[slug];
      if(!rec || e.weight > rec.weight){
        state.records[slug] = { name: e.name, weight: e.weight, reps: e.reps || null, date: new Date().toISOString() };
        prCount++;
      }
    }
  });

  // Mobilité : pas de poids/reps significatifs, on estime sur la durée globale si fournie.
  const hasMobilityNoMetric = doneEntries.some(e => normalizeCategory(e.catKey) === "mobility" && !e.weight && !e.time);
  if(hasMobilityNoMetric && durationMin){
    burnedKcal += caloriesFromMET(metForTraining("mobility", effort), durationMin);
  }
  if(burnedKcal > 0){
    logBurnedCalories(`Entraînement ciblé — ${zoneLabel} (${doneCount}/${total})`, burnedKcal);
  }

  const baseXP = 20;
  const complMult = completionRatio >= 0.9 ? 1.5 : completionRatio >= 0.5 ? 1.15 : 0.7;
  const effortMult = effort === 3 ? 1.3 : effort === 2 ? 1.1 : 1;
  const xpGain = Math.round(baseXP * complMult * effortMult) + prCount * 8 + cardioBonusXP;

  if(doneCount > 0){
    Object.keys(categoryCounts).forEach(catKey => {
      const weight = categoryCounts[catKey] / doneCount;
      const gains = statGainsFor(catKey);
      Object.keys(gains).forEach(k => {
        state.stats[k] = Math.min(statCap(), state.stats[k] + Math.round(gains[k] * weight * complMult));
      });
    });
  }
  if(prCount > 0){
    state.stats.force = Math.min(statCap(), state.stats.force + prCount * 2);
  }

  updateStreak();
  const leveledUp = applyXP(xpGain);
  state.totalSessions += 1;

  const prNote = prCount > 0 ? ` · ${prCount} nouveau${prCount>1?"x":""} record${prCount>1?"s":""} !` : "";
  state.log.push({
    category: "corps",
    label: `Entraînement ciblé — ${zoneLabel} (${doneCount}/${total})${prNote}`,
    date: new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'short', year:'numeric' }),
    xp: xpGain
  });

  saveState();
  return { xpGain, prCount, leveledUp, doneCount, total, burnedKcal: Math.round(burnedKcal) };
}

// Journée nutrition / check-in simple (pas d'exercices)
function logNutritionDay(objectifRespecte, proteinesRespectees, eauLitres){
  const checks = [objectifRespecte, proteinesRespectees].filter(Boolean).length;
  const completionRatio = checks / 2;
  const complMult = completionRatio >= 1 ? 1.5 : completionRatio >= 0.5 ? 1.15 : 0.7;

  const gains = statGainsFor("nutrition");
  Object.keys(gains).forEach(k => {
    state.stats[k] = Math.min(statCap(), state.stats[k] + Math.round(gains[k] * complMult));
  });
  if(eauLitres >= 1.5){
    state.stats.vitalite = Math.min(statCap(), state.stats.vitalite + 1);
  }

  const baseXP = 18;
  const xpGain = Math.round(baseXP * complMult);

  updateStreak();
  const leveledUp = applyXP(xpGain);
  state.totalSessions += 1;

  state.log.push({
    category: "nutrition",
    label: `Provisions — ${checks}/2 objectifs, ${eauLitres}L d'eau`,
    date: new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'short', year:'numeric' }),
    xp: xpGain
  });

  saveState();
  return { xpGain, leveledUp };
}

function saveProfile(poids, taille, age, activite, deficit, sexe){
  state.profile = { poids, taille, age, activite, deficit, sexe: sexe || (state.profile && state.profile.sexe) || "femme" };
  saveState();
}

/* Calcule les objectifs (TDEE, protéines, etc.) à partir du profil sauvegardé,
   sans passer par l'UI du calculateur — utilisé par les pages qui ont besoin
   de ces chiffres (ex: le générateur de repas) mais n'affichent pas la page Suivi. */
function computeObjectifs(){
  const p = state.profile;
  if(!p || !p.poids || !p.taille || !p.age) return null;
  const activite = p.activite || 1.45;
  const deficit = p.deficit !== undefined && p.deficit !== null ? p.deficit : 500;
  const bmr = p.sexe === "homme"
    ? 10*p.poids + 6.25*p.taille - 5*p.age + 5
    : 10*p.poids + 6.25*p.taille - 5*p.age - 161;
  const tdee = bmr * activite;
  const objectifCalorique = tdee - deficit;
  const proteinMult = deficit >= 750 ? 2.2 : deficit >= 500 ? 2.0 : deficit >= 300 ? 1.85 : deficit <= 0 ? 1.6 : 1.9;
  const proteines = Math.round(p.poids * proteinMult);
  const lipidesBas = Math.round(p.poids * 0.8);
  const lipidesHaut = Math.round(p.poids * 1);
  const eauL = (p.poids * 0.035).toFixed(1);
  return { tdee, objectifCalorique, proteines, lipidesBas, lipidesHaut, eauL, deficit };
}

function saveWeightGoal(poidsAPerdre){
  state.weightGoal = { poidsAPerdre };
  saveState();
}

function resetWeightGoal(){
  state.weightGoal = { poidsAPerdre: null };
  saveState();
}

function saveBurnGoal(kcalPerDay){
  state.burnGoal = { kcalPerDay };
  saveState();
}

function resetBurnGoal(){
  state.burnGoal = { kcalPerDay: null };
  saveState();
}

/* =========================================================
   SÉANCE LIBRE — l'utilisateur renseigne ce qu'il a fait,
   on reconnaît les exercices connus (Chest Press, Squat...)
   et on évalue la séance (zones travaillées, XP, records).
   ========================================================= */

function buildExerciseIndex(){
  const idx = {};
  Object.keys(PROGRAM).forEach(catKey => {
    const cat = normalizeCategory(catKey);
    PROGRAM[catKey].exos.forEach(exo => {
      const [name, sets, reps, desc, machine, zones] = exo;
      idx[name.toLowerCase()] = { name, category: cat, zones: zones || [], machine: machine || null };
    });
  });
  return idx;
}
const EXERCISE_INDEX = buildExerciseIndex();

function allExerciseNames(){
  return Object.values(EXERCISE_INDEX).map(e => e.name);
}

function findExerciseMatch(inputName){
  if(!inputName) return null;
  const key = inputName.trim().toLowerCase();
  if(!key) return null;
  if(EXERCISE_INDEX[key]) return EXERCISE_INDEX[key];
  let found = null;
  Object.keys(EXERCISE_INDEX).forEach(k => {
    if(found) return;
    if(k.includes(key) || key.includes(k)) found = EXERCISE_INDEX[k];
  });
  return found;
}

function evaluateCustomSession(rows, effort, durationMin){
  const cleanRows = (rows || []).filter(r => r.name && r.name.trim());
  const total = cleanRows.length;
  const zoneCounts = {};
  const categoryCounts = {};
  const unmatched = [];
  let prCount = 0;

  let burnedKcal = 0;
  let anyWeighted = false;
  const burnedPerExercise = [];
  cleanRows.forEach(r => {
    const match = findExerciseMatch(r.name);
    const cat = match ? match.category : "libre";
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    (match ? match.zones : []).forEach(z => { zoneCounts[z] = (zoneCounts[z] || 0) + 1; });
    if(!match) unmatched.push(r.name.trim());

    if(r.weight){
      const slug = match ? (match.category + "__" + slugify(match.name)) : ("libre__" + slugify(r.name.trim()));
      const rec = state.records[slug];
      if(!rec || r.weight > rec.weight){
        state.records[slug] = { name: match ? match.name : r.name.trim(), weight: r.weight, reps: r.reps || null, date: new Date().toISOString() };
        prCount++;
      }
    }
    if(r.weight && r.reps){
      anyWeighted = true;
      const exoKcal = caloriesForStrengthExercise(cat, r.weight, r.reps, r.sets || 3, effort);
      burnedKcal += exoKcal;
      burnedPerExercise.push({ name: r.name.trim(), kcal: Math.round(exoKcal) });
    }
  });

  const effortMult = effort === 3 ? 1.3 : effort === 2 ? 1.1 : 1;

  if(total > 0){
    Object.keys(categoryCounts).forEach(cat => {
      const weight = categoryCounts[cat] / total;
      const gains = cat === "libre" ? { force:1, endurance:1, vitalite:1, discipline:1 } : statGainsFor(cat);
      Object.keys(gains).forEach(k => {
        state.stats[k] = Math.min(statCap(), state.stats[k] + Math.round(gains[k] * weight * effortMult));
      });
    });
  }
  if(prCount > 0){
    state.stats.force = Math.min(statCap(), state.stats.force + prCount * 2);
  }

  if(!anyWeighted && durationMin){
    burnedKcal = caloriesFromMET(metForTraining("libre", effort), durationMin);
  }
  if(burnedKcal > 0){
    logBurnedCalories(`Séance libre — ${total} exercice${total>1?"s":""}`, burnedKcal);
  }

  updateStreak();
  const baseXP = 12 * total;
  const xpGain = Math.round(baseXP * effortMult) + prCount * 8;
  const leveledUp = applyXP(xpGain);
  state.totalSessions += 1;

  const sortedZones = Object.keys(zoneCounts).sort((a,b) => zoneCounts[b] - zoneCounts[a]);
  const zoneLabel = sortedZones.map(z => ZONE_EXERCISES[z] ? ZONE_EXERCISES[z].label : z).join(", ") || "aucune zone reconnue";

  state.log.push({
    category: "libre",
    label: `Séance libre — ${total} exercice${total>1?"s":""} (${zoneLabel})`,
    date: new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'short', year:'numeric' }),
    xp: xpGain
  });

  saveState();
  const dl = dailyLogTotals();
  const consumedToday = dl.kcalTotal + supplementsTotals().caloriesTotal;

  return {
    xpGain, prCount, leveledUp, total, zoneCounts, categoryCounts, unmatched, zoneLabel,
    burnedKcal: Math.round(burnedKcal), burnedPerExercise, consumedToday
  };
}

function renderCustomResultSummary(elId, result){
  const el = document.getElementById(elId);
  const zoneKeys = Object.keys(result.zoneCounts);
  const perExoHtml = result.burnedPerExercise && result.burnedPerExercise.length
    ? `<div class="calo-breakdown">
        <div class="cb-title">Calories brûlées par exercice</div>
        ${result.burnedPerExercise.map(e => `<div class="cb-row"><span>${e.name}</span><b>${e.kcal} kcal</b></div>`).join("")}
      </div>`
    : "";
  el.innerHTML = `
    <div class="exo-head" style="margin-bottom:6px;">
      <div class="exo-pr" style="font-size:15px;">+${result.xpGain} XP${result.prCount ? " · "+result.prCount+" record(s) !" : ""}${result.burnedKcal > 0 ? " · ~"+result.burnedKcal+" kcal brûlées" : ""}</div>
      <div class="exo-target">${result.total} exercice${result.total>1?"s":""} évalué${result.total>1?"s":""}</div>
    </div>
    <div class="bodymap-wrap" id="custom-bodymap" style="max-width:280px; margin:14px auto;"></div>
    <div class="exo-desc">Zones travaillées : ${result.zoneLabel}</div>
    ${perExoHtml}
    <div class="meal-totals" style="margin-top:14px;">
      <span>Calories brûlées (cette séance)</span> <b>${result.burnedKcal} kcal</b>
      <span>·</span>
      <span>Calories consommées aujourd'hui</span> <b>${result.consumedToday} kcal</b>
    </div>
    ${result.unmatched.length ? `<div class="exo-desc" style="color:var(--parchment-dim);">Exercices non reconnus (comptés comme "libres", gains génériques) : ${result.unmatched.join(", ")}</div>` : ""}
  `;
  document.getElementById("custom-bodymap").innerHTML = bodyMapSVG();
  highlightBodyZones("custom-bodymap", zoneKeys);
}

async function resetCharacter(){
  if(confirm("Effacer toute la progression de ce personnage ? Cette action est irréversible.")){
    state = defaultState();
    await saveState();
    location.reload();
  }
}

/* ---------- Rendu : nav + mini-barre de personnage ---------- */
function renderNav(activeKey){
  const links = NAV_PAGES.map(p =>
    `<a href="${p.page}" class="${p.key === activeKey ? 'active' : ''}">${p.label}</a>`
  ).join("");

  let accountHtml;
  if(!isCloudConfigured()){
    accountHtml = `<div class="account-chip" title="Configure assets/firebase-config.js pour activer la synchronisation">Local uniquement</div>`;
  } else if(currentUser){
    const name = currentUser.displayName || currentUser.email || "Survivante connectée";
    accountHtml = `
      <div class="account-chip" title="Synchronisé en ligne avec ce compte">
        <span class="account-code">${name}</span>
        <button class="chip-btn" onclick="signOutUser()">Déconnexion</button>
      </div>`;
  } else {
    accountHtml = `
      <div class="account-chip" title="Connecte-toi pour synchroniser ta progression sur tous tes appareils">
        <button class="chip-btn" onclick="signInWithGoogle()">Google</button>
        <button class="chip-btn" onclick="signInWithMicrosoft()">Microsoft</button>
      </div>`;
  }

  const activeIsCorps = activeKey === "corps";

  return `
    <div class="topnav">
      <div class="topnav-inner">
        <a class="brand" href="index.html">🔪 SCREAM GYM</a>
        <div class="navlinks">${links}</div>
        ${accountHtml}
      </div>
    </div>

    <div class="mobile-topbar">
      <a class="brand" href="index.html">🔪 SCREAM GYM</a>
      <button class="mobile-menu-btn" onclick="toggleMobileDrawer()">☰</button>
    </div>

    <div class="mobile-drawer-overlay" id="mobile-drawer-overlay" onclick="closeMobileDrawer()"></div>
    <div class="mobile-drawer" id="mobile-drawer">
      <button class="mobile-drawer-close" onclick="closeMobileDrawer()">✕ Fermer</button>
      <div class="mobile-drawer-links">${links}</div>
      <div class="mobile-drawer-account">${accountHtml}</div>
    </div>

    <div class="bottom-tabbar">
      <a class="tab-item ${activeKey === 'index' ? 'active' : ''}" href="index.html"><span class="tab-icon">🏠</span><span>Tableau</span></a>
      <a class="tab-item ${activeIsCorps ? 'active' : ''}" href="corps.html"><span class="tab-icon">💪</span><span>Entraîner</span></a>
      <a class="tab-item ${activeKey === 'custom' ? 'active' : ''}" href="custom.html"><span class="tab-icon">🔪</span><span>Libre</span></a>
      <a class="tab-item ${activeKey === 'nutrition' ? 'active' : ''}" href="nutrition.html"><span class="tab-icon">🍽</span><span>Repas</span></a>
      <a class="tab-item ${activeKey === 'suivi' ? 'active' : ''}" href="suivi.html"><span class="tab-icon">📊</span><span>Suivi</span></a>
    </div>
  `;
}

function toggleMobileDrawer(){
  const drawer = document.getElementById("mobile-drawer");
  const overlay = document.getElementById("mobile-drawer-overlay");
  if(!drawer || !overlay) return;
  const opening = !drawer.classList.contains("open");
  drawer.classList.toggle("open", opening);
  overlay.classList.toggle("open", opening);
}

function closeMobileDrawer(){
  const drawer = document.getElementById("mobile-drawer");
  const overlay = document.getElementById("mobile-drawer-overlay");
  if(!drawer || !overlay) return;
  drawer.classList.remove("open");
  overlay.classList.remove("open");
}

function coinIconSVG(size){
  size = size || 20;
  return `<svg viewBox="0 0 40 40" width="${size}" height="${size}" style="vertical-align:-4px;">
    <circle cx="20" cy="20" r="18" fill="var(--gold)" stroke="var(--gold-bright)" stroke-width="2"/>
    <circle cx="20" cy="20" r="13" fill="none" stroke="var(--gold-bright)" stroke-width="1.4" stroke-dasharray="2.4 2.2"/>
    <text x="20" y="26" text-anchor="middle" font-family="var(--font-display)" font-size="17" font-weight="700" fill="var(--void)">S</text>
  </svg>`;
}

function renderMiniBar(){
  const needed = xpNeededFor(state.level);
  const pct = Math.min(100, Math.round((state.xp / needed) * 100));
  const syncLabel = {
    ok: '<span style="color:var(--green,#6fb890);">● pièces synchronisées</span>',
    error: '<span style="color:var(--blood);" title="Erreur Firestore — voir la console (F12)">⚠ erreur d\'envoi des pièces</span>',
    offline: '<span style="color:var(--parchment-dim);" title="Firebase non connecté — vérifie assets/firebase-config.js">○ pièces non connectées</span>',
    unknown: ''
  }[lastCoinSyncStatus] || '';
  return `
    <div class="minibar">
      <div>
        <div class="mb-rank">${rankFor(state.level)}</div>
        <div class="mb-name">Niveau ${state.level}</div>
      </div>
      <div class="mb-xpwrap">
        <div class="mb-xptrack"><div class="mb-xpfill" style="width:${pct}%"></div></div>
        <div class="mb-xplabel"><span>${state.xp} XP</span><span>${needed} XP pour le niveau suivant</span></div>
      </div>
      <div class="mb-coins" title="1 pièce tous les 300 XP — à dépenser sur Le Trésor Commun">
        ${coinIconSVG(22)} <b>${state.coinsCache || 0}</b>
        ${syncLabel ? `<span style="font-family:var(--font-mono); font-size:10px; margin-left:6px;">${syncLabel}</span>` : ""}
      </div>
      <div class="mb-streak">Séquence : <b>${state.streak}${state.streak===1?" jour":" jours"}</b></div>
    </div>
  `;
}

async function initPage(activeKey){
  await loadState();
  const navEl = document.getElementById("nav-container");
  if(navEl) navEl.innerHTML = renderNav(activeKey);
  const barEl = document.getElementById("minibar-container");
  if(barEl) barEl.innerHTML = renderMiniBar();
  injectToast();
}

function injectToast(){
  if(document.getElementById("levelup-toast")) return;
  const div = document.createElement("div");
  div.id = "levelup-toast";
  div.textContent = "⚔ Niveau supérieur !";
  document.body.appendChild(div);
}

function showLevelUpToast(){
  const toast = document.getElementById("levelup-toast");
  toast.textContent = `⚔ Niveau supérieur ! Tu es maintenant ${rankFor(state.level)} — Niveau ${state.level}`;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3400);
}

function showSimpleToast(msg){
  const toast = document.getElementById("levelup-toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

/* ---------- Aide pour construire une table d'exercices avec inputs ---------- */
function buildExerciseInputs(containerId, categoryKey){
  const container = document.getElementById(containerId);
  const program = PROGRAM[categoryKey];
  container.innerHTML = program.exos.map(([name, sets, reps, desc, machine, zones, metricType]) => {
    const slug = categoryKey + "__" + slugify(name);
    const rec = state.records[slug];
    const prText = metricType === "distance"
      ? (rec ? `Record : ${rec.distance}km en ${rec.time}min` : "Pas encore de record")
      : metricType === "difficulty"
        ? (rec ? `Record : ${rec.time}min à difficulté ${rec.difficulty}` : "Pas encore de record")
        : (rec ? `Record : ${rec.weight}kg${rec.reps ? ' x '+rec.reps : ''}` : "Pas encore de record");
    const zoneLabels = (zones || []).map(z => ZONE_EXERCISES[z] ? ZONE_EXERCISES[z].label : z).join(" · ");
    const mediaHtml = (machine || (zones && zones.length)) ? `
      <div class="exo-media">
        ${machine ? `
          <div class="exo-icon-wrap">
            <div class="exo-icon" title="${machineLabel(machine)}">${machineIconSVG(machine)}</div>
            <div class="exo-icon-label">${machineLabel(machine)}</div>
          </div>` : ""}
        ${zones && zones.length ? `
          <div class="exo-zonemap" title="Zone travaillée : ${zoneLabels}">
            ${zoneThumbSVG(zones)}
            <span>Zone travaillée :<br>${zoneLabels}</span>
          </div>` : ""}
      </div>` : "";

    let inputsHtml;
    if(metricType === "distance"){
      inputsHtml = `
        <div class="field">
          <label>Temps (min)</label>
          <input type="number" min="0" step="1" class="exo-time" placeholder="ex: 30">
        </div>
        <div class="field">
          <label>Distance (km)</label>
          <input type="number" min="0" step="0.1" class="exo-distance" placeholder="ex: 5">
        </div>
        <div class="exo-done">
          <input type="checkbox" class="exo-check" id="chk-${slug}">
          <label for="chk-${slug}">Faite</label>
        </div>`;
    } else if(metricType === "difficulty"){
      inputsHtml = `
        <div class="field">
          <label>Temps (min)</label>
          <input type="number" min="0" step="1" class="exo-time" placeholder="ex: 20">
        </div>
        <div class="field">
          <label>Difficulté (1-10)</label>
          <input type="number" min="1" max="10" step="1" class="exo-difficulty" placeholder="ex: 6">
        </div>
        <div class="exo-done">
          <input type="checkbox" class="exo-check" id="chk-${slug}">
          <label for="chk-${slug}">Faite</label>
        </div>`;
    } else {
      inputsHtml = `
        <div class="field">
          <label>Poids (kg)</label>
          <input type="number" min="0" step="0.5" class="exo-weight" placeholder="ex: 40">
        </div>
        <div class="field">
          <label>Reps réalisées</label>
          <input type="number" min="0" step="1" class="exo-reps" placeholder="ex: 10">
        </div>
        <div class="exo-done">
          <input type="checkbox" class="exo-check" id="chk-${slug}">
          <label for="chk-${slug}">Faite</label>
        </div>`;
    }

    return `
      <div class="exo-card" data-slug="${slug}">
        <div class="exo-head">
          <div>
            <div class="exo-name">${name}</div>
            <div class="exo-target">Objectif : ${sets} séries x ${reps}</div>
            ${desc ? `<div class="exo-desc">${desc}</div>` : ""}
          </div>
          <div class="exo-pr">${prText}</div>
        </div>
        ${mediaHtml}
        <div class="exo-inputs">
          ${inputsHtml}
        </div>
      </div>
    `;
  }).join("");
}

function collectExerciseEntries(containerId, categoryKey){
  const program = PROGRAM[categoryKey];
  const cards = document.querySelectorAll(`#${containerId} .exo-card`);
  const entries = [];
  cards.forEach((card, i) => {
    const [name, , , , , , metricType] = program.exos[i];
    const slug = card.getAttribute("data-slug");
    const done = card.querySelector(".exo-check").checked;
    if(metricType === "distance"){
      const time = parseFloat(card.querySelector(".exo-time").value) || null;
      const distance = parseFloat(card.querySelector(".exo-distance").value) || null;
      entries.push({ slug, name, metricType, time, distance, done });
    } else if(metricType === "difficulty"){
      const time = parseFloat(card.querySelector(".exo-time").value) || null;
      const difficulty = parseFloat(card.querySelector(".exo-difficulty").value) || null;
      entries.push({ slug, name, metricType, time, difficulty, done });
    } else {
      const weight = parseFloat(card.querySelector(".exo-weight").value) || null;
      const reps = parseInt(card.querySelector(".exo-reps").value, 10) || null;
      const sets = parseInt(program.exos[i][1], 10) || 3;
      entries.push({ slug, name, weight, reps, sets, done });
    }
  });
  return entries;
}

/* ---------- Rendu complet (tableau de bord) ---------- */
function renderFullSheet(elId){
  const el = document.getElementById(elId);
  const needed = xpNeededFor(state.level);
  const pct = Math.min(100, Math.round((state.xp / needed) * 100));
  el.innerHTML = `
    <div class="sheet-top">
      <div class="title-block">
        <div class="rank">${rankFor(state.level)}</div>
        <div class="name">Ton personnage</div>
      </div>
      <div class="level-badge">NIVEAU ${state.level}</div>
    </div>
    <div class="xp-track"><div class="xp-fill" style="width:${pct}%"></div></div>
    <div class="xp-label"><span>${state.xp} XP</span><span>${needed} XP pour le niveau suivant</span></div>
    <div class="stat-grid">
      ${["force","endurance","vitalite","discipline"].map(k => `
        <div class="stat" data-k="${k}">
          <div class="stat-name">${k.charAt(0).toUpperCase()+k.slice(1)} <b>${state.stats[k]}</b></div>
          <div class="stat-bar"><i style="width:${Math.min(100,(state.stats[k]/statCap())*100)}%"></i></div>
        </div>
      `).join("")}
    </div>
    <div class="streak-row">
      <span>Séquence actuelle : <b>${state.streak}${state.streak===1?" jour":" jours"}</b></span>
      <span>Quêtes accomplies : <b>${state.totalSessions}</b></span>
    </div>
  `;
}

function lastLogDateForCategories(keys){
  const entries = state.log.filter(e => keys.includes(e.category));
  if(entries.length === 0) return null;
  return entries[entries.length - 1].date;
}

function renderDashboardCards(elId){
  const el = document.getElementById(elId);
  el.innerHTML = DASHBOARD_CARDS.map(card => {
    const keys = card.key === "push" ? ["push","push2"] : card.key === "pull" ? ["pull","pull2"] : [card.key];
    const lastDate = lastLogDateForCategories(keys);
    const statKey = CATEGORY_META[card.key].stat;
    const statVal = state.stats[statKey];
    return `
      <a class="cat-card" href="${card.page}">
        <div class="cc-top">
          <div class="cc-label">${card.label}</div>
          <div class="cc-arrow">→</div>
        </div>
        <div class="exo-target" style="margin-top:2px;">${card.tag}</div>
        <div class="cc-last">${lastDate ? "Dernière quête : " + lastDate : "Pas encore tentée"}</div>
        <div class="cc-bar"><i style="width:${Math.min(100,(statVal/statCap())*100)}%"></i></div>
      </a>
    `;
  }).join("");
}

function renderChronicle(elId){
  const el = document.getElementById(elId);
  if(state.log.length === 0){
    el.innerHTML = '<div class="empty-note">Aucune quête gravée pour l\'instant. Pars à l\'aventure depuis le tableau de bord.</div>';
    return;
  }
  const startIndex = Math.max(0, state.log.length - 50);
  el.innerHTML = state.log.slice(startIndex).map((entry, i) => {
    const realIndex = startIndex + i;
    return `
    <div class="chronicle-entry">
      <div class="c-left">${entry.label}<span class="c-date">${entry.date}</span></div>
      <div class="c-xp">+${entry.xp} XP</div>
      <button class="c-delete" title="Supprimer cette quête de la chronique" onclick="deleteLogEntry(${realIndex}, '${elId}')">✕</button>
    </div>
  `;
  }).join("");
}

function deleteLogEntry(index, elId){
  if(!confirm("Supprimer cette quête de la chronique ? L'XP et les stats déjà gagnées restent acquises — seule l'entrée d'historique disparaît.")) return;
  state.log.splice(index, 1);
  saveState();
  renderChronicle(elId);
}

/* =========================================================
   MENUS HEBDOMADAIRES, LISTE DE COURSES, FRINGALES
   ========================================================= */

const INGREDIENT_INFO = {
  "flocons d'avoine": { cat: "Épicerie" },
  "skyr": { cat: "Produits laitiers", alt: "fromage blanc 0% ou yaourt grec nature" },
  "myrtilles": { cat: "Fruits & légumes", alt: "fruits rouges surgelés" },
  "amandes": { cat: "Épicerie", alt: "noix ou noisettes" },
  "cannelle": { cat: "Épicerie" },
  "oeufs": { cat: "Produits laitiers" },
  "pain complet": { cat: "Épicerie", alt: "pain aux céréales" },
  "avocat": { cat: "Fruits & légumes" },
  "tomates cerises": { cat: "Fruits & légumes" },
  "whey ou lait": { cat: "Produits laitiers", alt: "lait demi-écrémé ou boisson végétale enrichie" },
  "banane": { cat: "Fruits & légumes" },
  "cacao non sucré": { cat: "Épicerie" },
  "champignons": { cat: "Fruits & légumes" },
  "fromage frais léger": { cat: "Produits laitiers", alt: "cottage cheese" },
  "ciboulette": { cat: "Fruits & légumes" },
  "yaourt grec": { cat: "Produits laitiers", alt: "skyr" },
  "granola": { cat: "Épicerie", alt: "flocons d'avoine grillés au four" },
  "fruits rouges": { cat: "Fruits & légumes", alt: "surgelés hors saison" },
  "miel": { cat: "Épicerie" },
  "fromage blanc": { cat: "Produits laitiers", alt: "skyr ou yaourt grec" },
  "concombre": { cat: "Fruits & légumes" },
  "poulet": { cat: "Protéines", alt: "dinde" },
  "riz complet": { cat: "Épicerie", alt: "riz basmati ou quinoa" },
  "brocolis": { cat: "Fruits & légumes", alt: "haricots verts" },
  "saumon": { cat: "Protéines", alt: "truite" },
  "patate douce": { cat: "Fruits & légumes", alt: "pomme de terre ou riz complet" },
  "épinards": { cat: "Fruits & légumes", alt: "épinards surgelés" },
  "citron": { cat: "Fruits & légumes" },
  "boeuf haché 5%": { cat: "Protéines", alt: "dinde hachée" },
  "quinoa": { cat: "Épicerie", alt: "boulgour ou riz complet" },
  "poivrons": { cat: "Fruits & légumes" },
  "oignon": { cat: "Fruits & légumes" },
  "dinde": { cat: "Protéines", alt: "poulet" },
  "pâtes complètes": { cat: "Épicerie", alt: "pâtes semi-complètes" },
  "courgettes": { cat: "Fruits & légumes" },
  "ail": { cat: "Fruits & légumes" },
  "tofu": { cat: "Protéines", alt: "seitan ou blanc de poulet" },
  "riz basmati": { cat: "Épicerie", alt: "riz complet" },
  "carottes": { cat: "Fruits & légumes" },
  "sauce soja": { cat: "Épicerie" },
  "cabillaud": { cat: "Protéines", alt: "colin ou lieu noir" },
  "semoule complète": { cat: "Épicerie", alt: "boulgour" },
  "légumes ratatouille": { cat: "Fruits & légumes", alt: "mélange courgette-aubergine-poivron surgelé" },
  "lentilles": { cat: "Épicerie", alt: "pois chiches" },
  "légumes de saison": { cat: "Fruits & légumes" },
  "haricots verts": { cat: "Fruits & légumes", alt: "brocolis" },
  "soupe de légumes maison": { cat: "Fruits & légumes" },
  "thon": { cat: "Protéines", alt: "maquereau en boîte" },
  "crevettes": { cat: "Protéines" },
  "curry léger": { cat: "Épicerie" },
  "maquereau": { cat: "Protéines", alt: "sardines" },
  "pommes de terre": { cat: "Fruits & légumes", alt: "patate douce" },
  "pois chiches": { cat: "Épicerie", alt: "lentilles" },
  "boulgour": { cat: "Épicerie", alt: "quinoa ou semoule complète" },
  "truite": { cat: "Protéines", alt: "saumon" },
  "feta légère": { cat: "Produits laitiers", alt: "fromage de chèvre frais" },
  "miso": { cat: "Épicerie" },
  "bacon de dinde": { cat: "Protéines" },
  "noix": { cat: "Épicerie", alt: "amandes" },
  "beurre de cacahuète": { cat: "Épicerie" },
  "graines (chia/lin)": { cat: "Épicerie", alt: "flocons d'avoine" },
  "haricots rouges": { cat: "Épicerie", alt: "haricots noirs" },
  "asperges": { cat: "Fruits & légumes", alt: "haricots verts" },
  "porc filet mignon": { cat: "Protéines", alt: "escalope de dinde" },
  "salade verte": { cat: "Fruits & légumes" },
  "parmesan léger": { cat: "Produits laitiers" },
  "houmous": { cat: "Épicerie", alt: "purée de haricots blancs maison" },
  "pomme": { cat: "Fruits & légumes" },
  "kiwi": { cat: "Fruits & légumes" },
};

/* =========================================================
   COMPOSE TON REPAS — tu choisis toi-même chaque élément
   (rien n'est proposé automatiquement) ; féculents/graisses
   adaptés au déficit calorique choisi dans le calculateur.
   ========================================================= */

const MEAL_PROTEINS = [
  { key:"poulet-blanc", name:"Poulet (blanc / filet)",     cat:"Viande",  qty:150, unit:"g",      kcal:248, protein:46 },
  { key:"poulet-cuisse",name:"Poulet (cuisse sans peau)",  cat:"Viande",  qty:150, unit:"g",      kcal:263, protein:39 },
  { key:"dinde",        name:"Dinde (escalope)",           cat:"Viande",  qty:150, unit:"g",      kcal:225, protein:44 },
  { key:"boeuf-hache",  name:"Bœuf haché 5%",              cat:"Viande",  qty:150, unit:"g",      kcal:258, protein:39 },
  { key:"boeuf-steak",  name:"Steak de bœuf (rumsteak)",   cat:"Viande",  qty:150, unit:"g",      kcal:285, protein:47 },
  { key:"porc",         name:"Filet mignon de porc",       cat:"Viande",  qty:150, unit:"g",      kcal:215, protein:39 },
  { key:"veau",         name:"Escalope de veau",           cat:"Viande",  qty:150, unit:"g",      kcal:258, protein:47 },
  { key:"agneau",       name:"Gigot d'agneau",             cat:"Viande",  qty:150, unit:"g",      kcal:330, protein:42 },
  { key:"jambon-blanc", name:"Jambon blanc dégraissé",     cat:"Viande",  qty:100, unit:"g",      kcal:100, protein:20 },
  { key:"saumon",       name:"Saumon",                     cat:"Poisson", qty:150, unit:"g",      kcal:312, protein:33 },
  { key:"cabillaud",    name:"Cabillaud",                  cat:"Poisson", qty:150, unit:"g",      kcal:158, protein:35 },
  { key:"thon-frais",   name:"Thon frais",                 cat:"Poisson", qty:150, unit:"g",      kcal:198, protein:42 },
  { key:"thon-boite",   name:"Thon en boîte (au naturel)", cat:"Poisson", qty:150, unit:"g",      kcal:174, protein:39 },
  { key:"truite",       name:"Truite",                     cat:"Poisson", qty:150, unit:"g",      kcal:252, protein:36 },
  { key:"crevettes",    name:"Crevettes",                  cat:"Poisson", qty:150, unit:"g",      kcal:149, protein:32 },
  { key:"maquereau",    name:"Maquereau",                  cat:"Poisson", qty:150, unit:"g",      kcal:393, protein:29 },
  { key:"sardines",     name:"Sardines (boîte à l'huile égouttée)", cat:"Poisson", qty:100, unit:"g", kcal:208, protein:25 },
  { key:"gambas",       name:"Gambas",                     cat:"Poisson", qty:150, unit:"g",      kcal:135, protein:29 },
  { key:"oeufs",        name:"Œufs",                       cat:"Œuf / Végétal", qty:3, unit:"unités", kcal:234, protein:19 },
  { key:"tofu",         name:"Tofu ferme",                 cat:"Œuf / Végétal", qty:150, unit:"g", kcal:218, protein:23 },
  { key:"tempeh",       name:"Tempeh",                     cat:"Œuf / Végétal", qty:150, unit:"g", kcal:285, protein:29 },
  { key:"seitan",       name:"Seitan",                     cat:"Œuf / Végétal", qty:150, unit:"g", kcal:180, protein:38 },
  { key:"pois-chiches", name:"Pois chiches (cuits)",       cat:"Œuf / Végétal", qty:150, unit:"g", kcal:246, protein:14 },
  { key:"lentilles",    name:"Lentilles (cuites)",         cat:"Œuf / Végétal", qty:150, unit:"g", kcal:174, protein:14 },
  { key:"haricots-rouges", name:"Haricots rouges (cuits)", cat:"Œuf / Végétal", qty:150, unit:"g", kcal:191, protein:14 },
  { key:"edamame",      name:"Edamame (cuits)",            cat:"Œuf / Végétal", qty:150, unit:"g", kcal:183, protein:17 },
  { key:"cottage",      name:"Cottage cheese",             cat:"Œuf / Végétal", qty:150, unit:"g", kcal:147, protein:17 },
];

const MEAL_STARCHES = [
  { name:"Riz complet",        qty:60,  unit:"g (cru)",  kcal:210, protein:4.2 },
  { name:"Riz basmati",        qty:60,  unit:"g (cru)",  kcal:210, protein:4.2 },
  { name:"Riz sauvage",        qty:60,  unit:"g (cru)",  kcal:214, protein:9 },
  { name:"Quinoa",             qty:60,  unit:"g (cru)",  kcal:221, protein:8.4 },
  { name:"Pâtes complètes",    qty:70,  unit:"g (crues)",kcal:245, protein:9.1 },
  { name:"Patate douce",       qty:200, unit:"g (cuite)",kcal:172, protein:3.2 },
  { name:"Pomme de terre",     qty:200, unit:"g (cuite)",kcal:174, protein:4 },
  { name:"Semoule complète",   qty:60,  unit:"g (crue)", kcal:216, protein:7.6 },
  { name:"Boulgour",           qty:60,  unit:"g (cru)",  kcal:205, protein:7.2 },
  { name:"Pain complet",       qty:60,  unit:"g (~2 tranches)", kcal:148, protein:7.8 },
  { name:"Sarrasin",           qty:60,  unit:"g (cru)",  kcal:206, protein:7.8 },
  { name:"Orge perlé",         qty:60,  unit:"g (cru)",  kcal:211, protein:6 },
  { name:"Épeautre",           qty:60,  unit:"g (cru)",  kcal:203, protein:9 },
  { name:"Polenta (semoule de maïs)", qty:60, unit:"g (crue)", kcal:217, protein:5.1 },
  { name:"Couscous complet",   qty:60,  unit:"g (cru)",  kcal:213, protein:7.8 },
  { name:"Vermicelles de riz", qty:60,  unit:"g (crus)", kcal:216, protein:3.6 },
];

const MEAL_VEGETABLES = [
  { name:"Brocolis",              qty:150, unit:"g", kcal:53,  protein:4.5 },
  { name:"Haricots verts",        qty:150, unit:"g", kcal:47,  protein:2.7 },
  { name:"Épinards",              qty:150, unit:"g", kcal:35,  protein:4.4 },
  { name:"Courgettes",            qty:200, unit:"g", kcal:34,  protein:2.4 },
  { name:"Poivrons",              qty:150, unit:"g", kcal:39,  protein:1.5 },
  { name:"Carottes",              qty:150, unit:"g", kcal:62,  protein:1.4 },
  { name:"Salade verte",          qty:80,  unit:"g", kcal:12,  protein:1.1 },
  { name:"Champignons",           qty:150, unit:"g", kcal:33,  protein:4.7 },
  { name:"Asperges",              qty:150, unit:"g", kcal:30,  protein:3.3 },
  { name:"Ratatouille (mélange)", qty:200, unit:"g", kcal:100, protein:3 },
  { name:"Tomates cerises",       qty:100, unit:"g", kcal:18,  protein:0.9 },
  { name:"Chou-fleur",            qty:150, unit:"g", kcal:38,  protein:3 },
  { name:"Chou kale",             qty:150, unit:"g", kcal:74,  protein:6.5 },
  { name:"Aubergine",             qty:150, unit:"g", kcal:38,  protein:1.5 },
  { name:"Fenouil",               qty:150, unit:"g", kcal:47,  protein:1.8 },
  { name:"Poireaux",              qty:150, unit:"g", kcal:47,  protein:2.3 },
  { name:"Betterave (cuite)",     qty:150, unit:"g", kcal:66,  protein:2.6 },
  { name:"Endives",               qty:150, unit:"g", kcal:26,  protein:1.5 },
  { name:"Roquette",              qty:80,  unit:"g", kcal:20,  protein:2.1 },
  { name:"Petits pois",           qty:150, unit:"g", kcal:122, protein:8.1 },
  { name:"Navet",                 qty:150, unit:"g", kcal:42,  protein:1.4 },
];

// Sauces : pour napper/accompagner le repas (distinct des épices sèches).
const MEAL_SAUCES = [
  { name:"Sauce tomate maison",          qty:50, unit:"g", cat:"Épicerie",          kcal:18,  protein:0.8 },
  { name:"Sauce yaourt-citron",          qty:50, unit:"g", cat:"Produits laitiers", kcal:23,  protein:2 },
  { name:"Sauce curry léger (coco)",     qty:50, unit:"g", cat:"Épicerie",          kcal:45,  protein:0.8 },
  { name:"Vinaigrette moutarde-miel",    qty:30, unit:"g", cat:"Épicerie",          kcal:75,  protein:0.2 },
  { name:"Sauce fromage blanc-herbes",   qty:50, unit:"g", cat:"Produits laitiers", kcal:28,  protein:3.5 },
  { name:"Sauce soja-gingembre",         qty:30, unit:"g", cat:"Épicerie",          kcal:18,  protein:1.2 },
  { name:"Sauce barbecue légère",        qty:30, unit:"g", cat:"Épicerie",          kcal:33,  protein:0.2 },
  { name:"Pesto léger",                  qty:30, unit:"g", cat:"Épicerie",          kcal:78,  protein:1.2 },
  { name:"Sauce blanche allégée (béchamel light)", qty:50, unit:"g", cat:"Produits laitiers", kcal:35, protein:1.5 },
  { name:"Salsa maison",                 qty:50, unit:"g", cat:"Fruits & légumes",  kcal:15,  protein:0.5 },
  { name:"Tzatziki",                     qty:50, unit:"g", cat:"Produits laitiers", kcal:33,  protein:2 },
  { name:"Guacamole léger",              qty:50, unit:"g", cat:"Fruits & légumes",  kcal:75,  protein:1 },
  { name:"Sauce teriyaki",               qty:30, unit:"g", cat:"Épicerie",          kcal:27,  protein:0.6 },
  { name:"Chimichurri",                  qty:30, unit:"g", cat:"Épicerie",          kcal:66,  protein:0.3 },
];

const MEAL_SEASONINGS = [
  { name:"Huile d'olive",             qty:1,   unit:"c. à soupe", cat:"Épicerie",         kcal:90,  protein:0 },
  { name:"Huile de sésame",           qty:1,   unit:"c. à soupe", cat:"Épicerie",         kcal:90,  protein:0 },
  { name:"Beurre",                    qty:1,   unit:"c. à café",  cat:"Produits laitiers", kcal:36, protein:0 },
  { name:"Skyr nature (en sauce)",    qty:50,  unit:"g",          cat:"Produits laitiers", kcal:32,  protein:5.5 },
  { name:"Citron (jus)",              qty:0.5, unit:"unité",      cat:"Fruits & légumes",  kcal:5,   protein:0.2 },
  { name:"Vinaigre balsamique",       qty:1,   unit:"c. à soupe", cat:"Épicerie",         kcal:15,  protein:0 },
  { name:"Moutarde",                  qty:1,   unit:"c. à café",  cat:"Épicerie",         kcal:8,   protein:0.5 },
  { name:"Herbes de Provence",        qty:1,   unit:"pincée",     cat:"Épicerie",         kcal:2,   protein:0 },
  { name:"Ail + persil",              qty:1,   unit:"gousse",     cat:"Fruits & légumes",  kcal:5,   protein:0.3 },
  { name:"Sauce soja légère",         qty:1,   unit:"c. à soupe", cat:"Épicerie",         kcal:10,  protein:1 },
  { name:"Épices (paprika / cumin)",  qty:1,   unit:"pincée",     cat:"Épicerie",         kcal:3,   protein:0.1 },
  { name:"Graines de sésame",         qty:1,   unit:"c. à soupe", cat:"Épicerie",         kcal:52,  protein:1.6 },
  { name:"Levure maltée",             qty:1,   unit:"c. à soupe", cat:"Épicerie",         kcal:20,  protein:2.5 },
  { name:"Parmesan râpé (léger)",     qty:1,   unit:"c. à soupe", cat:"Produits laitiers", kcal:21,  protein:1.9 },
  { name:"Persil frais",              qty:1,   unit:"pincée",     cat:"Fruits & légumes",  kcal:1,   protein:0.1 },
  { name:"Ciboulette",                qty:1,   unit:"pincée",     cat:"Fruits & légumes",  kcal:1,   protein:0.1 },
  { name:"Gingembre frais",           qty:1,   unit:"petit morceau", cat:"Fruits & légumes", kcal:4,  protein:0.1 },
  { name:"Piment d'Espelette",        qty:1,   unit:"pincée",     cat:"Épicerie",         kcal:3,   protein:0.1 },
];

const BREAKFAST_BASES = [
  { name:"Skyr nature",                                  qty:200, unit:"g",       cat:"Produits laitiers", kcal:126, protein:22 },
  { name:"Fromage blanc 0%",                             qty:200, unit:"g",       cat:"Produits laitiers", kcal:94,  protein:16 },
  { name:"Yaourt grec",                                  qty:200, unit:"g",       cat:"Produits laitiers", kcal:196, protein:20 },
  { name:"Cottage cheese",                               qty:200, unit:"g",       cat:"Produits laitiers", kcal:196, protein:22 },
  { name:"Pancakes protéinés (œufs + flocons + skyr)",   qty:3,   unit:"pancakes",cat:"Protéines",         kcal:330, protein:24 },
  { name:"Œufs brouillés",                               qty:3,   unit:"unités",  cat:"Protéines",         kcal:234, protein:19 },
];

const BREAKFAST_TOPPINGS = [
  { name:"Flocons d'avoine",       qty:40,  unit:"g",          cat:"Épicerie",         kcal:150, protein:5.2 },
  { name:"Granola",                qty:30,  unit:"g",          cat:"Épicerie",         kcal:135, protein:3 },
  { name:"Fruits rouges",          qty:100, unit:"g",          cat:"Fruits & légumes",  kcal:50,  protein:1 },
  { name:"Myrtilles",              qty:80,  unit:"g",          cat:"Fruits & légumes",  kcal:45,  protein:0.6 },
  { name:"Banane",                 qty:1,   unit:"unité",      cat:"Fruits & légumes",  kcal:105, protein:1.3 },
  { name:"Miel",                   qty:1,   unit:"c. à café",  cat:"Épicerie",         kcal:21,  protein:0 },
  { name:"Cannelle",               qty:1,   unit:"pincée",     cat:"Épicerie",         kcal:2,   protein:0 },
  { name:"Beurre de cacahuète",    qty:1,   unit:"c. à soupe", cat:"Épicerie",         kcal:95,  protein:4 },
];

function pickRandom(arr, excludeName){
  const pool = excludeName ? arr.filter(x => x.name !== excludeName) : arr;
  const source = pool.length ? pool : arr;
  return source[Math.floor(Math.random() * source.length)];
}

function addGroceryItem(item){
  if(!state.groceryList) state.groceryList = [];
  const existing = state.groceryList.find(g => g.name === item.name && g.unit === item.unit);
  if(existing){ existing.qty += item.qty; }
  else { state.groceryList.push({ ...item }); }
}

function removeGroceryItem(index){
  state.groceryList.splice(index, 1);
  saveState();
}

function clearGroceryList(){
  state.groceryList = [];
  saveState();
}

const GROCERY_CAT_ORDER = ["Protéines", "Féculents", "Fruits & légumes", "Produits laitiers", "Épicerie"];

function generateGroceryListText(){
  const byCat = {};
  (state.groceryList || []).forEach(it => {
    if(!byCat[it.cat]) byCat[it.cat] = [];
    byCat[it.cat].push(it);
  });
  let out = `LISTE DE COURSES — Scream Gym\n\n`;
  GROCERY_CAT_ORDER.forEach(cat => {
    if(!byCat[cat] || !byCat[cat].length) return;
    out += `== ${cat.toUpperCase()} ==\n`;
    byCat[cat].forEach(it => {
      const qtyDisplay = Number.isInteger(it.qty) ? it.qty : it.qty.toFixed(1);
      out += `[ ] ${it.name} — ${qtyDisplay} ${it.unit}\n`;
    });
    out += `\n`;
  });
  out += `— Scream Gym —\n`;
  return out;
}

function downloadGroceryList(){
  downloadTextFile("liste-de-courses.txt", generateGroceryListText());
}

/* ---------- État des stocks ---------- */
function buildFoodReference(){
  const ref = {};
  MEAL_PROTEINS.forEach(p => ref[p.name] = { qty: p.qty, unit: p.unit, cat: "Protéines", kcal: p.kcal, protein: p.protein });
  MEAL_STARCHES.forEach(p => ref[p.name] = { qty: p.qty, unit: p.unit, cat: "Féculents", kcal: p.kcal, protein: p.protein });
  MEAL_VEGETABLES.forEach(p => ref[p.name] = { qty: p.qty, unit: p.unit, cat: "Fruits & légumes", kcal: p.kcal, protein: p.protein });
  MEAL_SAUCES.forEach(p => ref[p.name] = { qty: p.qty, unit: p.unit, cat: p.cat || "Épicerie", kcal: p.kcal, protein: p.protein });
  MEAL_SEASONINGS.forEach(p => ref[p.name] = { qty: p.qty, unit: p.unit, cat: p.cat || "Épicerie", kcal: p.kcal, protein: p.protein });
  BREAKFAST_BASES.forEach(p => ref[p.name] = { qty: p.qty, unit: p.unit, cat: p.cat || "Protéines", kcal: p.kcal, protein: p.protein });
  BREAKFAST_TOPPINGS.forEach(p => ref[p.name] = { qty: p.qty, unit: p.unit, cat: p.cat || "Épicerie", kcal: p.kcal, protein: p.protein });
  return ref;
}
const FOOD_REFERENCE = buildFoodReference();

function allFoodNames(){
  return Object.keys(FOOD_REFERENCE);
}

function setStockQty(name, qty){
  if(!state.stock) state.stock = {};
  const ref = FOOD_REFERENCE[name];
  if(qty <= 0){
    delete state.stock[name];
  } else {
    state.stock[name] = { qty, unit: (state.stock[name] && state.stock[name].unit) || (ref ? ref.unit : ""), cat: (ref ? ref.cat : "Épicerie") };
  }
  saveState();
}

function consumeStockQty(name, qty){
  if(!state.stock || !state.stock[name] || qty <= 0) return;
  const newQty = Math.max(0, state.stock[name].qty - qty);
  if(newQty <= 0){
    delete state.stock[name];
  } else {
    state.stock[name].qty = newQty;
  }
  saveState();
}

function addToStockQty(name, qty, unit, cat){
  if(!state.stock) state.stock = {};
  if(!state.stock[name]){
    state.stock[name] = { qty: 0, unit: unit || (FOOD_REFERENCE[name] ? FOOD_REFERENCE[name].unit : ""), cat: cat || (FOOD_REFERENCE[name] ? FOOD_REFERENCE[name].cat : "Épicerie") };
  }
  state.stock[name].qty += qty;
}

function removeStockItem(name){
  if(!state.stock) return;
  delete state.stock[name];
  saveState();
}

function markShoppingDone(){
  (state.groceryList || []).forEach(it => addToStockQty(it.name, it.qty, it.unit, it.cat));
  state.groceryList = [];
  saveState();
}

function stockLevel(name){
  const stock = state.stock && state.stock[name];
  const ref = FOOD_REFERENCE[name];
  if(!stock) return "absent";
  if(stock.qty <= 0) return "epuise";
  if(ref && stock.qty < ref.qty) return "bas";
  return "ok";
}

function stockRows(){
  const rows = Object.keys(state.stock || {}).map(name => ({
    name,
    qty: state.stock[name].qty,
    unit: state.stock[name].unit,
    cat: state.stock[name].cat,
    level: stockLevel(name)
  }));
  const levelOrder = { epuise: 0, bas: 1, ok: 2 };
  return rows.sort((a,b) => levelOrder[a.level] - levelOrder[b.level] || a.name.localeCompare(b.name));
}

/* ---------- Suppléments du jour (shakers / barres) ---------- */
function todayStr(){
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}

function defaultSupplementsState(){
  return {
    date: todayStr(),
    shakeCount: 0,
    barCount: 0,
    shakeProtein: 25,
    shakeCalories: 120,
    barProtein: 20,
    barCalories: 200,
  };
}

function ensureSupplementsToday(){
  if(!state.supplements) state.supplements = defaultSupplementsState();
  if(state.supplements.date !== todayStr()){
    state.supplements.date = todayStr();
    state.supplements.shakeCount = 0;
    state.supplements.barCount = 0;
  }
}

function adjustSupplementCount(type, delta){
  ensureSupplementsToday();
  const key = type === "shake" ? "shakeCount" : "barCount";
  state.supplements[key] = Math.max(0, state.supplements[key] + delta);
  saveState();
}

function setSupplementUnitValue(type, field, value){
  ensureSupplementsToday();
  const key = type + field.charAt(0).toUpperCase() + field.slice(1);
  state.supplements[key] = Math.max(0, value);
  saveState();
}

function supplementsTotals(){
  ensureSupplementsToday();
  const s = state.supplements;
  return {
    shakeCount: s.shakeCount, barCount: s.barCount,
    shakeProtein: s.shakeProtein, shakeCalories: s.shakeCalories,
    barProtein: s.barProtein, barCalories: s.barCalories,
    proteinTotal: Math.round(s.shakeCount * s.shakeProtein + s.barCount * s.barProtein),
    caloriesTotal: Math.round(s.shakeCount * s.shakeCalories + s.barCount * s.barCalories),
  };
}

/* =========================================================
   JOURNAL CALORIQUE DU JOUR — chaque repas "mangé" (petit-déj
   ou repas composé) vient s'ajouter ici avec ses calories
   estimées, pour suivre le total du jour face à l'objectif
   calculé plus haut. Remise à zéro automatique chaque jour.
   ========================================================= */

function defaultDailyLogState(){
  return { date: todayStr(), entries: [] };
}

function ensureDailyLogToday(){
  if(!state.dailyLog) state.dailyLog = defaultDailyLogState();
  if(state.dailyLog.date !== todayStr()){
    state.dailyLog = defaultDailyLogState();
  }
}

function kcalForItem(name, qty){
  const ref = FOOD_REFERENCE[name];
  if(!ref || !ref.kcal || !ref.qty) return 0;
  return Math.round((ref.kcal / ref.qty) * qty);
}

function proteinForItem(name, qty){
  const ref = FOOD_REFERENCE[name];
  if(!ref || !ref.protein || !ref.qty) return 0;
  return Math.round((ref.protein / ref.qty) * qty * 10) / 10;
}

function logMealCalories(label, items){
  ensureDailyLogToday();
  const detail = items.map(it => ({ name: it.name, qty: it.qty, unit: it.unit, kcal: kcalForItem(it.name, it.qty), protein: proteinForItem(it.name, it.qty) }));
  const kcal = detail.reduce((sum, it) => sum + it.kcal, 0);
  const protein = Math.round(detail.reduce((sum, it) => sum + it.protein, 0) * 10) / 10;
  state.dailyLog.entries.push({ label, items: detail, kcal, protein, time: new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }) });
  saveState();
  return { kcal, protein };
}

/* Enregistrement rapide : pour un repas fait maison / au restaurant, ou un shaker /
   une barre protéinée, quand on connaît juste le grammage, les calories et les
   protéines mais que l'aliment n'est pas dans le catalogue. Un seul système,
   utilisable de la même façon pour n'importe quel type de repas ou supplément. */
function logQuickItem(mealType, name, grams, kcal, protein){
  ensureDailyLogToday();
  const kcalVal = Math.round(kcal) || 0;
  const proteinVal = Math.round((protein || 0) * 10) / 10;
  const gramsNote = grams ? ` (${grams}g)` : "";
  const item = { name, qty: grams || null, unit: grams ? "g" : null, kcal: kcalVal, protein: proteinVal };
  state.dailyLog.entries.push({
    label: `${mealType} — ${name}${gramsNote}`,
    items: [item], kcal: kcalVal, protein: proteinVal,
    time: new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' })
  });
  saveState();
  return { kcal: kcalVal, protein: proteinVal };
}

/* ---------- Plats enregistrés (favoris réutilisables en un clic) ----------
   Contrairement au journal du jour, cette liste ne se réinitialise jamais :
   c'est un catalogue personnel qui s'enrichit à chaque enregistrement rapide,
   pour pouvoir recompter le même plat/shaker/barre sans tout retaper. */
function saveMealTemplate(mealType, name, grams, kcal, protein){
  const key = (mealType + "__" + name).toLowerCase();
  const existing = state.savedMeals.find(m => (m.mealType + "__" + m.name).toLowerCase() === key);
  if(existing){
    existing.grams = grams; existing.kcal = kcal; existing.protein = protein;
  } else {
    state.savedMeals.push({ id: Date.now() + Math.random().toString(36).slice(2,7), mealType, name, grams, kcal, protein });
  }
  saveState();
}

function removeMealTemplate(id){
  state.savedMeals = state.savedMeals.filter(m => m.id !== id);
  saveState();
}

function logSavedMeal(id){
  const meal = state.savedMeals.find(m => m.id === id);
  if(!meal) return null;
  return logQuickItem(meal.mealType, meal.name, meal.grams, meal.kcal, meal.protein);
}

function removeDailyLogEntry(index){
  ensureDailyLogToday();
  state.dailyLog.entries.splice(index, 1);
  saveState();
}

function dailyLogTotals(){
  ensureDailyLogToday();
  const kcalTotal = state.dailyLog.entries.reduce((sum, e) => sum + e.kcal, 0);
  const proteinTotal = Math.round(state.dailyLog.entries.reduce((sum, e) => sum + (e.protein || 0), 0) * 10) / 10;
  return { entries: state.dailyLog.entries, kcalTotal, proteinTotal };
}

const WEEKLY_MENUS = [
  { name: "Semaine Scream Gym",
    days: [
      { day:"Lundi",
        breakfast:{ name:"Bol d'avoine au skyr et myrtilles", items:["flocons d'avoine","skyr","myrtilles","amandes","cannelle"] },
        lunch:{ name:"Poulet rôti, riz complet, brocolis", items:["poulet","riz complet","brocolis"] },
        dinner:{ name:"Omelette aux légumes et salade verte", items:["oeufs","poivrons","champignons","salade verte"] } },
      { day:"Mardi",
        breakfast:{ name:"Œufs brouillés et pain complet à l'avocat", items:["oeufs","pain complet","avocat","tomates cerises"] },
        lunch:{ name:"Saumon, patate douce, épinards", items:["saumon","patate douce","épinards","citron"] },
        dinner:{ name:"Filet de poulet grillé, haricots verts", items:["poulet","haricots verts"] } },
      { day:"Mercredi",
        breakfast:{ name:"Porridge protéiné banane-cacao", items:["flocons d'avoine","whey ou lait","banane","cacao non sucré"] },
        lunch:{ name:"Bœuf haché maigre, quinoa, poivrons", items:["boeuf haché 5%","quinoa","poivrons","oignon"] },
        dinner:{ name:"Poisson blanc vapeur, courgettes sautées", items:["cabillaud","courgettes","ail"] } },
      { day:"Jeudi",
        breakfast:{ name:"Omelette champignons et fromage frais", items:["oeufs","champignons","fromage frais léger","ciboulette"] },
        lunch:{ name:"Dinde, pâtes complètes, courgettes à l'ail", items:["dinde","pâtes complètes","courgettes","ail"] },
        dinner:{ name:"Soupe de légumes maison et œufs durs", items:["soupe de légumes maison","oeufs"] } },
      { day:"Vendredi",
        breakfast:{ name:"Yaourt grec, granola, fruits rouges", items:["yaourt grec","granola","fruits rouges","miel"] },
        lunch:{ name:"Tofu mariné, riz basmati, brocolis-carottes", items:["tofu","riz basmati","brocolis","carottes","sauce soja"] },
        dinner:{ name:"Salade de thon, tomates, œufs, quinoa froid", items:["thon","tomates cerises","oeufs","quinoa"] } },
      { day:"Samedi",
        breakfast:{ name:"Pain complet, fromage blanc, œuf dur, concombre", items:["pain complet","fromage blanc","oeufs","concombre"] },
        lunch:{ name:"Cabillaud, semoule complète, ratatouille", items:["cabillaud","semoule complète","légumes ratatouille"] },
        dinner:{ name:"Escalope de dinde, épinards à l'ail", items:["dinde","épinards","ail"] } },
      { day:"Dimanche",
        breakfast:{ name:"Pancakes protéinés à la banane", items:["oeufs","banane","flocons d'avoine","cannelle"] },
        lunch:{ name:"Lentilles, légumes rôtis, œuf poché", items:["lentilles","légumes de saison","oeufs"] },
        dinner:{ name:"Tofu sauté, légumes wok, sauce soja légère", items:["tofu","poivrons","carottes","sauce soja"] } },
    ]
  },
  { name: "Semaine Fleur de Cerisier",
    days: [
      { day:"Lundi",
        breakfast:{ name:"Smoothie protéiné banane-avoine", items:["whey ou lait","banane","flocons d'avoine","beurre de cacahuète"] },
        lunch:{ name:"Crevettes sautées, riz complet, légumes croquants", items:["crevettes","riz complet","poivrons","carottes"] },
        dinner:{ name:"Salade de poulet, avocat, tomates", items:["poulet","avocat","tomates cerises","salade verte"] } },
      { day:"Mardi",
        breakfast:{ name:"Œufs pochés, avocat, pain complet", items:["oeufs","avocat","pain complet"] },
        lunch:{ name:"Poulet au curry léger, riz basmati, épinards", items:["poulet","curry léger","riz basmati","épinards"] },
        dinner:{ name:"Soupe miso, tofu, légumes", items:["miso","tofu","carottes","champignons"] } },
      { day:"Mercredi",
        breakfast:{ name:"Skyr, flocons d'avoine, pomme, cannelle", items:["skyr","flocons d'avoine","pomme","cannelle"] },
        lunch:{ name:"Steak haché 5%, pâtes complètes, salade", items:["boeuf haché 5%","pâtes complètes","salade verte"] },
        dinner:{ name:"Cabillaud au citron, courgettes", items:["cabillaud","citron","courgettes"] } },
      { day:"Jeudi",
        breakfast:{ name:"Omelette au saumon fumé et fromage frais", items:["oeufs","saumon","fromage frais léger"] },
        lunch:{ name:"Maquereau, pommes de terre vapeur, haricots verts", items:["maquereau","pommes de terre","haricots verts"] },
        dinner:{ name:"Œufs brouillés, épinards, champignons", items:["oeufs","épinards","champignons"] } },
      { day:"Vendredi",
        breakfast:{ name:"Porridge quinoa, lait, fruits secs", items:["quinoa","whey ou lait","amandes"] },
        lunch:{ name:"Pois chiches, riz, légumes rôtis (repas végé)", items:["pois chiches","riz complet","légumes de saison"] },
        dinner:{ name:"Salade de lentilles, feta légère, concombre", items:["lentilles","feta légère","concombre"] } },
      { day:"Samedi",
        breakfast:{ name:"Pain complet, houmous, œuf dur, tomates", items:["pain complet","houmous","oeufs","tomates cerises"] },
        lunch:{ name:"Dinde, boulgour, poivrons grillés", items:["dinde","boulgour","poivrons"] },
        dinner:{ name:"Blanc de poulet grillé, ratatouille", items:["poulet","légumes ratatouille"] } },
      { day:"Dimanche",
        breakfast:{ name:"Yaourt grec, muesli, kiwi", items:["yaourt grec","granola","kiwi"] },
        lunch:{ name:"Truite, quinoa, brocolis", items:["truite","quinoa","brocolis"] },
        dinner:{ name:"Poisson blanc, salade verte, vinaigrette légère", items:["cabillaud","salade verte","citron"] } },
    ]
  },
  { name: "Semaine Lune Douce",
    days: [
      { day:"Lundi",
        breakfast:{ name:"Œufs, bacon de dinde grillé, tomates", items:["oeufs","bacon de dinde","tomates cerises"] },
        lunch:{ name:"Bœuf sauté, riz complet, brocolis", items:["boeuf haché 5%","riz complet","brocolis"] },
        dinner:{ name:"Salade César allégée (poulet, salade, parmesan léger)", items:["poulet","salade verte","parmesan léger"] } },
      { day:"Mardi",
        breakfast:{ name:"Porridge avoine, banane, noix", items:["flocons d'avoine","banane","noix"] },
        lunch:{ name:"Poulet grillé, patate douce, salade", items:["poulet","patate douce","salade verte"] },
        dinner:{ name:"Soupe de légumes maison et œuf", items:["soupe de légumes maison","oeufs"] } },
      { day:"Mercredi",
        breakfast:{ name:"Skyr, granola, fruits rouges", items:["skyr","granola","fruits rouges"] },
        lunch:{ name:"Chili con carne maison (bœuf, haricots rouges, riz)", items:["boeuf haché 5%","haricots rouges","riz complet"] },
        dinner:{ name:"Poisson blanc, épinards", items:["cabillaud","épinards"] } },
      { day:"Jeudi",
        breakfast:{ name:"Omelette épinards et feta légère", items:["oeufs","épinards","feta légère"] },
        lunch:{ name:"Saumon, quinoa, asperges", items:["saumon","quinoa","asperges"] },
        dinner:{ name:"Tofu grillé, légumes sautés", items:["tofu","poivrons","courgettes"] } },
      { day:"Vendredi",
        breakfast:{ name:"Pain complet, beurre de cacahuète, banane", items:["pain complet","beurre de cacahuète","banane"] },
        lunch:{ name:"Pois chiches épicés, riz, légumes", items:["pois chiches","riz complet","légumes de saison"] },
        dinner:{ name:"Salade thon, œufs, tomates", items:["thon","oeufs","tomates cerises"] } },
      { day:"Samedi",
        breakfast:{ name:"Yaourt grec, flocons d'avoine, pomme, cannelle", items:["yaourt grec","flocons d'avoine","pomme","cannelle"] },
        lunch:{ name:"Dinde, pâtes complètes, sauce tomate maison", items:["dinde","pâtes complètes","tomates cerises","ail"] },
        dinner:{ name:"Blanc de poulet, courgettes grillées", items:["poulet","courgettes"] } },
      { day:"Dimanche",
        breakfast:{ name:"Smoothie bowl protéiné (yaourt, fruits, graines)", items:["yaourt grec","fruits rouges","graines (chia/lin)"] },
        lunch:{ name:"Filet mignon de porc, purée de patate douce, haricots verts", items:["porc filet mignon","patate douce","haricots verts"] },
        dinner:{ name:"Omelette légumes, salade verte", items:["oeufs","poivrons","salade verte"] } },
    ]
  },
  { name: "Semaine Cœur Pêche",
    days: [
      { day:"Lundi",
        breakfast:{ name:"Œufs au plat, pain complet, tomates poêlées", items:["oeufs","pain complet","tomates cerises"] },
        lunch:{ name:"Poulet, boulgour, courgettes", items:["poulet","boulgour","courgettes"] },
        dinner:{ name:"Salade de pois chiches, thon, tomates", items:["pois chiches","thon","tomates cerises"] } },
      { day:"Mardi",
        breakfast:{ name:"Bowl skyr, noix, miel", items:["skyr","noix","miel"] },
        lunch:{ name:"Thon, riz complet, poivrons", items:["thon","riz complet","poivrons"] },
        dinner:{ name:"Omelette au fromage frais et ciboulette", items:["oeufs","fromage frais léger","ciboulette"] } },
      { day:"Mercredi",
        breakfast:{ name:"Porridge avoine, pomme, cannelle", items:["flocons d'avoine","pomme","cannelle"] },
        lunch:{ name:"Bœuf haché, patate douce, haricots verts", items:["boeuf haché 5%","patate douce","haricots verts"] },
        dinner:{ name:"Filet de poulet, haricots verts", items:["poulet","haricots verts"] } },
      { day:"Jeudi",
        breakfast:{ name:"Omelette jambon de dinde et fromage frais", items:["bacon de dinde","oeufs","fromage frais léger"] },
        lunch:{ name:"Tofu, quinoa, épinards", items:["tofu","quinoa","épinards"] },
        dinner:{ name:"Soupe miso, tofu", items:["miso","tofu"] } },
      { day:"Vendredi",
        breakfast:{ name:"Smoothie vert protéiné", items:["épinards","banane","whey ou lait"] },
        lunch:{ name:"Crevettes, riz basmati, brocolis", items:["crevettes","riz basmati","brocolis"] },
        dinner:{ name:"Truite, épinards", items:["truite","épinards"] } },
      { day:"Samedi",
        breakfast:{ name:"Pain complet, avocat, œuf poché", items:["pain complet","avocat","oeufs"] },
        lunch:{ name:"Dinde, lentilles, carottes", items:["dinde","lentilles","carottes"] },
        dinner:{ name:"Salade César légère, dinde", items:["dinde","salade verte","parmesan léger"] } },
      { day:"Dimanche",
        breakfast:{ name:"Yaourt grec, fruits rouges, granola", items:["yaourt grec","fruits rouges","granola"] },
        lunch:{ name:"Saumon, semoule complète, courgettes", items:["saumon","semoule complète","courgettes"] },
        dinner:{ name:"Cabillaud, courgettes vapeur", items:["cabillaud","courgettes"] } },
    ]
  }
];

const SNACKS_FRINGALE = [
  { name: "Skyr ou yaourt grec + cannelle", note: "riche en protéines, très rassasiant, peu calorique" },
  { name: "Poignée d'amandes (20g)", note: "gras satiétogènes, à mesurer pour éviter l'excès" },
  { name: "Œuf dur", note: "protéine pure, transportable, coupe-faim solide" },
  { name: "Pomme + carré de fromage frais léger", note: "sucre naturel + protéine, combo anti-fringale classique" },
  { name: "Blanc de poulet ou dinde froid (restes)", note: "quasi sans calories, 100% protéines" },
  { name: "Bâtonnets de concombre / carotte + houmous", note: "volume + fibres, très peu de calories" },
  { name: "Thé ou infusion + eau pétillante", note: "beaucoup de fringales sont en fait de la soif" },
  { name: "Fromage blanc 0% + fruits rouges", note: "protéiné, sucré naturellement, très rassasiant" },
];

function getISOWeek(date){
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function currentWeekIndex(){
  const week = getISOWeek(new Date());
  return week % WEEKLY_MENUS.length;
}

function downloadTextFile(filename, content){
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function generateShoppingListText(weekIndex){
  const week = WEEKLY_MENUS[weekIndex];
  const seen = new Set();
  const byCat = {};
  week.days.forEach(d => {
    [d.breakfast, d.lunch, d.dinner].forEach(meal => {
      meal.items.forEach(item => {
        if(seen.has(item)) return;
        seen.add(item);
        const info = INGREDIENT_INFO[item] || { cat: "Épicerie" };
        if(!byCat[info.cat]) byCat[info.cat] = [];
        byCat[info.cat].push({ item, alt: info.alt });
      });
    });
  });

  const catOrder = ["Protéines", "Fruits & légumes", "Épicerie", "Produits laitiers"];
  let out = `LISTE DE COURSES — ${week.name}\n`;
  out += `Quantités indicatives — ajuste selon tes portions et le nombre de jours réellement cuisinés.\n\n`;
  catOrder.forEach(cat => {
    if(!byCat[cat]) return;
    out += `== ${cat.toUpperCase()} ==\n`;
    byCat[cat].forEach(entry => {
      out += `[ ] ${entry.item}`;
      if(entry.alt) out += ` (dur à trouver ? remplace par : ${entry.alt})`;
      out += `\n`;
    });
    out += `\n`;
  });
  out += `— Scream Gym —\n`;
  return out;
}

/* ---------- Icônes machines (pictogrammes stylisés, salle de sport) ---------- */
const MACHINE_ICONS = {
  treadmill:   { label: "Cardio (tapis/vélo/rameur/escaliers)",
    body: `<rect x="8" y="40" width="40" height="9" rx="4"/><line x1="40" y1="40" x2="48" y2="14"/><rect x="44" y="9" width="12" height="7" rx="2"/><path d="M14 30 q6 -9 12 0 q6 9 12 0" stroke-dasharray="3 3"/>` },
  "chest-press": { label: "Chest Press (machine guidée)",
    body: `<circle cx="16" cy="16" r="6"/><path d="M16 22 v14"/><rect x="10" y="34" width="12" height="14" rx="2"/><path d="M22 26 h20"/><path d="M36 22 l6 4 l-6 4"/><line x1="10" y1="48" x2="26" y2="48"/>` },
  "shoulder-press": { label: "Shoulder Press (machine guidée)",
    body: `<circle cx="32" cy="14" r="6"/><path d="M32 20 v16"/><rect x="26" y="36" width="12" height="14" rx="2"/><path d="M20 24 v-10"/><path d="M44 24 v-10"/><path d="M14 12 l6 -6 l0 8"/><path d="M50 12 l-6 -6 l0 8"/>` },
  "pec-fly": { label: "Pec Fly / Écarté (pec deck)",
    body: `<circle cx="32" cy="14" r="6"/><rect x="26" y="22" width="12" height="16" rx="2"/><path d="M26 26 q-14 4 -16 14"/><path d="M38 26 q14 4 16 14"/><path d="M12 42 l-4 4 l4 2" transform="translate(0,-2)"/>` },
  "lat-pulldown": { label: "Lat Pulldown (poulie haute)",
    body: `<line x1="10" y1="10" x2="54" y2="10"/><line x1="32" y1="10" x2="32" y2="16"/><path d="M18 16 q14 8 28 0" stroke-dasharray="2 3"/><circle cx="32" cy="26" r="6"/><rect x="26" y="34" width="12" height="16" rx="2"/><path d="M20 20 l-6 10"/><path d="M44 20 l6 10"/>` },
  "seated-row": { label: "Seated Row (tirage horizontal)",
    body: `<circle cx="42" cy="16" r="6"/><rect x="36" y="24" width="12" height="14" rx="2"/><line x1="8" y1="34" x2="36" y2="34"/><path d="M10 26 l6 4 l-6 4"/><line x1="20" y1="20" x2="36" y2="30"/>` },
  "leg-press": { label: "Leg Press (presse à cuisses)",
    body: `<rect x="8" y="34" width="16" height="14" rx="2"/><circle cx="16" cy="24" r="6"/><path d="M24 40 l24 -10"/><rect x="46" y="20" width="8" height="20" rx="2"/><path d="M40 30 l6 -3 l1 6"/>` },
  "leg-extension": { label: "Leg Extension / Abduction (machine)",
    body: `<circle cx="18" cy="12" r="6"/><rect x="12" y="20" width="12" height="16" rx="2"/><line x1="18" y1="36" x2="18" y2="46"/><line x1="18" y1="46" x2="40" y2="46"/><path d="M40 46 l6 -10"/><path d="M40 40 l6 2 l-2 6"/>` },
  "leg-curl": { label: "Leg Curl (ischios, machine)",
    body: `<circle cx="46" cy="12" r="6"/><rect x="40" y="20" width="12" height="16" rx="2"/><line x1="46" y1="36" x2="46" y2="46"/><line x1="46" y1="46" x2="20" y2="46"/><path d="M20 46 l-4 -10"/><path d="M20 40 l-5 3 l2 6"/>` },
  "smith-machine": { label: "Smith Machine / Cage à squat",
    body: `<line x1="12" y1="8" x2="12" y2="52"/><line x1="52" y1="8" x2="52" y2="52"/><line x1="10" y1="24" x2="54" y2="24"/><circle cx="32" cy="14" r="6"/><rect x="26" y="34" width="12" height="16" rx="2"/><path d="M20 40 v6"/><path d="M44 40 v6"/>` },
  "cable-pulley": { label: "Poulie / Cable Crossover",
    body: `<line x1="10" y1="8" x2="10" y2="30"/><circle cx="10" cy="8" r="4"/><line x1="54" y1="8" x2="54" y2="30"/><circle cx="54" cy="8" r="4"/><circle cx="32" cy="16" r="6"/><rect x="26" y="24" width="12" height="14" rx="2"/><path d="M14 12 q14 20 16 22"/><path d="M50 12 q-14 20 -16 22"/>` },
  "abdominal-crunch": { label: "Abdominal Crunch (machine)",
    body: `<circle cx="14" cy="34" r="6"/><path d="M14 40 q10 4 16 -4"/><rect x="30" y="30" width="14" height="10" rx="2"/><path d="M44 22 q6 4 4 12" stroke-dasharray="2 3"/>` },
  "back-extension": { label: "Back Extension (machine)",
    body: `<line x1="10" y1="44" x2="46" y2="44"/><circle cx="40" cy="24" r="6"/><path d="M40 30 q-10 6 -12 14"/><path d="M18 40 q0 -8 -4 -14" stroke-dasharray="2 3"/>` },
  dumbbell: { label: "Haltères / poids libres",
    body: `<rect x="6" y="26" width="8" height="12" rx="2"/><rect x="50" y="26" width="8" height="12" rx="2"/><line x1="14" y1="32" x2="50" y2="32"/><circle cx="30" cy="14" r="6"/><rect x="24" y="20" width="12" height="14" rx="2"/>` },
  bench: { label: "Sol / tapis (poids du corps)",
    body: `<rect x="8" y="40" width="48" height="6" rx="2"/><circle cx="20" cy="22" r="6"/><path d="M20 28 q10 4 16 0"/><path d="M20 30 l-8 10"/><path d="M36 28 l8 8"/>` },
  walk: { label: "Marche (récupération active)",
    body: `<circle cx="26" cy="10" r="5"/><path d="M26 15 v14"/><path d="M26 22 l-10 6"/><path d="M26 22 l12 4"/><path d="M26 29 l-8 16"/><path d="M26 29 l10 15"/><path d="M40 12 q6 2 8 8" stroke-dasharray="2 3"/>` },
  stretch: { label: "Étirement",
    body: `<circle cx="20" cy="12" r="6"/><path d="M20 18 v16"/><path d="M20 22 q16 -4 22 -16"/><path d="M20 34 l-8 14"/><path d="M20 34 l10 14"/>` },
  mobility: { label: "Mobilité articulaire",
    body: `<circle cx="32" cy="14" r="6"/><path d="M32 20 v14"/><path d="M20 26 h24"/><path d="M20 40 l0 -6"/><path d="M44 40 l0 -6"/><circle cx="32" cy="34" r="16" fill="none" stroke-dasharray="3 4"/>` },
  breathing: { label: "Respiration / relâchement",
    body: `<circle cx="32" cy="32" r="8"/><circle cx="32" cy="32" r="16" stroke-dasharray="3 4"/><circle cx="32" cy="32" r="24" stroke-dasharray="2 6" opacity="0.6"/>` },
};

function machineIconSVG(key){
  const entry = MACHINE_ICONS[key] || MACHINE_ICONS.dumbbell;
  return `<svg viewBox="0 0 64 64" width="40" height="40" fill="none" stroke="var(--gold-bright)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${entry.body}</svg>`;
}

function machineLabel(key){
  const entry = MACHINE_ICONS[key];
  return entry ? entry.label : "";
}

/* ---------- Mini carte corps par exercice (zone(s) ciblée(s)) ---------- */
function zoneThumbSVG(zoneKeys){
  if(!zoneKeys || zoneKeys.length === 0) return "";
  const first = ZONE_EXERCISES[zoneKeys[0]];
  const isFront = !first || first.view === "front";
  const fill = (z) => zoneKeys.includes(z) ? "var(--ember-bright)" : "var(--iron-light)";
  if(isFront){
    return `<svg viewBox="0 0 100 130" width="40" height="52">
      <circle cx="50" cy="16" r="12" fill="var(--iron-light)"/>
      <rect x="28" y="30" width="44" height="58" rx="12" fill="var(--iron)"/>
      <circle cx="24" cy="38" r="9" fill="${fill('epaules')}"/>
      <circle cx="76" cy="38" r="9" fill="${fill('epaules')}"/>
      <rect x="34" y="36" width="32" height="20" rx="5" fill="${fill('pecs')}"/>
      <rect x="35" y="58" width="30" height="28" rx="5" fill="${fill('abdos')}"/>
      <rect x="14" y="42" width="9" height="22" rx="4" fill="${fill('biceps')}"/>
      <rect x="77" y="42" width="9" height="22" rx="4" fill="${fill('biceps')}"/>
      <rect x="13" y="65" width="9" height="20" rx="4" fill="${fill('avantbras')}"/>
      <rect x="78" y="65" width="9" height="20" rx="4" fill="${fill('avantbras')}"/>
      <rect x="33" y="88" width="15" height="36" rx="6" fill="${fill('quadriceps')}"/>
      <rect x="52" y="88" width="15" height="36" rx="6" fill="${fill('quadriceps')}"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 100 130" width="40" height="52">
    <circle cx="50" cy="16" r="12" fill="var(--iron-light)"/>
    <rect x="28" y="30" width="44" height="58" rx="12" fill="var(--iron)"/>
    <rect x="34" y="34" width="32" height="40" rx="8" fill="${fill('dos')}"/>
    <rect x="14" y="42" width="9" height="28" rx="4" fill="${fill('triceps')}"/>
    <rect x="77" y="42" width="9" height="28" rx="4" fill="${fill('triceps')}"/>
    <rect x="30" y="88" width="40" height="24" rx="8" fill="${fill('fessiersischios')}"/>
    <rect x="33" y="112" width="15" height="20" rx="6" fill="${fill('mollets')}"/>
    <rect x="52" y="112" width="15" height="20" rx="6" fill="${fill('mollets')}"/>
  </svg>`;
}

/* Icône circulaire "mannequin" pour le sélecteur de zone de la page Entraînement :
   silhouette du corps (face ou dos selon la zone) avec la zone ciblée en rouge. */
function zoneIconSVG(zoneKey){
  if(zoneKey === "cardio"){
    return `<svg viewBox="0 0 100 100" width="34" height="34">
      <path d="M20 46 L36 46 L44 30 L54 64 L62 46 L80 46" fill="none" stroke="var(--ember-bright)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M50 80 C24 60 12 42 12 28 C12 15 22 8 33 8 C42 8 50 15 50 24 C50 15 58 8 67 8 C78 8 88 15 88 28 C88 42 76 60 50 80 Z" fill="none" stroke="var(--iron-light)" stroke-width="5"/>
    </svg>`;
  }
  if(zoneKey === "mobility"){
    return `<svg viewBox="0 0 100 100" width="34" height="34">
      <circle cx="50" cy="50" r="34" fill="none" stroke="var(--iron-light)" stroke-width="6" stroke-dasharray="7 6"/>
      <path d="M50 16 A34 34 0 1 1 21 68" fill="none" stroke="var(--ember-bright)" stroke-width="6" stroke-linecap="round"/>
      <path d="M50 16 l11 -8 M50 16 l-4 -13" stroke="var(--ember-bright)" stroke-width="6" fill="none" stroke-linecap="round"/>
    </svg>`;
  }
  const zone = ZONE_EXERCISES[zoneKey];
  const isFront = !zone || zone.view === "front";
  const fill = (z) => z === zoneKey ? "var(--ember-bright)" : "var(--iron-light)";
  const body = "var(--iron)";

  if(isFront){
    return `<svg viewBox="0 0 100 150" width="42" height="63">
      <circle cx="50" cy="13" r="11" fill="${body}"/>
      <path d="M44,22 L56,22 L54,28 L46,28 Z" fill="${body}"/>
      <path d="M30,28 C30,26 34,25 38,25 L62,25 C66,25 70,26 70,28
               L73,46 C74,57 71,67 66,73
               L68,86 L32,86 L34,73
               C29,67 26,57 27,46 Z" fill="${body}"/>
      <path d="M14,36 Q11,33 13,29 L22,29 Q25,33 22,38 L20,58 L15,58 Z" fill="${fill('biceps')}"/>
      <path d="M78,38 Q75,33 78,29 L87,29 Q89,33 86,36 L85,58 L80,58 Z" fill="${fill('biceps')}"/>
      <circle cx="17" cy="33" r="8" fill="${fill('epaules')}"/>
      <circle cx="83" cy="33" r="8" fill="${fill('epaules')}"/>
      <path d="M15,60 L20,60 L19,82 Q19,86 16,86 Q13,86 13,82 Z" fill="${fill('avantbras')}"/>
      <path d="M80,60 L85,60 L84,82 Q84,86 81,86 Q78,86 78,82 Z" fill="${fill('avantbras')}"/>
      <circle cx="16" cy="89" r="4" fill="${body}"/>
      <circle cx="84" cy="89" r="4" fill="${body}"/>
      <path d="M36,31 Q50,27 64,31 L63,49 Q50,53 37,49 Z" fill="${fill('pecs')}"/>
      <path d="M38,52 L62,52 L60,80 Q50,84 40,80 Z" fill="${fill('abdos')}"/>
      <line x1="50" y1="52" x2="50" y2="80" stroke="${body}" stroke-width="1.6"/>
      <line x1="39" y1="61" x2="61" y2="61" stroke="${body}" stroke-width="1.6"/>
      <line x1="39.5" y1="70" x2="60.5" y2="70" stroke="${body}" stroke-width="1.6"/>
      <path d="M33,88 L48,88 L45,116 L35,116 Z" fill="${fill('quadriceps')}"/>
      <path d="M52,88 L67,88 L65,116 L55,116 Z" fill="${fill('quadriceps')}"/>
      <path d="M35,118 L45,118 L44,142 L37,142 Z" fill="${body}"/>
      <path d="M55,118 L65,118 L63,142 L56,142 Z" fill="${body}"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 100 150" width="42" height="63">
    <circle cx="50" cy="13" r="11" fill="${body}"/>
    <path d="M44,22 L56,22 L54,28 L46,28 Z" fill="${body}"/>
    <path d="M30,28 C30,26 34,25 38,25 L62,25 C66,25 70,26 70,28
             L73,46 C74,57 71,67 66,73
             L68,86 L32,86 L34,73
             C29,67 26,57 27,46 Z" fill="${body}"/>
    <path d="M14,36 Q11,33 13,29 L22,29 Q25,33 22,38 L20,58 L15,58 Z" fill="${fill('triceps')}"/>
    <path d="M78,38 Q75,33 78,29 L87,29 Q89,33 86,36 L85,58 L80,58 Z" fill="${fill('triceps')}"/>
    <circle cx="17" cy="33" r="8" fill="${fill('epaules')}"/>
    <circle cx="83" cy="33" r="8" fill="${fill('epaules')}"/>
    <path d="M15,60 L20,60 L19,82 Q19,86 16,86 Q13,86 13,82 Z" fill="${fill('avantbras')}"/>
    <path d="M80,60 L85,60 L84,82 Q84,86 81,86 Q78,86 78,82 Z" fill="${fill('avantbras')}"/>
    <circle cx="16" cy="89" r="4" fill="${body}"/>
    <circle cx="84" cy="89" r="4" fill="${body}"/>
    <path d="M35,29 L65,29 L70,49 Q50,59 30,49 Z" fill="${fill('dos')}"/>
    <path d="M31,88 Q50,82 69,88 L67,110 Q50,116 33,110 Z" fill="${fill('fessiersischios')}"/>
    <path d="M35,112 L47,112 L45,142 L37,142 Z" fill="${fill('mollets')}"/>
    <path d="M53,112 L65,112 L63,142 L55,142 Z" fill="${fill('mollets')}"/>
  </svg>`;
}

/* =========================================================
   CARTE DU CORPS — zones travaillées
   ========================================================= */

const ZONE_EXERCISES = {
  epaules:        { label: "Épaules",          view: "front", exos: ["Shoulder Press (développé épaules guidé)", "Élévations latérales (haltères)", "Développé Arnold (haltères)", "Face pull (poulie double)"] },
  pecs:           { label: "Pectoraux",        view: "front", exos: ["Chest Press (développé assis guidé)", "Développé incliné haltères (banc inclinable)", "Pec Fly / Écarté (pec deck)", "Développé serré à la Smith Machine"] },
  biceps:         { label: "Biceps",           view: "front", exos: ["Biceps Curl (machine pupitre)", "Curl marteau (haltères)", "Rowing unilatéral à la poulie basse"] },
  abdos:          { label: "Abdominaux",       view: "front", exos: ["Abdominal Crunch (machine guidée)", "Relevé de jambes suspendu ou au sol", "Gainage planche + Mountain climbers"] },
  quadriceps:     { label: "Quadriceps",       view: "front", exos: ["Squat (Cage à squat / Smith Machine)", "Leg Press (presse à cuisses)", "Fentes bulgares (banc + haltères)"] },
  dos:            { label: "Dos",              view: "back",  exos: ["Lat Pulldown (tirage vertical poulie haute)", "Seated Row (tirage horizontal assis)", "Tirage poulie basse prise serrée", "Superman (gainage dos)"] },
  triceps:        { label: "Triceps",          view: "back",  exos: ["Extension triceps à la poulie haute", "Développé serré à la Smith Machine", "Extension triceps nuque (haltère)"] },
  fessiersischios:{ label: "Fessiers & Ischios", view: "back", exos: ["Hip Thrust (Smith Machine ou barre)", "Leg Press (presse à cuisses)", "Seated Leg Curl (ischios, machine)", "Abduction de hanche (machine)"] },
  mollets:        { label: "Mollets",          view: "back",  exos: ["Mollets debout (machine ou Smith Machine)"] },
  avantbras:      { label: "Avant-bras",       view: "front", exos: ["Curl de poignet (haltères sur banc)", "Curl de poignet inversé (haltères sur banc)", "Enroulement de poignet à la poulie basse", "Portée lourde (Farmer's walk, haltères)"] },
};

const CATEGORY_ZONES = {
  push: ["epaules","pecs","triceps"],
  push2: ["epaules","pecs","triceps"],
  pull: ["dos","biceps"],
  pull2: ["dos","biceps"],
  legs: ["quadriceps","fessiersischios","mollets"],
  cardio: ["abdos"],
  mobility: []
};

function bodyMapSVG(){
  return `
  <svg viewBox="0 0 420 260" xmlns="http://www.w3.org/2000/svg" style="width:100%; max-width:420px; height:auto;">
    <!-- FRONT VIEW -->
    <g transform="translate(20,10)">
      <text x="45" y="0" font-family="JetBrains Mono" font-size="10" fill="var(--parchment-dim)">FACE</text>
      <circle cx="45" cy="20" r="14" fill="var(--iron-light)"/>
      <rect x="20" y="36" width="50" height="70" rx="14" fill="var(--iron)"/>
      <circle data-zone="epaules" cx="18" cy="45" r="11" fill="var(--iron-light)"/>
      <circle data-zone="epaules" cx="72" cy="45" r="11" fill="var(--iron-light)"/>
      <rect data-zone="pecs" x="27" y="42" width="36" height="24" rx="6" fill="var(--iron-light)"/>
      <rect data-zone="abdos" x="29" y="68" width="32" height="34" rx="6" fill="var(--iron-light)"/>
      <rect data-zone="biceps" x="8" y="50" width="11" height="34" rx="5" fill="var(--iron-light)"/>
      <rect data-zone="biceps" x="71" y="50" width="11" height="34" rx="5" fill="var(--iron-light)"/>
      <rect x="6" y="84" width="11" height="30" rx="5" fill="var(--iron)"/>
      <rect x="73" y="84" width="11" height="30" rx="5" fill="var(--iron)"/>
      <rect data-zone="quadriceps" x="24" y="108" width="18" height="46" rx="7" fill="var(--iron-light)"/>
      <rect data-zone="quadriceps" x="48" y="108" width="18" height="46" rx="7" fill="var(--iron-light)"/>
      <rect x="24" y="154" width="18" height="42" rx="7" fill="var(--iron)"/>
      <rect x="48" y="154" width="18" height="42" rx="7" fill="var(--iron)"/>
    </g>
    <!-- BACK VIEW -->
    <g transform="translate(220,10)">
      <text x="35" y="0" font-family="JetBrains Mono" font-size="10" fill="var(--parchment-dim)">DOS</text>
      <circle cx="45" cy="20" r="14" fill="var(--iron-light)"/>
      <rect x="20" y="36" width="50" height="70" rx="14" fill="var(--iron)"/>
      <rect data-zone="dos" x="27" y="42" width="36" height="50" rx="8" fill="var(--iron-light)"/>
      <rect data-zone="triceps" x="8" y="50" width="11" height="34" rx="5" fill="var(--iron-light)"/>
      <rect data-zone="triceps" x="71" y="50" width="11" height="34" rx="5" fill="var(--iron-light)"/>
      <rect x="6" y="84" width="11" height="30" rx="5" fill="var(--iron)"/>
      <rect x="73" y="84" width="11" height="30" rx="5" fill="var(--iron)"/>
      <rect data-zone="fessiersischios" x="24" y="108" width="42" height="30" rx="8" fill="var(--iron-light)"/>
      <rect data-zone="fessiersischios" x="24" y="138" width="42" height="16" rx="6" fill="var(--iron-light)" opacity="0.7"/>
      <rect data-zone="mollets" x="24" y="154" width="18" height="42" rx="7" fill="var(--iron-light)"/>
      <rect data-zone="mollets" x="48" y="154" width="18" height="42" rx="7" fill="var(--iron-light)"/>
    </g>
  </svg>`;
}

function highlightBodyZones(containerId, activeZones){
  const container = document.getElementById(containerId);
  if(!container) return;
  const nodes = container.querySelectorAll("[data-zone]");
  nodes.forEach(node => {
    const z = node.getAttribute("data-zone");
    if(activeZones.includes(z)){
      node.setAttribute("fill", "var(--ember-bright)");
    } else {
      node.setAttribute("fill", "var(--iron-light)");
    }
  });
}

function renderCategoryBodyMap(containerId, categoryKey){
  const container = document.getElementById(containerId);
  container.innerHTML = bodyMapSVG();
  highlightBodyZones(containerId, CATEGORY_ZONES[categoryKey] || []);
}

/* =========================================================
   AVATAR ÉVOLUTIF
   ========================================================= */

const AVATAR_STAGES = [
  { minLevel: 1,  label: "Victime",              accent: "#8a7d78" },
  { minLevel: 3,  label: "Survivante",            accent: "#a30000" },
  { minLevel: 6,  label: "Chasseuse de Frissons", accent: "#c41e2f" },
  { minLevel: 10, label: "Reine du Massacre",     accent: "#8b1a1a" },
  { minLevel: 15, label: "Ombre Sanglante",       accent: "#5c2b2b" },
  { minLevel: 20, label: "Légende du Slasher",    accent: "#c9a35d" },
];

function avatarStageIndex(level){
  let idx = 0;
  AVATAR_STAGES.forEach((s, i) => { if(level >= s.minLevel) idx = i; });
  return idx;
}

function buildAvatarSVG(level){
  const stage = avatarStageIndex(level);
  const shoulderW = 34 + stage * 2;
  const waistW = Math.max(18, 30 - stage * 2);
  const hipW = 30 + stage * 1.5;
  const accent = AVATAR_STAGES[stage].accent;
  const cx = 100, shoulderY = 96, waistY = 150, hipY = 160, footY = 250;

  let gear = "";

  // Étape 1 : petit ruban dans les cheveux
  if(stage >= 1){
    gear += `<path d="M ${cx+18} 30 l 10 -6 l -2 8 l 8 4 l -10 6 l 2 -8 z" fill="${accent}"/>`;
    gear += `<circle cx="${cx+18}" cy="34" r="3" fill="${accent}"/>`;
  }

  // Étape 2 : petites étincelles autour du personnage
  if(stage >= 2){
    const sparkle = (sx, sy, s) => `<path d="M ${sx} ${sy-s} L ${sx+s*0.3} ${sy-s*0.3} L ${sx+s} ${sy} L ${sx+s*0.3} ${sy+s*0.3} L ${sx} ${sy+s} L ${sx-s*0.3} ${sy+s*0.3} L ${sx-s} ${sy} L ${sx-s*0.3} ${sy-s*0.3} Z" fill="${accent}" opacity="0.9"/>`;
    gear += sparkle(cx - 55, shoulderY - 10, 7);
    gear += sparkle(cx + 60, shoulderY + 40, 5);
    gear += sparkle(cx - 45, hipY + 20, 5);
  }

  // Étape 3 : petites ailes de fée
  if(stage >= 3){
    gear += `<path d="M ${cx-shoulderW/2-6} ${shoulderY+10} Q ${cx-shoulderW/2-46} ${shoulderY-10} ${cx-shoulderW/2-40} ${shoulderY+34} Q ${cx-shoulderW/2-30} ${shoulderY+50} ${cx-shoulderW/2-6} ${shoulderY+30} Z" fill="${accent}" opacity="0.45"/>`;
    gear += `<path d="M ${cx+shoulderW/2+6} ${shoulderY+10} Q ${cx+shoulderW/2+46} ${shoulderY-10} ${cx+shoulderW/2+40} ${shoulderY+34} Q ${cx+shoulderW/2+30} ${shoulderY+50} ${cx+shoulderW/2+6} ${shoulderY+30} Z" fill="${accent}" opacity="0.45"/>`;
  }

  // Étape 4 : ailes plus grandes + petite tiare
  if(stage >= 4){
    gear += `<path d="M ${cx-shoulderW/2-10} ${shoulderY+6} Q ${cx-shoulderW/2-66} ${shoulderY-24} ${cx-shoulderW/2-56} ${shoulderY+40} Q ${cx-shoulderW/2-40} ${shoulderY+64} ${cx-shoulderW/2-10} ${shoulderY+34} Z" fill="${accent}" opacity="0.4"/>`;
    gear += `<path d="M ${cx+shoulderW/2+10} ${shoulderY+6} Q ${cx+shoulderW/2+66} ${shoulderY-24} ${cx+shoulderW/2+56} ${shoulderY+40} Q ${cx+shoulderW/2+40} ${shoulderY+64} ${cx+shoulderW/2+10} ${shoulderY+34} Z" fill="${accent}" opacity="0.4"/>`;
    gear += `<path d="M ${cx-14} 20 L ${cx-7} 6 L ${cx} 16 L ${cx+7} 6 L ${cx+14} 20 Z" fill="${accent}"/>`;
    gear += `<circle cx="${cx}" cy="14" r="2.4" fill="#fff5fb"/>`;
  }

  // Étape 5 : aura scintillante complète
  if(stage >= 5){
    gear += `<circle cx="${cx}" cy="${shoulderY-6}" r="92" fill="none" stroke="${accent}" stroke-width="1.5" opacity="0.4"/>`;
    gear += `<circle cx="${cx}" cy="${shoulderY-6}" r="78" fill="none" stroke="${accent}" stroke-width="1" opacity="0.25"/>`;
  }

  const waistLines = stage >= 3 ? `
    <line x1="${cx-10}" y1="${waistY-32}" x2="${cx-10}" y2="${waistY-4}" stroke="#00000025" stroke-width="1.5"/>
    <line x1="${cx+10}" y1="${waistY-32}" x2="${cx+10}" y2="${waistY-4}" stroke="#00000025" stroke-width="1.5"/>
  ` : "";

  return `
  <svg viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg" style="width:100%; max-width:220px; height:auto; display:block; margin:0 auto;">
    ${gear}
    <path d="M ${cx-16} 46 Q ${cx-30} 10 ${cx} 8 Q ${cx+30} 10 ${cx+16} 46 Q ${cx+22} 70 ${cx+10} 66 L ${cx+10} 40 Q ${cx} 34 ${cx-10} 40 L ${cx-10} 66 Q ${cx-22} 70 ${cx-16} 46 Z" fill="#6b4a3a"/>
    <circle cx="${cx}" cy="42" r="20" fill="#f3cba3"/>
    <ellipse cx="${cx+22}" cy="58" rx="6" ry="16" fill="#6b4a3a"/>
    <path d="M ${cx-shoulderW/2} ${shoulderY} Q ${cx-shoulderW/2-4} ${(shoulderY+waistY)/2} ${cx-waistW/2} ${waistY}
             Q ${cx-hipW/2} ${hipY+10} ${cx-hipW/2} ${hipY+30}
             L ${cx+hipW/2} ${hipY+30}
             Q ${cx+hipW/2} ${hipY+10} ${cx+waistW/2} ${waistY}
             Q ${cx+shoulderW/2+4} ${(shoulderY+waistY)/2} ${cx+shoulderW/2} ${shoulderY}
             Q ${cx} ${shoulderY-12} ${cx-shoulderW/2} ${shoulderY} Z" fill="${accent}" opacity="0.9"/>
    ${waistLines}
    <rect x="${cx-shoulderW/2-8}" y="${shoulderY+4}" width="8" height="46" rx="4" fill="#f3cba3"/>
    <rect x="${cx+shoulderW/2}" y="${shoulderY+4}" width="8" height="46" rx="4" fill="#f3cba3"/>
    <rect x="${cx-hipW/2+2}" y="${hipY+28}" width="${hipW*0.38}" height="58" rx="8" fill="#5a4468"/>
    <rect x="${cx+hipW/2-hipW*0.38-2}" y="${hipY+28}" width="${hipW*0.38}" height="58" rx="8" fill="#5a4468"/>
    <rect x="${cx-hipW/2+2}" y="${footY-10}" width="${hipW*0.38}" height="12" rx="4" fill="#3a2c40"/>
    <rect x="${cx+hipW/2-hipW*0.38-2}" y="${footY-10}" width="${hipW*0.38}" height="12" rx="4" fill="#3a2c40"/>
  </svg>`;
}

function renderAvatarWidget(elId){
  const el = document.getElementById(elId);
  const stage = avatarStageIndex(state.level);
  const info = AVATAR_STAGES[stage];
  const next = AVATAR_STAGES[stage+1];
  el.innerHTML = `
    <div style="text-align:center;">
      ${buildAvatarSVG(state.level)}
      <div style="font-family:var(--font-display); color:var(--gold-bright); margin-top:8px; font-size:16px;">${info.label}</div>
      <div style="font-family:var(--font-mono); color:var(--parchment-dim); font-size:11px; margin-top:4px;">
        ${next ? `Prochaine évolution au niveau ${next.minLevel} (${next.label})` : "Forme ultime atteinte"}
      </div>
    </div>
  `;
}

/* =========================================================
   ESTIMATION DE RYTHME — prochaine évolution
   ========================================================= */

function xpNeededFromLevelToLevel(fromLevel, fromXP, toLevel){
  let remaining = 0;
  let lvl = fromLevel;
  let carriedXP = fromXP;
  while(lvl < toLevel){
    remaining += (xpNeededFor(lvl) - carriedXP);
    carriedXP = 0;
    lvl++;
  }
  return Math.max(0, remaining);
}

function estimateNextStageWeeks(){
  const stage = avatarStageIndex(state.level);
  const next = AVATAR_STAGES[stage+1];
  if(!next) return { done: true };

  if(!state.firstLogDate || state.totalXPEarned <= 0){
    return { done:false, noData:true };
  }

  const weeksSinceStart = Math.max(1/7, daysBetween(new Date(state.firstLogDate), new Date()) / 7);
  const xpPerWeek = state.totalXPEarned / weeksSinceStart;
  if(xpPerWeek <= 0) return { done:false, noData:true };

  const xpRemaining = xpNeededFromLevelToLevel(state.level, state.xp, next.minLevel);
  const weeks = xpRemaining / xpPerWeek;
  return { done:false, noData:false, weeks: Math.max(0, Math.round(weeks)), nextLabel: next.label, nextLevel: next.minLevel };
}

function renderPaceEstimate(elId){
  const el = document.getElementById(elId);
  const est = estimateNextStageWeeks();
  if(est.done){
    el.textContent = "Forme ultime atteinte — la légende est écrite.";
    return;
  }
  if(est.noData){
    el.textContent = "Grave ta première quête pour que ton rythme soit mesuré.";
    return;
  }
  if(est.weeks === 0){
    el.textContent = `À ce rythme, ta prochaine évolution (${est.nextLabel}) arrive d'un jour à l'autre !`;
  } else {
    el.textContent = `À ce rythme, prochaine évolution (${est.nextLabel}, niveau ${est.nextLevel}) estimée dans ${est.weeks} semaine${est.weeks>1?"s":""}.`;
  }
}

/* =========================================================
   LIVRE DE RECETTES — un plat, une recette
   ========================================================= */

const RECIPES = {
  "Bol d'avoine au skyr et myrtilles": "Ingrédients (1 pers.) : 50g de flocons d'avoine, 150g de skyr, 60g de myrtilles, 10g d'amandes effilées, 1 pincée de cannelle\n\nPréparation :\n1. Cuire les flocons d'avoine dans un peu d'eau ou de lait 3-4 min, ou les laisser tremper une nuit.\n2. Une fois tièdes ou froids, incorporer le skyr.\n3. Ajouter les myrtilles, les amandes et une pincée de cannelle.",
  "Poulet rôti, riz complet, brocolis": "Ingrédients (1 pers.) : 150g de blanc de poulet, 60g de riz complet cru, 150g de brocolis, 1 c. à soupe d'huile d'olive, sel, poivre, paprika\n\nPréparation :\n1. Assaisonner le poulet et le rôtir au four 20-25 min à 200°C ou à la poêle 6-7 min par face.\n2. Cuire le riz complet selon les indications du paquet.\n3. Cuire les brocolis à la vapeur 8-10 min, arroser d'un filet d'huile d'olive.",
  "Omelette aux légumes et salade verte": "Ingrédients (1 pers.) : 3 œufs, 1/2 poivron, 50g de champignons, salade verte, 1 c. à café d'huile\n\nPréparation :\n1. Faire revenir le poivron et les champignons émincés 4-5 min.\n2. Battre les œufs, verser sur les légumes, cuire à feu doux 3-4 min.\n3. Servir avec la salade verte assaisonnée.",
  "Œufs brouillés et pain complet à l'avocat": "Ingrédients (1 pers.) : 2-3 œufs, 1 tranche de pain complet, 1/2 avocat, sel, poivre\n\nPréparation :\n1. Battre les œufs et les cuire à feu doux en remuant pour des œufs brouillés crémeux.\n2. Toaster le pain complet.\n3. Écraser l'avocat sur le pain, assaisonner et servir avec les œufs.",
  "Saumon, patate douce, épinards": "Ingrédients (1 pers.) : 150g de saumon, 200g de patate douce, 100g d'épinards frais, 1/2 citron, huile d'olive\n\nPréparation :\n1. Cuire la patate douce en dés au four 20 min à 200°C ou à la vapeur.\n2. Cuire le saumon à la poêle 3-4 min par face ou au four 12-15 min.\n3. Faire tomber les épinards 2-3 min à la poêle, arroser de citron.",
  "Filet de poulet grillé, haricots verts": "Ingrédients (1 pers.) : 150g de filet de poulet, 200g de haricots verts, 1 gousse d'ail, huile d'olive\n\nPréparation :\n1. Griller le poulet 5-6 min par face.\n2. Cuire les haricots verts à la vapeur 8-10 min.\n3. Faire revenir les haricots avec l'ail et un filet d'huile.",
  "Porridge protéiné banane-cacao": "Ingrédients (1 pers.) : 50g de flocons d'avoine, 200ml de lait, 1 banane, 1 c. à café de cacao non sucré\n\nPréparation :\n1. Chauffer le lait et les flocons d'avoine 4-5 min en remuant.\n2. Incorporer le cacao.\n3. Écraser la moitié de la banane dedans, trancher l'autre moitié en garniture.",
  "Bœuf haché maigre, quinoa, poivrons": "Ingrédients (1 pers.) : 150g de bœuf haché 5%, 60g de quinoa cru, 1 poivron, 1/2 oignon, huile d'olive\n\nPréparation :\n1. Cuire le quinoa dans deux fois son volume d'eau 12-15 min.\n2. Faire revenir l'oignon et le poivron 5 min.\n3. Ajouter le bœuf, cuire 6-7 min en émiettant, servir sur le quinoa.",
  "Poisson blanc vapeur, courgettes sautées": "Ingrédients (1 pers.) : 150g de poisson blanc, 1 courgette, 1 gousse d'ail, huile d'olive, citron\n\nPréparation :\n1. Cuire le poisson à la vapeur 10-12 min.\n2. Faire sauter la courgette en rondelles avec l'ail 6-7 min.\n3. Arroser le poisson de citron avant de servir.",
  "Omelette champignons et fromage frais": "Ingrédients (1 pers.) : 3 œufs, 80g de champignons, 30g de fromage frais léger, ciboulette\n\nPréparation :\n1. Faire revenir les champignons 5 min.\n2. Battre les œufs et verser dessus, cuire à feu doux.\n3. Ajouter le fromage frais en fin de cuisson, parsemer de ciboulette.",
  "Dinde, pâtes complètes, courgettes à l'ail": "Ingrédients (1 pers.) : 150g d'escalope de dinde, 70g de pâtes complètes crues, 1 courgette, 1 gousse d'ail\n\nPréparation :\n1. Cuire les pâtes complètes selon le paquet.\n2. Cuire la dinde 5-6 min par face.\n3. Faire revenir la courgette avec l'ail, mélanger le tout.",
  "Soupe de légumes maison et œufs durs": "Ingrédients (1 pers.) : légumes de saison au choix, 2 œufs\n\nPréparation :\n1. Éplucher et couper les légumes, cuire 20 min dans l'eau ou un bouillon.\n2. Mixer jusqu'à consistance lisse, assaisonner.\n3. Cuire les œufs 9-10 min à l'eau bouillante, écaler et servir à côté.",
  "Yaourt grec, granola, fruits rouges": "Ingrédients (1 pers.) : 150g de yaourt grec, 30g de granola, 60g de fruits rouges\n\nPréparation :\n1. Verser le yaourt grec dans un bol.\n2. Ajouter le granola juste avant de manger pour qu'il reste croustillant.\n3. Garnir de fruits rouges.",
  "Tofu mariné, riz basmati, brocolis-carottes": "Ingrédients (1 pers.) : 150g de tofu ferme, 60g de riz basmati cru, 100g de brocolis, 1 carotte, sauce soja\n\nPréparation :\n1. Couper le tofu en dés, le mariner 10 min dans la sauce soja.\n2. Cuire le riz basmati selon le paquet.\n3. Faire revenir le tofu, le brocolis et la carotte 8-10 min.",
  "Salade de thon, tomates, œufs, quinoa froid": "Ingrédients (1 pers.) : 1 boîte de thon au naturel, 2 tomates, 2 œufs durs, 60g de quinoa cuit, huile d'olive\n\nPréparation :\n1. Cuire le quinoa, le laisser refroidir.\n2. Cuire les œufs durs 9-10 min, écaler et couper en quartiers.\n3. Mélanger tous les ingrédients avec un filet d'huile d'olive.",
  "Pain complet, fromage blanc, œuf dur, concombre": "Ingrédients (1 pers.) : 1-2 tranches de pain complet, 100g de fromage blanc, 1 œuf dur, 1/2 concombre\n\nPréparation :\n1. Cuire l'œuf dur 9-10 min.\n2. Trancher le concombre.\n3. Assembler pain, fromage blanc, œuf et concombre.",
  "Cabillaud, semoule complète, ratatouille": "Ingrédients (1 pers.) : 150g de cabillaud, 60g de semoule complète crue, légumes pour ratatouille\n\nPréparation :\n1. Mijoter les légumes en dés avec un filet d'huile 20-25 min.\n2. Cuire le cabillaud à la vapeur ou à la poêle 8-10 min.\n3. Faire gonfler la semoule dans l'eau bouillante hors du feu 5 min, servir ensemble.",
  "Escalope de dinde, épinards à l'ail": "Ingrédients (1 pers.) : 150g d'escalope de dinde, 150g d'épinards frais, 1 gousse d'ail, huile d'olive\n\nPréparation :\n1. Cuire l'escalope 5-6 min par face.\n2. Faire tomber les épinards avec l'ail 2-3 min.\n3. Servir ensemble avec un filet d'huile.",
  "Pancakes protéinés à la banane": "Ingrédients (1 pers.) : 2 œufs, 1 banane, 40g de flocons d'avoine, cannelle\n\nPréparation :\n1. Mixer ou écraser tous les ingrédients ensemble.\n2. Cuire des petites louches de pâte à la poêle 2-3 min par face.\n3. Servir tièdes.",
  "Lentilles, légumes rôtis, œuf poché": "Ingrédients (1 pers.) : 70g de lentilles crues, légumes de saison, 1 œuf\n\nPréparation :\n1. Cuire les lentilles 20-25 min dans l'eau non salée.\n2. Faire rôtir les légumes au four 20 min à 200°C avec un filet d'huile.\n3. Pocher l'œuf 3 min dans une eau frémissante vinaigrée, servir sur les lentilles.",
  "Tofu sauté, légumes wok, sauce soja légère": "Ingrédients (1 pers.) : 150g de tofu ferme, poivron, carotte, sauce soja\n\nPréparation :\n1. Couper le tofu en cubes, le dorer à la poêle 5-6 min.\n2. Ajouter les légumes émincés, sauter à feu vif 5-6 min.\n3. Assaisonner de sauce soja en fin de cuisson.",
  "Smoothie protéiné banane-avoine": "Ingrédients (1 pers.) : 1 banane, 200ml de lait, 30g de flocons d'avoine, 1 c. à soupe de beurre de cacahuète\n\nPréparation :\n1. Mettre tous les ingrédients dans un blender.\n2. Mixer jusqu'à texture lisse.\n3. Ajouter de l'eau ou des glaçons si trop épais.",
  "Crevettes sautées, riz complet, légumes croquants": "Ingrédients (1 pers.) : 150g de crevettes décortiquées, 60g de riz complet cru, poivron, carotte\n\nPréparation :\n1. Cuire le riz complet selon le paquet.\n2. Faire sauter les légumes à feu vif 4-5 min pour qu'ils restent croquants.\n3. Ajouter les crevettes en fin de cuisson, 2-3 min suffisent.",
  "Salade de poulet, avocat, tomates": "Ingrédients (1 pers.) : 150g de blanc de poulet cuit, 1/2 avocat, 2 tomates, salade verte, huile d'olive\n\nPréparation :\n1. Cuire ou réchauffer le poulet, le trancher.\n2. Couper l'avocat et les tomates.\n3. Mélanger sur un lit de salade, assaisonner d'huile d'olive.",
  "Œufs pochés, avocat, pain complet": "Ingrédients (1 pers.) : 2 œufs, 1/2 avocat, 1-2 tranches de pain complet\n\nPréparation :\n1. Pocher les œufs 3 min dans une eau frémissante vinaigrée.\n2. Toaster le pain, écraser l'avocat dessus.\n3. Déposer les œufs pochés sur l'avocat.",
  "Poulet au curry léger, riz basmati, épinards": "Ingrédients (1 pers.) : 150g de poulet, 1 c. à café de curry, 60g de riz basmati cru, 100g d'épinards\n\nPréparation :\n1. Faire revenir le poulet avec le curry 8-10 min.\n2. Cuire le riz basmati selon le paquet.\n3. Ajouter les épinards en fin de cuisson.",
  "Soupe miso, tofu, légumes": "Ingrédients (1 pers.) : 1 c. à soupe de pâte miso, 100g de tofu, champignons, carotte\n\nPréparation :\n1. Chauffer de l'eau sans bouillir fort, y diluer le miso.\n2. Ajouter le tofu en dés et les légumes émincés.\n3. Laisser mijoter doucement 5 min sans bouillir.",
  "Skyr, flocons d'avoine, pomme, cannelle": "Ingrédients (1 pers.) : 150g de skyr, 30g de flocons d'avoine, 1 pomme, cannelle\n\nPréparation :\n1. Mélanger le skyr et les flocons d'avoine.\n2. Couper la pomme en dés.\n3. Ajouter à la préparation, saupoudrer de cannelle.",
  "Steak haché 5%, pâtes complètes, salade": "Ingrédients (1 pers.) : 150g de steak haché 5%, 70g de pâtes complètes crues, salade verte\n\nPréparation :\n1. Cuire les pâtes complètes selon le paquet.\n2. Cuire le steak 3-4 min par face selon la cuisson désirée.\n3. Servir avec une salade assaisonnée.",
  "Cabillaud au citron, courgettes": "Ingrédients (1 pers.) : 150g de cabillaud, 1 courgette, 1/2 citron, huile d'olive\n\nPréparation :\n1. Couper la courgette en rondelles, la cuire à la poêle 8-10 min.\n2. Cuire le cabillaud à la poêle ou au four 10-12 min.\n3. Arroser de citron avant de servir.",
  "Omelette au saumon fumé et fromage frais": "Ingrédients (1 pers.) : 3 œufs, 50g de saumon fumé, 30g de fromage frais léger\n\nPréparation :\n1. Battre les œufs, cuire à feu doux.\n2. Ajouter le saumon et le fromage frais avant que l'omelette ne soit prise.\n3. Plier et servir.",
  "Maquereau, pommes de terre vapeur, haricots verts": "Ingrédients (1 pers.) : 1 boîte ou filet de maquereau, 200g de pommes de terre, 150g de haricots verts\n\nPréparation :\n1. Cuire les pommes de terre à la vapeur 20 min.\n2. Cuire les haricots verts à la vapeur 8-10 min.\n3. Servir avec le maquereau égoutté.",
  "Œufs brouillés, épinards, champignons": "Ingrédients (1 pers.) : 3 œufs, 100g d'épinards, 80g de champignons\n\nPréparation :\n1. Faire revenir les champignons puis les épinards 5 min.\n2. Battre les œufs et les verser dessus.\n3. Cuire à feu doux en remuant pour des œufs brouillés crémeux.",
  "Porridge quinoa, lait, fruits secs": "Ingrédients (1 pers.) : 50g de quinoa, 200ml de lait, amandes ou noix\n\nPréparation :\n1. Rincer le quinoa, le cuire dans le lait 15 min à feu doux.\n2. Laisser légèrement épaissir.\n3. Garnir de fruits secs concassés.",
  "Pois chiches, riz, légumes rôtis (repas végé)": "Ingrédients (1 pers.) : 150g de pois chiches cuits, 60g de riz cru, légumes de saison\n\nPréparation :\n1. Cuire le riz selon le paquet.\n2. Faire rôtir les légumes au four 20 min à 200°C.\n3. Réchauffer les pois chiches et assembler avec un filet d'huile.",
  "Salade de lentilles, feta légère, concombre": "Ingrédients (1 pers.) : 100g de lentilles cuites, 40g de feta légère, 1/2 concombre, huile d'olive\n\nPréparation :\n1. Couper le concombre en dés, émietter la feta.\n2. Mélanger avec les lentilles.\n3. Assaisonner d'huile d'olive et de poivre.",
  "Pain complet, houmous, œuf dur, tomates": "Ingrédients (1 pers.) : 1-2 tranches de pain complet, 40g de houmous, 1 œuf dur, tomates cerises\n\nPréparation :\n1. Cuire l'œuf dur 9-10 min.\n2. Tartiner le pain de houmous.\n3. Ajouter l'œuf tranché et les tomates.",
  "Dinde, boulgour, poivrons grillés": "Ingrédients (1 pers.) : 150g de dinde, 60g de boulgour cru, 1 poivron\n\nPréparation :\n1. Cuire le boulgour dans l'eau bouillante hors du feu 10-12 min.\n2. Griller le poivron puis l'émincer.\n3. Cuire la dinde 5-6 min par face et servir ensemble.",
  "Blanc de poulet grillé, ratatouille": "Ingrédients (1 pers.) : 150g de blanc de poulet, légumes pour ratatouille\n\nPréparation :\n1. Mijoter les légumes en dés avec un filet d'huile 20-25 min.\n2. Griller le poulet 5-6 min par face.\n3. Servir accompagné de la ratatouille.",
  "Yaourt grec, muesli, kiwi": "Ingrédients (1 pers.) : 150g de yaourt grec, 30g de muesli, 1 kiwi\n\nPréparation :\n1. Verser le yaourt grec dans un bol.\n2. Couper le kiwi en tranches.\n3. Ajouter le muesli et le kiwi juste avant de servir.",
  "Truite, quinoa, brocolis": "Ingrédients (1 pers.) : 150g de filet de truite, 60g de quinoa cru, 150g de brocolis\n\nPréparation :\n1. Cuire le quinoa dans deux fois son volume d'eau 12-15 min.\n2. Cuire la truite au four ou à la poêle 10-12 min.\n3. Cuire les brocolis à la vapeur et servir ensemble.",
  "Poisson blanc, salade verte, vinaigrette légère": "Ingrédients (1 pers.) : 150g de poisson blanc, salade verte, huile d'olive, citron\n\nPréparation :\n1. Cuire le poisson à la vapeur ou à la poêle 8-10 min.\n2. Préparer une vinaigrette avec huile d'olive et citron.\n3. Servir le poisson sur la salade assaisonnée.",
  "Œufs, bacon de dinde grillé, tomates": "Ingrédients (1 pers.) : 2-3 œufs, 2 tranches de bacon de dinde, tomates cerises\n\nPréparation :\n1. Griller le bacon de dinde sans matière grasse 3-4 min.\n2. Cuire les œufs au plat ou brouillés dans la même poêle.\n3. Servir avec les tomates cerises.",
  "Bœuf sauté, riz complet, brocolis": "Ingrédients (1 pers.) : 150g de bœuf en lanières, 60g de riz complet cru, 150g de brocolis\n\nPréparation :\n1. Cuire le riz complet selon le paquet.\n2. Cuire les brocolis à la vapeur 8-10 min.\n3. Faire sauter le bœuf à feu vif 3-4 min et servir ensemble.",
  "Salade César allégée (poulet, salade, parmesan léger)": "Ingrédients (1 pers.) : 150g de blanc de poulet, salade verte, 10g de parmesan, yaourt nature pour la sauce\n\nPréparation :\n1. Cuire le poulet 5-6 min par face, le trancher.\n2. Préparer une sauce légère au yaourt, citron et moutarde.\n3. Assembler la salade avec le poulet, la sauce et le parmesan.",
  "Porridge avoine, banane, noix": "Ingrédients (1 pers.) : 50g de flocons d'avoine, 200ml de lait, 1 banane, quelques noix\n\nPréparation :\n1. Chauffer le lait et les flocons d'avoine 4-5 min.\n2. Trancher la banane.\n3. Garnir le porridge de banane et de noix concassées.",
  "Poulet grillé, patate douce, salade": "Ingrédients (1 pers.) : 150g de blanc de poulet, 200g de patate douce, salade verte\n\nPréparation :\n1. Couper la patate douce en frites ou en dés, cuire au four 20-25 min à 200°C.\n2. Griller le poulet 5-6 min par face.\n3. Servir avec une salade verte.",
  "Soupe de légumes maison et œuf": "Ingrédients (1 pers.) : légumes de saison, 1 œuf\n\nPréparation :\n1. Éplucher et couper les légumes, cuire 20 min dans l'eau ou un bouillon.\n2. Mixer jusqu'à consistance lisse.\n3. Servir avec un œuf dur ou poché.",
  "Skyr, granola, fruits rouges": "Ingrédients (1 pers.) : 150g de skyr, 30g de granola, fruits rouges\n\nPréparation :\n1. Verser le skyr dans un bol.\n2. Ajouter le granola juste avant de servir.\n3. Garnir de fruits rouges.",
  "Chili con carne maison (bœuf, haricots rouges, riz)": "Ingrédients (1 pers.) : 150g de bœuf haché, 100g de haricots rouges cuits, 60g de riz cru, tomates, cumin, paprika\n\nPréparation :\n1. Faire revenir le bœuf avec les épices 5-6 min.\n2. Ajouter les tomates et les haricots rouges, mijoter 15-20 min.\n3. Cuire le riz à part et servir le chili dessus.",
  "Poisson blanc, épinards": "Ingrédients (1 pers.) : 150g de poisson blanc, 150g d'épinards, huile d'olive\n\nPréparation :\n1. Cuire le poisson à la vapeur ou à la poêle 8-10 min.\n2. Faire tomber les épinards 2-3 min.\n3. Servir ensemble avec un filet d'huile.",
  "Omelette épinards et feta légère": "Ingrédients (1 pers.) : 3 œufs, 100g d'épinards, 30g de feta légère\n\nPréparation :\n1. Faire tomber les épinards 2-3 min.\n2. Battre les œufs et verser dessus.\n3. Ajouter la feta et cuire à feu doux jusqu'à ce que l'omelette soit prise.",
  "Saumon, quinoa, asperges": "Ingrédients (1 pers.) : 150g de saumon, 60g de quinoa cru, asperges\n\nPréparation :\n1. Cuire le quinoa dans deux fois son volume d'eau 12-15 min.\n2. Cuire les asperges à la vapeur 8-10 min.\n3. Cuire le saumon 10-12 min et servir ensemble.",
  "Tofu grillé, légumes sautés": "Ingrédients (1 pers.) : 150g de tofu ferme, poivron, courgette\n\nPréparation :\n1. Couper le tofu en tranches, le griller 4-5 min par face.\n2. Faire sauter les légumes à feu vif 5-6 min.\n3. Servir ensemble.",
  "Pain complet, beurre de cacahuète, banane": "Ingrédients (1 pers.) : 1-2 tranches de pain complet, 1 c. à soupe de beurre de cacahuète, 1 banane\n\nPréparation :\n1. Toaster le pain.\n2. Tartiner de beurre de cacahuète.\n3. Ajouter des rondelles de banane.",
  "Pois chiches épicés, riz, légumes": "Ingrédients (1 pers.) : 150g de pois chiches cuits, 60g de riz cru, légumes de saison, cumin, paprika\n\nPréparation :\n1. Cuire le riz selon le paquet.\n2. Faire revenir les pois chiches avec les épices 5-6 min.\n3. Ajouter les légumes émincés, poursuivre 5 min.",
  "Salade thon, œufs, tomates": "Ingrédients (1 pers.) : 1 boîte de thon, 2 œufs durs, tomates, huile d'olive\n\nPréparation :\n1. Cuire les œufs durs 9-10 min, les couper en quartiers.\n2. Égoutter le thon.\n3. Mélanger tous les ingrédients avec un filet d'huile.",
  "Yaourt grec, flocons d'avoine, pomme, cannelle": "Ingrédients (1 pers.) : 150g de yaourt grec, 30g de flocons d'avoine, 1 pomme, cannelle\n\nPréparation :\n1. Mélanger le yaourt grec et les flocons d'avoine.\n2. Couper la pomme en dés.\n3. Ajouter à la préparation, saupoudrer de cannelle.",
  "Dinde, pâtes complètes, sauce tomate maison": "Ingrédients (1 pers.) : 150g de dinde, 70g de pâtes complètes crues, tomates, ail\n\nPréparation :\n1. Cuire les pâtes selon le paquet.\n2. Faire revenir la dinde avec l'ail 6-7 min.\n3. Ajouter les tomates concassées, mijoter 10 min et servir sur les pâtes.",
  "Blanc de poulet, courgettes grillées": "Ingrédients (1 pers.) : 150g de blanc de poulet, 1-2 courgettes\n\nPréparation :\n1. Couper les courgettes en tranches, les griller 8-10 min.\n2. Griller le poulet 5-6 min par face.\n3. Servir ensemble.",
  "Smoothie bowl protéiné (yaourt, fruits, graines)": "Ingrédients (1 pers.) : 150g de yaourt grec, fruits rouges, 1 c. à soupe de graines (chia/lin)\n\nPréparation :\n1. Mixer une partie du yaourt avec des fruits pour une base crémeuse.\n2. Verser dans un bol.\n3. Garnir de fruits frais et de graines.",
  "Filet mignon de porc, purée de patate douce, haricots verts": "Ingrédients (1 pers.) : 150g de filet mignon de porc, 200g de patate douce, 150g de haricots verts\n\nPréparation :\n1. Cuire la patate douce puis l'écraser en purée.\n2. Cuire le filet mignon 4-5 min par face puis 10 min au four à 180°C si épais.\n3. Cuire les haricots verts à la vapeur et servir ensemble.",
  "Omelette légumes, salade verte": "Ingrédients (1 pers.) : 3 œufs, poivron, carotte, salade verte\n\nPréparation :\n1. Faire revenir les légumes émincés 5 min.\n2. Battre les œufs et verser dessus, cuire à feu doux.\n3. Servir avec une salade verte.",
  "Œufs au plat, pain complet, tomates poêlées": "Ingrédients (1 pers.) : 2-3 œufs, 1-2 tranches de pain complet, tomates cerises\n\nPréparation :\n1. Poêler les tomates cerises coupées en deux 3-4 min.\n2. Cuire les œufs au plat.\n3. Servir avec le pain complet toasté.",
  "Poulet, boulgour, courgettes": "Ingrédients (1 pers.) : 150g de poulet, 60g de boulgour cru, 1 courgette\n\nPréparation :\n1. Cuire le boulgour dans l'eau bouillante hors du feu 10-12 min.\n2. Griller le poulet 5-6 min par face.\n3. Faire sauter la courgette et servir ensemble.",
  "Salade de pois chiches, thon, tomates": "Ingrédients (1 pers.) : 150g de pois chiches cuits, 1 boîte de thon, tomates, huile d'olive\n\nPréparation :\n1. Égoutter le thon et les pois chiches.\n2. Couper les tomates.\n3. Mélanger le tout avec un filet d'huile.",
  "Bowl skyr, noix, miel": "Ingrédients (1 pers.) : 150g de skyr, quelques noix, 1 c. à café de miel\n\nPréparation :\n1. Verser le skyr dans un bol.\n2. Concasser les noix par-dessus.\n3. Ajouter un filet de miel.",
  "Thon, riz complet, poivrons": "Ingrédients (1 pers.) : 1 boîte de thon, 60g de riz complet cru, 1 poivron\n\nPréparation :\n1. Cuire le riz complet selon le paquet.\n2. Faire sauter le poivron 5-6 min.\n3. Ajouter le thon égoutté et mélanger.",
  "Omelette au fromage frais et ciboulette": "Ingrédients (1 pers.) : 3 œufs, 30g de fromage frais léger, ciboulette\n\nPréparation :\n1. Battre les œufs, cuire à feu doux.\n2. Ajouter le fromage frais avant que l'omelette ne soit prise.\n3. Parsemer de ciboulette avant de servir.",
  "Porridge avoine, pomme, cannelle": "Ingrédients (1 pers.) : 50g de flocons d'avoine, 200ml de lait, 1 pomme, cannelle\n\nPréparation :\n1. Chauffer le lait et les flocons d'avoine 4-5 min.\n2. Couper la pomme en dés.\n3. Ajouter la pomme et la cannelle en fin de cuisson.",
  "Bœuf haché, patate douce, haricots verts": "Ingrédients (1 pers.) : 150g de bœuf haché 5%, 200g de patate douce, 150g de haricots verts\n\nPréparation :\n1. Cuire la patate douce en dés au four 20 min à 200°C.\n2. Cuire les haricots verts à la vapeur 8-10 min.\n3. Cuire le bœuf haché 6-7 min et servir ensemble.",
  "Filet de poulet, haricots verts": "Ingrédients (1 pers.) : 150g de filet de poulet, 200g de haricots verts\n\nPréparation :\n1. Cuire les haricots verts à la vapeur 8-10 min.\n2. Griller le poulet 5-6 min par face.\n3. Servir ensemble avec un filet d'huile.",
  "Omelette jambon de dinde et fromage frais": "Ingrédients (1 pers.) : 3 œufs, 2 tranches de bacon/jambon de dinde, 30g de fromage frais léger\n\nPréparation :\n1. Faire revenir le bacon de dinde en lanières 2-3 min.\n2. Battre les œufs et verser dessus, cuire à feu doux.\n3. Ajouter le fromage frais avant que l'omelette ne soit prise.",
  "Tofu, quinoa, épinards": "Ingrédients (1 pers.) : 150g de tofu, 60g de quinoa cru, 100g d'épinards\n\nPréparation :\n1. Cuire le quinoa dans deux fois son volume d'eau 12-15 min.\n2. Faire dorer le tofu en dés 6-7 min.\n3. Ajouter les épinards en fin de cuisson, servir avec le quinoa.",
  "Soupe miso, tofu": "Ingrédients (1 pers.) : 1 c. à soupe de pâte miso, 100g de tofu\n\nPréparation :\n1. Chauffer de l'eau sans bouillir fort.\n2. Diluer la pâte miso dedans.\n3. Ajouter le tofu en dés, réchauffer doucement 3-4 min.",
  "Smoothie vert protéiné": "Ingrédients (1 pers.) : poignée d'épinards, 1 banane, 200ml de lait ou whey\n\nPréparation :\n1. Mettre tous les ingrédients dans un blender.\n2. Mixer jusqu'à texture bien lisse.\n3. Ajouter de l'eau si trop épais.",
  "Crevettes, riz basmati, brocolis": "Ingrédients (1 pers.) : 150g de crevettes, 60g de riz basmati cru, 150g de brocolis\n\nPréparation :\n1. Cuire le riz basmati selon le paquet.\n2. Cuire les brocolis à la vapeur 8-10 min.\n3. Faire sauter les crevettes 2-3 min et servir ensemble.",
  "Truite, épinards": "Ingrédients (1 pers.) : 150g de filet de truite, 150g d'épinards\n\nPréparation :\n1. Cuire la truite à la poêle ou au four 10-12 min.\n2. Faire tomber les épinards 2-3 min.\n3. Servir ensemble.",
  "Pain complet, avocat, œuf poché": "Ingrédients (1 pers.) : 1-2 tranches de pain complet, 1/2 avocat, 1-2 œufs\n\nPréparation :\n1. Toaster le pain, écraser l'avocat dessus.\n2. Pocher les œufs 3 min dans une eau frémissante vinaigrée.\n3. Déposer les œufs sur l'avocat.",
  "Dinde, lentilles, carottes": "Ingrédients (1 pers.) : 150g de dinde, 70g de lentilles crues, carottes\n\nPréparation :\n1. Cuire les lentilles 20-25 min dans l'eau non salée.\n2. Cuire la dinde 5-6 min par face.\n3. Cuire les carottes à la vapeur et servir ensemble.",
  "Salade César légère, dinde": "Ingrédients (1 pers.) : 150g de dinde, salade verte, 10g de parmesan léger\n\nPréparation :\n1. Cuire la dinde 5-6 min par face, la trancher.\n2. Préparer une sauce légère au yaourt, citron et moutarde.\n3. Assembler la salade avec la dinde, la sauce et le parmesan.",
  "Yaourt grec, fruits rouges, granola": "Ingrédients (1 pers.) : 150g de yaourt grec, fruits rouges, 30g de granola\n\nPréparation :\n1. Verser le yaourt grec dans un bol.\n2. Ajouter les fruits rouges.\n3. Garnir de granola juste avant de servir.",
  "Saumon, semoule complète, courgettes": "Ingrédients (1 pers.) : 150g de saumon, 60g de semoule complète crue, 1 courgette\n\nPréparation :\n1. Faire gonfler la semoule dans l'eau bouillante hors du feu 5 min.\n2. Cuire le saumon 10-12 min.\n3. Faire sauter la courgette et servir ensemble.",
  "Cabillaud, courgettes vapeur": "Ingrédients (1 pers.) : 150g de cabillaud, 1-2 courgettes\n\nPréparation :\n1. Cuire les courgettes à la vapeur 10-12 min.\n2. Cuire le cabillaud à la vapeur ou à la poêle 8-10 min.\n3. Servir ensemble avec un filet d'huile.",
};

function generateRecipesText(weekIndex){
  const week = WEEKLY_MENUS[weekIndex];
  let out = `RECETTES — ${week.name}\n`;
  out += `Quantités données pour 1 personne — multiplie selon le nombre de convives.\n\n`;
  week.days.forEach(d => {
    ["breakfast","lunch","dinner"].forEach(slot => {
      const meal = d[slot];
      const slotLabel = slot === "breakfast" ? "Petit-déjeuner" : slot === "lunch" ? "Déjeuner" : "Dîner";
      out += `=== ${d.day} — ${slotLabel} : ${meal.name} ===\n`;
      out += (RECIPES[meal.name] || "Recette non disponible.") + "\n\n";
    });
  });
  out += `— Scream Gym —\n`;
  return out;
}
