/* =========================================================
   CONFIGURATION FIREBASE — connexion Google + synchronisation
   =========================================================

   Sans cette configuration, la Académie Étoile fonctionne quand même,
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
     }
   }

   Avec la connexion Google, ces règles sont réellement sécurisées :
   seule la personne connectée avec son propre compte Google peut lire
   ou modifier sa propre sauvegarde. Personne d'autre n'y a accès.
   ========================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyAPyWeZNsqKjguEDqUsrsqGv0ow9LXVsIE",
  authDomain: "vikingprogram-7e9fb.firebaseapp.com",
  projectId: "vikingprogram-7e9fb",
  storageBucket: "vikingprogram-7e9fb.firebasestorage.app",
  messagingSenderId: "227578269615",
  appId: "1:227578269615:web:0f9ac4a0a5ebfe4800695a"
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
  console.warn("Firebase non configuré ou invalide — la Académie Étoile fonctionne en local uniquement.", e);
}
