/* =========================================================
   CONFIGURATION FIREBASE — connexion Google + synchronisation
   =========================================================

   Sans cette configuration, Scream Gym fonctionne quand même,
   mais uniquement en local sur cet appareil/navigateur (IndexedDB).

   Pour activer la connexion automatique et la synchronisation entre
   appareils (5-10 minutes, gratuit, aucune carte bancaire requise) :

   1. Va sur https://console.firebase.google.com
   2. Clique "Ajouter un projet", donne-lui un nom (ex: "academie-etoile"),
      tu peux désactiver Google Analytics (pas nécessaire).
   3. Dans le menu de gauche : "Compilation" > "Firestore Database"
      > "Créer une base de données" > choisis "Mode test" pour commencer.
   4. Toujours dans le menu de gauche : "Compilation" > "Authentication"
      > "Get started" > onglet "Sign-in method" > active le fournisseur
      "Google" (choisis un email de support, puis "Enregistrer").

      Pour ajouter AUSSI la connexion Microsoft (optionnel) :
      a. Dans le même onglet "Sign-in method", active le fournisseur
         "Microsoft".
      b. Va sur https://portal.azure.com > "Microsoft Entra ID" >
         "Inscriptions d'applications" > "Nouvelle inscription".
      c. Donne un nom à l'app, choisis "Comptes dans n'importe quel
         annuaire organisationnel et comptes Microsoft personnels".
      d. Dans "URI de redirection" (type Web), colle l'URL de redirection
         que Firebase t'a donnée dans l'écran "Microsoft" (ressemble à
         https://TON-PROJET.firebaseapp.com/__/auth/handler).
      e. Une fois l'app créée : copie l'"ID d'application (client)"
         affiché sur la page de présentation → colle-le dans le champ
         "ID client" côté Firebase.
      f. Dans Azure : "Certificats et secrets" > "Nouveau secret client"
         > copie la VALEUR du secret (visible une seule fois) → colle-la
         dans le champ "Secret client" côté Firebase, puis "Enregistrer".
   5. Dans "Authentication" > "Settings" > "Authorized domains" : ajoute
      le domaine où le site est déployé (ex: tonpseudo.github.io) —
      SANS cette étape, la connexion Google échouera sur ton site en ligne.
   6. Icône ⚙️ (roue crantée) > "Paramètres du projet" > onglet "Général",
      tout en bas section "Vos applications" : clique l'icône Web "</>",
      donne un surnom à l'app (pas besoin de Firebase Hosting).
   7. Firebase t'affiche un bloc "firebaseConfig = { ... }" :
      copie-colle-le ci-dessous à la place de l'objet firebaseConfig actuel.

   ---------------------------------------------------------
   RÈGLES FIRESTORE (à coller dans l'onglet "Règles" de Firestore) :

   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /etoile_characters/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
       match /sharedCoins/{doc} {
         allow read, write: if true;
       }
     }
   }

   Avec la connexion Google, la sauvegarde de personnage (etoile_characters/{uid})
   est réellement sécurisée : seule la personne connectée avec son propre
   compte Google peut lire ou modifier sa propre sauvegarde.

   La collection "sharedCoins" (le compteur de pièces communes utilisé par
   "Le Trésor Commun") est volontairement ouverte en lecture ET écriture :
   c'est un simple compteur de points sans données sensibles, partagé entre
   les deux jeux et le site de récompenses, et ça évite d'avoir à gérer une
   authentification croisée entre trois projets Firebase différents pour
   un outil à usage strictement personnel. Si tu veux la restreindre plus
   tard, ajoute une App Check ou un mot de passe partagé dans les règles.
   ========================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyADeNeq0ol97SHlhUYmmZKRUkHWyoasihA",
  authDomain: "kawaiiprogram-1d64b.firebaseapp.com",
  projectId: "kawaiiprogram-1d64b",
  storageBucket: "kawaiiprogram-1d64b.firebasestorage.app",
  messagingSenderId: "883067258083",
  appId: "1:883067258083:web:b9b37a4ef0afcd6e7af1d6"
};


let db;
try{
  if(typeof firebase !== "undefined" && firebaseConfig.apiKey && firebaseConfig.apiKey !== "COLLE_TA_CLE_ICI"){
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    // La persistance de session est activée par défaut par Firebase Auth :
    // une fois connecté sur un appareil, la session reste ouverte toute
    // seule tant que la personne ne se déconnecte pas explicitement.
  }
}catch(e){
  console.warn("Firebase non configuré ou invalide — Scream Gym fonctionne en local uniquement.", e);
}
